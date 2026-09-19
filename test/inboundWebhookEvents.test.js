const test = require('node:test')
const assert = require('node:assert/strict')
const { inboundEventPayload, isDuplicateInboundEventError } = require('../lib/inboundWebhookEvents')

test('inbound idempotency payload contains only workspace, number and Meta message identity', () => {
  assert.deepEqual(inboundEventPayload({ customerId: 'workspace', number: { id: 'number' }, metaId: 'wamid.1' }), {
    customer_id: 'workspace', whatsapp_number_id: 'number', meta_message_id: 'wamid.1'
  })
  assert.equal(inboundEventPayload({ customerId: 'workspace', number: { id: 'number' }, metaId: '' }), null)
})

test('only unique-violation errors are treated as duplicate inbound events', () => {
  assert.equal(isDuplicateInboundEventError({ code: '23505' }), true)
  assert.equal(isDuplicateInboundEventError({ code: '42501' }), false)
  assert.equal(isDuplicateInboundEventError(null), false)
})
