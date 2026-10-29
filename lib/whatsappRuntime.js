const crypto = require('node:crypto')
const db = require('./supabase')
const meta = require('./whatsapp')
const { resolveWhatsAppAccessToken } = require('./whatsappCredentials')
const { createGupshupPartnerClient } = require('./gupshupPartner')
const { createGupshupConnectionStore } = require('./gupshupConnectionStore')
const { gupshupConfigForCustomer } = require('./gupshupConfig')

// Rollout switch is separate from onboarding. Disabled code leaves legacy
// routes unchanged; onboarding must remain disabled until messaging is ready.
async function provider(number, customerId) {
 if (number?.customer_id !== customerId) throw new Error('WhatsApp ownership mismatch')
 const mapping = await createGupshupConnectionStore(db).load({ customerId, connectionId: number.id })
 if (!mapping) return null
 if (process.env.GUPSHUP_ROUTING_ENABLED !== 'true') throw new Error('Gupshup messaging is paused; Meta fallback is prohibited')
 const config = gupshupConfigForCustomer(customerId, process.env, "messaging")
 if (!config || mapping.link_state !== 'linked' || !mapping.app_id) throw new Error('Gupshup sending is unavailable')
 return { mapping, client: createGupshupPartnerClient(config) }
}

async function sendWorkspaceText({ number, customerId, to, body, replyToMessageId }) {
 const selected = await provider(number, customerId)
 if (!selected) return meta.sendTextMessage(number.phone_number_id, to, body, await resolveWhatsAppAccessToken(number, { customerId }), replyToMessageId)
 return reservedSend(selected, customerId, 'service', () => selected.client.sendText(selected.mapping.app_id, { to: String(to).replace(/^\+/, ''), body, replyToMessageId }))
}
module.exports = { sendWorkspaceText, provider }

async function reservedSend(selected, customerId, kind, submit) {
 const reservationId = crypto.randomUUID()
 const reserved = await db.rpc('reserve_gupshup_usage', { p_customer_id: customerId, p_reservation_id: reservationId, p_kind: kind })
 if (reserved.error) throw new Error('Messaging allowance is unavailable or exhausted')
 let result
 try { result = await submit() } catch {
  await db.from('gupshup_usage_reservations').update({state:'confirmation_required'}).eq('id',reservationId).eq('customer_id',customerId)
  throw new Error('Message submission needs confirmation; do not resend')
 }
 const finalized = await db.from('gupshup_usage_reservations').update({ provider_message_id: result.messageId, state: 'accepted' }).eq('id', reservationId).eq('customer_id', customerId)
 if (finalized.error) throw new Error('Message submission needs confirmation; do not resend')
 return { messages: [{ id: result.messageId }], provider: 'gupshup', delivery_status: 'accepted' }
}
async function sendWorkspaceTemplate({ number, customerId, to, template, category }) {
 const selected = await provider(number, customerId)
 if (!selected) return meta.sendTemplateMessage(number.phone_number_id, to, template, await resolveWhatsAppAccessToken(number, { customerId }))
 if (template.headerMedia) template = { ...template, components: [{type:'header',parameters:[{type:template.headerMedia.type,[template.headerMedia.type]:{id:template.headerMedia.id}}]}, ...(template.components || [])] }
 return reservedSend(selected, customerId, 'template', () => selected.client.sendTemplate(selected.mapping.app_id, { to: String(to).replace(/^\+/, ''), template, category }))
}
function createWorkspaceAttachmentRouter({ providerFor = provider, metaApi = meta, resolveToken = resolveWhatsAppAccessToken, reserve = reservedSend } = {}) {
 return async function sendWorkspaceAttachment({ number, customerId, to, attachment, replyToMessageId }) {
 const selected = await providerFor(number, customerId)
 const file = { ...attachment.file, mimetype: attachment.mime_type, originalname: attachment.filename }
 if (!selected) {
  const token = await resolveToken(number, { customerId })
  const mediaId = await metaApi.uploadWhatsAppMedia(number.phone_number_id, file, token)
  const send = attachment.type === 'image' ? metaApi.sendImageMessage : metaApi.sendDocumentMessage
  const result = await send(number.phone_number_id, to, { id: mediaId, caption: attachment.caption, filename: attachment.filename }, token, replyToMessageId)
  return { mediaId, result }
 }
 const mediaId = await selected.client.uploadMedia(selected.mapping.app_id, file)
 const result = await reserve(selected, customerId, 'service', () => selected.client.sendMedia(selected.mapping.app_id, { to: String(to).replace(/^\+/, ''), type: attachment.type, mediaId, caption: attachment.caption, filename: attachment.filename, replyToMessageId }))
 return { mediaId, result }
 }
}
const sendWorkspaceAttachment = createWorkspaceAttachmentRouter()
module.exports.sendWorkspaceTemplate = sendWorkspaceTemplate
module.exports.sendWorkspaceAttachment = sendWorkspaceAttachment
module.exports.createWorkspaceAttachmentRouter = createWorkspaceAttachmentRouter

async function uploadWorkspaceMedia({number,customerId,file}) {
 const selected = await provider(number,customerId)
 if (selected) return selected.client.uploadMedia(selected.mapping.app_id,file)
 return meta.uploadWhatsAppMedia(number.phone_number_id,file,await resolveWhatsAppAccessToken(number,{customerId}))
}
module.exports.uploadWorkspaceMedia = uploadWorkspaceMedia
