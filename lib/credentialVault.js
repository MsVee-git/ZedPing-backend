const crypto = require('crypto')

const ALGORITHM = 'aes-256-gcm'
const KEY_NAME = 'CREDENTIAL_VAULT_MASTER_KEY'
const VERSION_NAME = 'CREDENTIAL_VAULT_KEY_VERSION'
const ID = /^[a-z][a-z0-9_]{0,63}$/

class CredentialVaultError extends Error {
  constructor(message) { super(message); this.name = 'CredentialVaultError' }
}

function decodeKey(value) {
  let key
  try { key = Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64') } catch (_) { throw new CredentialVaultError('Credential vault key is invalid') }
  if (key.length !== 32) throw new CredentialVaultError('Credential vault key is invalid')
  return key
}

function keyConfig(env = process.env, requestedVersion = null) {
  const encoded = String(env[KEY_NAME] || '').trim()
  const version = Number.parseInt(String(env[VERSION_NAME] || '1'), 10)
  if (!encoded) throw new CredentialVaultError('Credential vault is not configured')
  if (!Number.isInteger(version) || version < 1 || version > 65535) throw new CredentialVaultError('Credential vault key version is invalid')
  const target = requestedVersion == null ? version : Number(requestedVersion)
  if (!Number.isInteger(target) || target < 1) throw new CredentialVaultError('Credential vault key version is invalid')
  let key = target === version ? decodeKey(encoded) : null
  if (!key && env.CREDENTIAL_VAULT_PREVIOUS_MASTER_KEYS) {
    try { key = decodeKey(JSON.parse(env.CREDENTIAL_VAULT_PREVIOUS_MASTER_KEYS)[String(target)]) } catch (_) { throw new CredentialVaultError('Credential vault key is invalid') }
  }
  if (!key) throw new CredentialVaultError('Credential vault key version is unavailable')
  return { key, version: target }
}

function identity({ customerId, integration, credentialKey, keyVersion }) {
  if (typeof customerId !== 'string' || !/^[0-9a-f-]{36}$/i.test(customerId)) throw new CredentialVaultError('Credential workspace is invalid')
  if (!ID.test(String(integration || '')) || !ID.test(String(credentialKey || ''))) throw new CredentialVaultError('Credential identity is invalid')
  if (!Number.isInteger(keyVersion) || keyVersion < 1) throw new CredentialVaultError('Credential key version is invalid')
  return `${customerId}:${integration}:${credentialKey}:v${keyVersion}`
}

function sealCredential({ customerId, integration, credentialKey, plaintext, env = process.env }) {
  if (typeof plaintext !== 'string' || !plaintext.length) throw new CredentialVaultError('Credential value is invalid')
  const { key, version } = keyConfig(env)
  const aad = Buffer.from(identity({ customerId, integration, credentialKey, keyVersion: version }))
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  return { customer_id: customerId, integration, credential_key: credentialKey, ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), auth_tag: cipher.getAuthTag().toString('base64'), algorithm: ALGORITHM, key_version: version }
}

function openCredential(record, { customerId, integration, credentialKey, env = process.env }) {
  if (!record || record.algorithm !== ALGORITHM) throw new CredentialVaultError('Credential record is invalid')
  const { key } = keyConfig(env, Number(record.key_version))
  if (record.customer_id !== customerId || record.integration !== integration || record.credential_key !== credentialKey) throw new CredentialVaultError('Credential workspace is invalid')
  try {
    const version = Number(record.key_version)
    const aad = Buffer.from(identity({ customerId, integration, credentialKey, keyVersion: version }))
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(record.iv, 'base64'))
    decipher.setAAD(aad)
    decipher.setAuthTag(Buffer.from(record.auth_tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]).toString('utf8')
  } catch (error) {
    if (error instanceof CredentialVaultError) throw error
    throw new CredentialVaultError('Credential could not be authenticated')
  }
}

function safeCredentialMetadata(record) {
  return record ? { integration: record.integration, credential_key: record.credential_key, key_version: record.key_version, algorithm: record.algorithm } : null
}

function createCredentialVault({ db = null, env = process.env } = {}) {
  const database = db || require('./supabase')
  async function put({ customerId, integration, credentialKey, plaintext }) {
    const record = { ...sealCredential({ customerId, integration, credentialKey, plaintext, env }), updated_at: new Date().toISOString() }
    const { data, error } = await database.from('workspace_integration_credentials').upsert(record, { onConflict: 'customer_id,integration,credential_key' }).select('customer_id,integration,credential_key,ciphertext,iv,auth_tag,algorithm,key_version,created_at,updated_at').single()
    if (error) throw new CredentialVaultError('Unable to store credential')
    return safeCredentialMetadata(data)
  }
  async function get({ customerId, integration, credentialKey }) {
    identity({ customerId, integration, credentialKey, keyVersion: 1 })
    const { data, error } = await database.from('workspace_integration_credentials').select('customer_id,integration,credential_key,ciphertext,iv,auth_tag,algorithm,key_version').eq('customer_id', customerId).eq('integration', integration).eq('credential_key', credentialKey).maybeSingle()
    if (error) throw new CredentialVaultError('Unable to load credential')
    if (!data) return null
    return openCredential(data, { customerId, integration, credentialKey, env })
  }
  return { put, get }
}

module.exports = { ALGORITHM, CredentialVaultError, keyConfig, sealCredential, openCredential, safeCredentialMetadata, createCredentialVault }
