const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveWhatsAppAccessToken, WhatsAppCredentialError } = require('../lib/whatsappCredentials')
const { createCredentialVault, sealCredential } = require('../lib/credentialVault')

const customerA = '11111111-1111-4111-8111-111111111111'
const customerB = '22222222-2222-4222-8222-222222222222'
const env = { CREDENTIAL_VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), META_ACCESS_TOKEN: 'shared-bot-token' }
const number = (customerId = customerA, phoneId = '123456789') => ({ customer_id: customerId, phone_number_id: phoneId, status: 'connected', provisioning_state: 'operational', access_token: 'stale-row-token' })
const vault = (value) => ({ get: async () => value })

function encryptedVault(records) {
  const calls = []
  const db = { from(table) {
    assert.equal(table, 'workspace_integration_credentials')
    const filters = {}
    const query = { select() { return query }, eq(k, v) { filters[k] = v; return query }, async maybeSingle() {
      calls.push(filters)
      return { data: records.find(r => Object.entries(filters).every(([k, v]) => r[k] === v)) || null, error: null }
    } }
    return query
  } }
  return { vault: createCredentialVault({ db, env }), calls }
}

test('two workspaces decrypt only their own phone credential and override row/global bot tokens', async () => {
  const records = [customerA, customerB].map((customerId, i) => sealCredential({ customerId, integration: 'meta_whatsapp', credentialKey: 'phone_123456789', plaintext: `client-${i}`, env }))
  const scoped = encryptedVault(records)
  assert.equal(await resolveWhatsAppAccessToken(number(customerA), { ...scoped, env }), 'client-0')
  assert.equal(await resolveWhatsAppAccessToken(number(customerB), { ...scoped, env }), 'client-1')
  assert.deepEqual(scoped.calls.map(c => c.customer_id), [customerA, customerB])
})

test('caller workspace mismatch is refused before a credential lookup', async () => {
  let calls = 0
  await assert.rejects(resolveWhatsAppAccessToken(number(), { customerId: customerB, vault: { get: async () => { calls++ } }, env }), WhatsAppCredentialError)
  assert.equal(calls, 0)
})

test('the phone ID selects its own credential within the workspace', async () => {
  const scoped = encryptedVault([sealCredential({ customerId: customerA, integration: 'meta_whatsapp', credentialKey: 'phone_987654321', plaintext: 'other-phone', env })])
  await assert.rejects(resolveWhatsAppAccessToken(number(), { ...scoped, env }), WhatsAppCredentialError)
  assert.equal(await resolveWhatsAppAccessToken(number(customerA, '987654321'), { ...scoped, env }), 'other-phone')
})

test('signup connections with a missing or blank credential never fall back to the shared bot', async () => {
  for (const value of [null, '', ' ']) await assert.rejects(resolveWhatsAppAccessToken(number(), { vault: vault(value), env }), WhatsAppCredentialError)
  await assert.rejects(resolveWhatsAppAccessToken({ ...number(), provisioning_state: null, provisioned_at: '2026-10-07' }, { vault: vault(null), env }), WhatsAppCredentialError)
})

test('vault read/decryption errors never fall back and expose no secret error text', async () => {
  const broken = { get: async () => { throw new Error('sensitive-database-token') } }
  for (const n of [number(), { ...number(), provisioning_state: null }]) {
    await assert.rejects(resolveWhatsAppAccessToken(n, { vault: broken, env }), e => e instanceof WhatsAppCredentialError && !e.message.includes('sensitive'))
  }
  const record = sealCredential({ customerId: customerA, integration: 'meta_whatsapp', credentialKey: 'phone_123456789', plaintext: 'client-token', env })
  record.auth_tag = Buffer.alloc(16).toString('base64')
  await assert.rejects(resolveWhatsAppAccessToken(number(), { ...encryptedVault([record]), env }), WhatsAppCredentialError)
})

test('legacy connections retain their row credential then the configured system-user token', async () => {
  const legacy = { ...number(), provisioning_state: null }
  assert.equal(await resolveWhatsAppAccessToken(legacy, { vault: vault(null), env }), 'stale-row-token')
  assert.equal(await resolveWhatsAppAccessToken({ ...legacy, access_token: null }, { vault: vault(null), env }), 'shared-bot-token')
  await assert.rejects(resolveWhatsAppAccessToken({ ...legacy, access_token: null }, { vault: vault(null), env: {} }), WhatsAppCredentialError)
})
