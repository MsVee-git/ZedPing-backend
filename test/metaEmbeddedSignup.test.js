const test = require('node:test')
const assert = require('node:assert/strict')
const { createMetaEmbeddedSignupClient, MetaSignupError } = require('../lib/metaEmbeddedSignup')

const env = {
  META_APP_ID: '123456',
  META_APP_SECRET: 'app-secret',
  META_ACCESS_TOKEN: 'system-token',
  META_GRAPH_API_VERSION: 'v18.0'
}

function httpFor({ debug, numbers, subscribeSuccess = true }) {
  return {
    async get(url) {
      if (url.includes('debug_token')) return { data: { data: { granular_scopes: debug } } }
      const wabaId = url.match(/v18\.0\/([0-9]+)\/phone_numbers/)[1]
      return { data: { data: numbers[wabaId] || [] } }
    },
    async post() { return { data: { success: subscribeSuccess } } }
  }
}

test('validates a selected number only when it belongs to an authorized WABA', async () => {
  const client = createMetaEmbeddedSignupClient({
    env,
    http: httpFor({
      debug: [{ scope: 'whatsapp_business_management', target_ids: ['100'] }],
      numbers: { 100: [{ id: '200', display_phone_number: '+260 700 000 000', verified_name: 'Example' }] }
    })
  })
  const result = await client.validatePhoneOwnership({ accessToken: 'temporary-token', phoneNumberId: '200' })
  assert.deepEqual(result, {
    wabaId: '100',
    phoneNumberId: '200',
    displayPhoneNumber: '+260 700 000 000',
    displayName: 'Example',
    qualityRating: null,
    verificationStatus: null
  })
})

test('rejects a phone number that Meta cannot prove belongs to the authorized WABA', async () => {
  const client = createMetaEmbeddedSignupClient({
    env,
    http: httpFor({
      debug: [{ scope: 'whatsapp_business_management', target_ids: ['100'] }],
      numbers: { 100: [{ id: '999', display_phone_number: '+260 700 000 999' }] }
    })
  })
  await assert.rejects(() => client.validatePhoneOwnership({ accessToken: 'temporary-token', phoneNumberId: '200' }), MetaSignupError)
})

test('rejects an invalid Meta access grant with no WhatsApp Business Account scope', async () => {
  const client = createMetaEmbeddedSignupClient({ env, http: httpFor({ debug: [], numbers: {} }) })
  await assert.rejects(() => client.validatePhoneOwnership({ accessToken: 'temporary-token', phoneNumberId: '200' }), MetaSignupError)
})

test('requires Meta webhook subscription confirmation before a connection can succeed', async () => {
  const client = createMetaEmbeddedSignupClient({
    env,
    http: httpFor({ debug: [], numbers: {}, subscribeSuccess: false })
  })
  await assert.rejects(() => client.subscribeApp('100'), MetaSignupError)
})
