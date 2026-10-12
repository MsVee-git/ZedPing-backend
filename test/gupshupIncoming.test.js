const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeGupshupIncoming, persistGupshupEvents } = require('../lib/gupshupIncoming')
const mapping = { app_id: 'app1', customer_id: 'c1', whatsapp_number_id: 'n1' }
const number = { id: 'n1', customer_id: 'c1', whatsapp_business_account_id: 'waba1', phone_number_id: 'phone1' }
const callback = () => ({ gs_app_id: 'app1', object: 'whatsapp_business_account', entry: [{ id: 'waba1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'phone1' }, messages: [{ id: 'msg1', from: '260977123456', type: 'text', text: { body: 'Hello' }, context: { id: 'quoted1' } }] } }] }] })
test('v3 incoming text preserves quote and stable event identity', () => {
 const events = normalizeGupshupIncoming(callback(), mapping, number)
 assert.equal(events[0].event_key, 'message:msg1')
 assert.equal(events[0].payload.reply_to_message_id, 'quoted1')
})
test('app, WABA, phone and workspace substitution are rejected', () => {
 const payload = callback(); payload.gs_app_id = 'other'
 assert.throws(() => normalizeGupshupIncoming(payload, mapping, number), /mismatch/)
 assert.throws(() => normalizeGupshupIncoming(callback(), mapping, { ...number, customer_id: 'other' }), /mismatch/)
 const wrong = callback(); wrong.entry[0].id = 'other'
 assert.throws(() => normalizeGupshupIncoming(wrong, mapping, number), /WABA/)
})
test('durable insert ignores duplicates without rewriting processing state; storage failures propagate', async () => {
 let options, rows
 const db = { from: () => ({ upsert: async (r,o) => { rows = r; options = o; return {} } }) }
 await persistGupshupEvents(db, mapping, normalizeGupshupIncoming(callback(), mapping, number))
 assert.equal(options.ignoreDuplicates, true)
 assert.equal(rows[0].customer_id, 'c1')
 assert.equal(rows[0].processing_state, undefined)
 await assert.rejects(persistGupshupEvents({ from: () => ({ upsert: async () => ({ error: true }) }) }, mapping, rows), /persist/)
})

test('image, document and location metadata are normalized without accepting arbitrary URLs', () => {
 for (const message of [
  { type: 'image', image: { id: '123456', mime_type: 'image/jpeg', caption: 'Product' } },
  { type: 'document', document: { id: '123457', mime_type: 'application/pdf', filename: 'quote.pdf' } },
  { type: 'location', location: { latitude: -15.4, longitude: 28.3 } }
 ]) {
  const payload = callback(); payload.entry[0].changes[0].value.messages[0] = { id: 'media1', from: '260977123456', ...message }
  assert.equal(normalizeGupshupIncoming(payload,mapping,number)[0].payload.media.type,message.type)
 }
 const bad = callback(); bad.entry[0].changes[0].value.messages[0] = { id: 'bad', from: '260977123456', type: 'image', image: { link: 'http://private-host' } }
 assert.throws(() => normalizeGupshupIncoming(bad,mapping,number), /media metadata/)
})
