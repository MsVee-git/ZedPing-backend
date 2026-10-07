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

test('media proxy shares the workspace-scoped credential resolver with outbound messaging', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'conversations.js'), 'utf8')
  assert.ok(source.includes("require('../lib/whatsappCredentials')"))
  assert.ok(source.includes('resolveWhatsAppAccessToken(number, { customerId: req.workspace.customerId })'))
  assert.ok(source.includes("getConversation(req.workspace.customerId, req.params.id)"))
  assert.ok(source.includes(".eq('customer_id', req.workspace.customerId)"))
})
