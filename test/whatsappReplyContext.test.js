const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const axios = require('axios')
const { parseInboundReplyContext, messageReplyPreview, aiReplyContext, matchingReplyMessage } = require('../lib/replyContext')
const { sendTextMessage, sendImageMessage } = require('../lib/whatsapp')

test('captures only a valid explicit Meta context ID and safely formats rich reply context', () => {
  assert.equal(parseInboundReplyContext({ context: { id: 'wamid.HBgMNjAwMDAwMDAwMDAA' } }), 'wamid.HBgMNjAwMDAwMDAwMDAA')
  assert.equal(parseInboundReplyContext({ context: { id: 'https://untrusted.invalid/message' } }), null)
  assert.equal(messageReplyPreview({ outbound_media: { type: 'image', caption: 'Tonneau Cover' } }), '[Customer replied to an image message: "Tonneau Cover"]')
  assert.equal(messageReplyPreview({ outbound_media: { type: 'document', filename: 'quotation.pdf' } }), '[Customer replied to document: quotation.pdf]')
  assert.equal(messageReplyPreview({ outbound_media: { type: 'location', name: 'AutoGuard Engineering', address: 'Plot 11170' } }), '[Customer replied to location: AutoGuard Engineering, Plot 11170]')
  assert.match(aiReplyContext({ message_body: 'Ford Ranger Tonneau Cover — K6,800' }), /Customer replied to:\nFord Ranger/)
})

test('reply resolution rejects another tenant, WhatsApp number, conversation, or contact', () => {
  const scope = { customerId: 'workspace-a', whatsappNumberId: 'number-a', conversationId: 'conversation-a', contactId: 'contact-a' }
  const resolved = matchingReplyMessage([
    { id: 'tenant-b', customer_id: 'workspace-b', whatsapp_number_id: 'number-a', conversation_id: 'conversation-a', contact_id: 'contact-a' },
    { id: 'number-b', customer_id: 'workspace-a', whatsapp_number_id: 'number-b', conversation_id: 'conversation-a', contact_id: 'contact-a' },
    { id: 'conversation-b', customer_id: 'workspace-a', whatsapp_number_id: 'number-a', conversation_id: 'conversation-b', contact_id: 'contact-a' },
    { id: 'contact-b', customer_id: 'workspace-a', whatsapp_number_id: 'number-a', conversation_id: 'conversation-a', contact_id: 'contact-b' },
    { id: 'match', customer_id: 'workspace-a', whatsapp_number_id: 'number-a', conversation_id: 'conversation-a', contact_id: 'contact-a' }
  ], scope)
  assert.equal(resolved.id, 'match')
  assert.equal(matchingReplyMessage([{ id: 'foreign', customer_id: 'workspace-b', whatsapp_number_id: 'number-a' }], scope), null)
})

test('staff replies use only resolved server-side Meta context in native WhatsApp payloads', async () => {
  const originalPost = axios.post
  const sent = []
  axios.post = async (_url, body) => { sent.push(body); return { data: { messages: [{ id: 'reply-id' }] } } }
  try {
    await sendTextMessage('1234567890', '260970000000', 'Yes, available.', 'server-token', 'wamid.HBgMNjAwMDAwMDAwMDAwMDAA')
    await sendImageMessage('1234567890', '260970000000', { id: '123456', caption: 'Photo' }, 'server-token', 'wamid.HBgMNjAwMDAwMDAwMDAwMDAA')
    assert.equal(sent[0].context.message_id, 'wamid.HBgMNjAwMDAwMDAwMDAwMDAA')
    assert.equal(sent[1].context.message_id, 'wamid.HBgMNjAwMDAwMDAwMDAwMDAA')
    assert.equal(sent[0].context.message_id.includes('server-token'), false)
  } finally { axios.post = originalPost }
})

test('resolution and AI paths are explicitly tenant, number, conversation and idempotency scoped', () => {
  const webhook = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhook.js'), 'utf8')
  const conversations = fs.readFileSync(path.join(__dirname, '..', 'routes', 'conversations.js'), 'utf8')
  assert.match(webhook, /parseInboundReplyContext\(incoming\)/)
  assert.match(webhook, /\.eq\('customer_id', ctx\.customerId\)\.eq\('whatsapp_number_id', ctx\.number\.id\)/)
  assert.match(webhook, /\.eq\('meta_message_id', ctx\.replyContextMetaId\)/)
  assert.match(webhook, /reply_to_message_id: replyTo\?\.id \|\| null/)
  assert.match(webhook, /aiReplyContext\(ctx\.replyToMessage\)/)
  assert.match(webhook, /claimInboundEvent\(ctx\)/)
  assert.match(conversations, /resolveOutgoingReplyContext/)
  assert.match(conversations, /\.eq\('conversation_id', conversation\.id\)/)
  assert.match(conversations, /reply_to_message_id/)
  assert.match(conversations, /const replyIds =/)
  assert.match(conversations, /\.in\('id', replyIds\)/)
  assert.match(conversations, /reply_to: publicReplyMessage\(repliesById\.get\(reply_to_message_id\)\)/)
  assert.doesNotMatch(conversations, /messages!messages_reply_to_message_id_fkey/)
})

test('quote context remains reference context, not a knowledge authorization bypass', () => {
  const webhook = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhook.js'), 'utf8')
  const grounding = fs.readFileSync(path.join(__dirname, '..', 'lib', 'zoeGrounding.js'), 'utf8')
  assert.match(webhook, /buildLiveSystem\(agent, version, customerTurn\)/)
  assert.match(grounding, /knowledge_snapshot/)
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'lib', 'replyContext.js'), 'utf8'), /knowledge_snapshot|approved knowledge/)
})

test('reply-context migration is atomic, rerunnable, and revokes the zero-argument trigger function', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261001130000_add_whatsapp_reply_context.sql'), 'utf8')
  assert.match(migration, /^begin;/m)
  assert.match(migration, /add column if not exists reply_to_message_id/)
  assert.match(migration, /create or replace function public\.assert_message_reply_context_workspace\(\)/)
  assert.match(migration, /revoke all on function public\.assert_message_reply_context_workspace\(\) from public;/)
  assert.match(migration, /drop trigger if exists messages_reply_context_workspace_integrity/)
  assert.match(migration, /same workspace, WhatsApp number, and conversation/)
  assert.match(migration, /commit;\s*$/)
})
