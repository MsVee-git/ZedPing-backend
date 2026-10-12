const test = require('node:test')
const assert = require('node:assert/strict')
const { createWhatsAppTextRouter } = require('../lib/whatsappProvider')
const number = { id: 'number1', customer_id: 'client1', phone_number_id: 'phone1' }
test('Gupshup mapped messages never resolve or use Meta credentials', async () => {
 const send = createWhatsAppTextRouter({ loadMapping: async () => ({ app_id: 'app1', link_state: 'linked' }), allowGupshup: () => true,
  metaSendText: () => { throw Error('wrong provider') }, resolveMetaToken: () => { throw Error('wrong credentials') },
  gupshup: { sendText: async (appId, request) => { assert.equal(appId, 'app1'); assert.equal(request.replyToMessageId, 'quoted'); return { messageId: 'msg1' } } } })
 const result = await send({ customerId: 'client1', number, to: '260977123456', body: 'Hi', replyToMessageId: 'quoted' })
 assert.equal(result.delivery_status, 'accepted')
})
test('mapped but disabled Gupshup fails closed without Meta fallback', async () => {
 const send = createWhatsAppTextRouter({ loadMapping: async () => ({ app_id: 'app1', link_state: 'linked' }) })
 await assert.rejects(send({ customerId: 'client1', number }), /not enabled/)
 await assert.rejects(send({ customerId: 'other', number }), /ownership/)
})
test('unmapped Meta connections preserve existing sending contract', async () => {
 const send = createWhatsAppTextRouter({ loadMapping: async () => null, resolveMetaToken: async () => 'token', metaSendText: async (...args) => { assert.deepEqual(args, ['phone1','recipient','Hi','token',null]); return { messages: [{ id: 'meta1' }] } } })
 assert.equal((await send({ customerId: 'client1', number, to: 'recipient', body: 'Hi' })).messages[0].id, 'meta1')
})
