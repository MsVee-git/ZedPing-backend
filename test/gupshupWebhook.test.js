const test = require('node:test')
const assert = require('node:assert/strict')
const { authenticateGupshupWebhook, validateGupshupEventMapping } = require('../lib/gupshupWebhook')
test('webhook authentication fails closed for missing, weak or incorrect secrets', () => {
 const secret = 's'.repeat(48)
 assert.equal(authenticateGupshupWebhook(secret, secret), true)
 for (const value of [null, '', 'wrong', ['s'], 'x'.repeat(600)]) assert.equal(authenticateGupshupWebhook(value, secret), false)
 assert.equal(authenticateGupshupWebhook('short', 'short'), false)
})
test('events must match the server app mapping', () => {
 const mapping = { app_id: 'app1', customer_id: 'client1', whatsapp_number_id: 'number1' }
 assert.equal(validateGupshupEventMapping({ appId: 'app1', type: 'message' }, mapping), true)
 assert.equal(validateGupshupEventMapping({ appId: 'other', type: 'message', customer_id: 'client1' }, mapping), false)
 assert.equal(validateGupshupEventMapping({ appId: 'app1' }, mapping), false)
})
