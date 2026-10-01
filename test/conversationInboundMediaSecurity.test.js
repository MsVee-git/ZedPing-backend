const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'conversations.js'), 'utf8')

test('media proxy requires a workspace-owned conversation and workspace-owned message', () => {
  assert.ok(source.includes("router.get('/:id/messages/:messageId/media'"))
  assert.ok(source.includes("getConversation(req.workspace.customerId, req.params.id)"))
  assert.ok(source.includes(".eq('customer_id', req.workspace.customerId)"))
  assert.ok(source.includes(".eq('conversation_id', conversation.id)"))
  assert.equal(source.includes('req.params.mediaId'), false)
})

test('media proxy resolves the message-bound connected number and never serializes credentials', () => {
  assert.ok(source.includes(".eq('id', message.whatsapp_number_id)"))
  assert.ok(source.includes(".eq('status', 'connected')"))
  assert.ok(source.includes("credentialKey: `phone_${number.phone_number_id}`"))
  assert.ok(source.includes("'Cache-Control': 'private, no-store'"))
  assert.equal(source.includes('access_token: accessToken'), false)
  assert.equal(source.includes('res.json({ accessToken'), false)
})
