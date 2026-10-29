const test = require('node:test')
const assert = require('node:assert/strict')
process.env.SUPABASE_URL ||= 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key'
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-role-key'
const { createWhatsAppTextRouter } = require('../lib/whatsappProvider')
const { createWorkspaceAttachmentRouter } = require('../lib/whatsappRuntime')
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
test('Content Library attachments use the matching Meta or Gupshup provider path', async () => {
 const attachment = { type:'document', mime_type:'application/pdf', filename:'menu.pdf', caption:'Our menu', file:{ buffer:Buffer.from('pdf') } }
 const metaCalls=[]
 const metaSend = createWorkspaceAttachmentRouter({
  providerFor: async () => null,
  resolveToken: async () => 'server-only-token',
  metaApi:{ uploadWhatsAppMedia:async (...args) => { metaCalls.push(['upload',...args]); return 'meta-media' }, sendDocumentMessage:async (...args) => { metaCalls.push(['send',...args]); return { messages:[{id:'meta-message'}] } } }
 })
 const metaResult = await metaSend({ customerId:'client1', number, to:'260977123456', attachment })
 assert.equal(metaResult.mediaId, 'meta-media')
 assert.equal(metaCalls[0][0], 'upload')
 assert.equal(metaCalls[1][0], 'send')

 const gupshupCalls=[]
 const gupshupSend = createWorkspaceAttachmentRouter({
  providerFor: async () => ({ mapping:{app_id:'app1'}, client:{ uploadMedia:async (_app,file) => { gupshupCalls.push(['upload',file.originalname]); return 'gupshup-media' }, sendMedia:async (_app,request) => { gupshupCalls.push(['send',request]); return {messageId:'gupshup-message'} } } }),
  reserve: async (_selected,_customer,_kind,submit) => submit()
 })
 const gupshupResult = await gupshupSend({ customerId:'client1', number, to:'+260977123456', attachment })
 assert.equal(gupshupResult.mediaId, 'gupshup-media')
 assert.deepEqual(gupshupCalls[1][1], { to:'260977123456', type:'document', mediaId:'gupshup-media', caption:'Our menu', filename:'menu.pdf', replyToMessageId:undefined })
})
