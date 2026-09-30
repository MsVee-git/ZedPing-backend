const test = require('node:test')
const assert = require('node:assert/strict')
const { CredentialVaultError, sealCredential, openCredential, safeCredentialMetadata } = require('../lib/credentialVault')

const env = { CREDENTIAL_VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), CREDENTIAL_VAULT_KEY_VERSION: '3' }
const identity = { customerId: '11111111-1111-4111-8111-111111111111', integration: 'meta_whatsapp', credentialKey: 'business_token' }

test('encrypts and decrypts a workspace credential using authenticated encryption', () => {
  const record = sealCredential({ ...identity, plaintext: 'secret-value-not-for-output', env })
  assert.equal(record.algorithm, 'aes-256-gcm')
  assert.equal(record.key_version, 3)
  assert.equal(record.ciphertext.includes('secret-value-not-for-output'), false)
  assert.equal(openCredential(record, { ...identity, env }), 'secret-value-not-for-output')
})

test('detects ciphertext, authentication tag, and workspace tampering', () => {
  const record = sealCredential({ ...identity, plaintext: 'secret-value-not-for-output', env })
  for (const changed of [{ ...record, ciphertext: record.ciphertext.slice(0, -2) + 'AA' }, { ...record, auth_tag: record.auth_tag.slice(0, -2) + 'AA' }]) assert.throws(() => openCredential(changed, { ...identity, env }), CredentialVaultError)
  assert.throws(() => openCredential(record, { ...identity, customerId: '22222222-2222-4222-8222-222222222222', env }), CredentialVaultError)
})

test('rejects missing and invalid master-key configuration', () => {
  assert.throws(() => sealCredential({ ...identity, plaintext: 'value', env: {} }), CredentialVaultError)
  assert.throws(() => sealCredential({ ...identity, plaintext: 'value', env: { CREDENTIAL_VAULT_MASTER_KEY: 'not-a-32-byte-key' } }), CredentialVaultError)
})

test('uses versioned retained keys to support future rotation without weakening authentication', () => {
  const oldEnv = { CREDENTIAL_VAULT_MASTER_KEY: Buffer.alloc(32, 6).toString('base64'), CREDENTIAL_VAULT_KEY_VERSION: '2' }
  const record = sealCredential({ ...identity, plaintext: 'rotation-secret', env: oldEnv })
  const rotated = { CREDENTIAL_VAULT_MASTER_KEY: Buffer.alloc(32, 8).toString('base64'), CREDENTIAL_VAULT_KEY_VERSION: '3', CREDENTIAL_VAULT_PREVIOUS_MASTER_KEYS: JSON.stringify({ 2: oldEnv.CREDENTIAL_VAULT_MASTER_KEY }) }
  assert.equal(openCredential(record, { ...identity, env: rotated }), 'rotation-secret')
  assert.throws(() => openCredential(record, { ...identity, env: { CREDENTIAL_VAULT_MASTER_KEY: rotated.CREDENTIAL_VAULT_MASTER_KEY, CREDENTIAL_VAULT_KEY_VERSION: '3' } }), CredentialVaultError)
})

test('safe metadata and JSON output never serialize plaintext credential material', () => {
  const secret = 'secret-value-not-for-output'
  const record = sealCredential({ ...identity, plaintext: secret, env })
  const output = JSON.stringify({ stored: record, api: safeCredentialMetadata(record) })
  assert.equal(output.includes(secret), false)
  assert.deepEqual(safeCredentialMetadata(record), { integration: 'meta_whatsapp', credential_key: 'business_token', key_version: 3, algorithm: 'aes-256-gcm' })
})
