const test = require('node:test')
const assert = require('node:assert/strict')
const { GUPSHUP_APP_NAME_MAX_LENGTH, appNameForConnection, linkVerifiedConnection } = require('../lib/gupshupOnboarding')
const connection = { id: 'connection1', customer_id: 'customer1', provider: 'gupshup', whatsapp_business_account_id: '123456', phone_number: '260977123456' }

test('concurrent atomic claims permit only one app creation', async () => {
  let claimed = false, calls = 0
  const store = { claimLink: async () => { if (claimed) return false; claimed = true; return true }, markLinked: async () => {}, markConfirmationRequired: async () => {} }
  const input = { customerId: 'customer1', connection, appName: 'ZedPingExampleBusiness1234567890', store, partner: { linkApp: async () => { calls++; return { appId: 'app1' } } } }
  const results = await Promise.all([linkVerifiedConnection(input), linkVerifiedConnection(input)])
  assert.equal(calls, 1)
  assert.ok(results.some(r => r.kind === 'linked'))
  assert.ok(results.some(r => r.kind === 'in_progress_or_confirmation_required'))
})

test('uncertain creation or persistence requires confirmation without retry', async () => {
  let marked = 0, calls = 0
  const input = { customerId: 'customer1', connection, appName: 'ZedPingExampleBusiness1234567890', store: { claimLink: async () => true, markLinked: async () => { throw Error('database') }, markConfirmationRequired: async () => { marked++ } }, partner: { linkApp: async () => { calls++; return { appId: 'app1' } } } }
  await assert.rejects(linkVerifiedConnection(input), /requires confirmation/)
  assert.equal(marked, 1)
  assert.equal(calls, 1)
})

test('existing mapping is reused and wrong workspace or Meta provider is refused', async () => {
  assert.deepEqual(await linkVerifiedConnection({ customerId: 'customer1', connection: { ...connection, gupshup_app_id: 'existing' } }), { kind: 'linked', appId: 'existing' })
  await assert.rejects(linkVerifiedConnection({ customerId: 'other', connection, appName: 'ZedPingExampleBusiness1234567890' }), /ownership/)
  await assert.rejects(linkVerifiedConnection({ customerId: 'customer1', connection: { ...connection, provider: 'meta' }, appName: 'ZedPingExampleBusiness1234567890' }), /ownership/)
})

test('new app names include an alphanumeric workspace name, a stable suffix, and stay within provider limits', () => {
  const first = appNameForConnection('connection-1', 'Café & Co. Zambia!')
  assert.match(first, /^ZedPingCafCoZambia[A-Fa-f0-9]{16}$/)
  assert.equal(first, appNameForConnection('connection-1', 'Café & Co. Zambia!'))
  assert.notEqual(first, appNameForConnection('connection-2', 'Café & Co. Zambia!'))
  assert.ok(appNameForConnection('connection-3', 'a'.repeat(1000)).length <= GUPSHUP_APP_NAME_MAX_LENGTH)
})

test('provider linking uses the mapping name that was persisted before the provider call', async () => {
  let usedName = null
  await linkVerifiedConnection({
    customerId: 'customer1', connection,
    appName: 'ZedPingSavedWorkspaceName1234567890',
    store: { claimLink: async () => true, markLinked: async () => {}, markConfirmationRequired: async () => {} },
    partner: { linkApp: async ({ name }) => { usedName = name; return { appId: 'app1' } } }
  })
  assert.equal(usedName, 'ZedPingSavedWorkspaceName1234567890')
})

