const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { configuredAccessToken } = require('../lib/whatsapp')

test('legacy connected number media retrieval uses the backend-only configured token when no per-number credential exists', () => {
  const previous = process.env.META_ACCESS_TOKEN
  try {
    process.env.META_ACCESS_TOKEN = 'legacy-server-token'
    assert.equal(configuredAccessToken(null), 'legacy-server-token')
  } finally {
    if (previous === undefined) delete process.env.META_ACCESS_TOKEN
    else process.env.META_ACCESS_TOKEN = previous
  }
})

test('media proxy retains its workspace-scoped vault lookup before the legacy backend-only fallback', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'conversations.js'), 'utf8')
  assert.ok(source.includes("credentialKey: `phone_${number.phone_number_id}`"))
  assert.ok(source.includes('return configuredAccessToken(number.access_token)'))
  assert.ok(source.indexOf("credentialKey: `phone_${number.phone_number_id}`") < source.indexOf('return configuredAccessToken(number.access_token)'))
  assert.ok(source.includes("getConversation(req.workspace.customerId, req.params.id)"))
  assert.ok(source.includes(".eq('customer_id', req.workspace.customerId)"))
})
