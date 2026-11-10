const { randomUUID } = require('node:crypto')
const { normalizePhone } = require('./broadcastRecipients')
const { initialDelivery, addDelivery } = require('./deliveryMetrics')

const TRANSIENT = new Set([4, 130429, 131000, 131016, 131056, 131057, 133004])
const MARKETING_LIMIT = 131049

function rejectionCode(error) {
  const status = error?.response?.status
  const code = Number(error?.response?.data?.error?.code)
  return status >= 400 && status < 500 && Number.isSafeInteger(code) && code > 0 ? code : null
}

function failureFor(row) {
  const receipts = row.delivery_receipts || {}
  if (row.status !== 'failed' || receipts.read_at || receipts.delivered_at) return null
  const codes = (receipts.errors || []).map(error => Number(error.code)).filter(Boolean)
  if (!codes.length && row.broadcast_rejection_code) codes.push(row.broadcast_rejection_code)
  if (codes.includes(MARKETING_LIMIT)) return { code: MARKETING_LIMIT, reason: 'WhatsApp marketing limit. An immediate retry is unlikely to work.' }
  if (codes.length && codes.every(code => TRANSIENT.has(code))) {
    return { code: codes[0], reason: 'Temporary WhatsApp failure.', temporary: true }
  }
  if (codes.includes(131026)) return { code: 131026, reason: 'WhatsApp could not deliver. Verify the number with the recipient.' }
  return { code: codes[0] || null, reason: codes.length ? 'WhatsApp rejected this message.' : 'Failure reason unavailable. Check the recipient before resending.' }
}

const fields = 'id,customer_id,whatsapp_number_id,contact_id,to_number,message_body,direction,status,delivery_receipts,broadcast_send_spec,broadcast_rejection_code,broadcast_retry_id'

async function campaignMessages(db, customerId, campaignId) {
  const messages = []
  let cursor
  while (true) {
    let query = db.from('messages').select(fields)
      .eq('customer_id', customerId).eq('broadcast_id', campaignId).eq('direction', 'outbound')
      .order('id').limit(500)
    if (cursor) query = query.gt('id', cursor)
    const { data, error } = await query
    if (error) throw error
    messages.push(...data)
    if (data.length < 500) return messages
    const next = data.at(-1).id
    if (!next || next === cursor || messages.length > 250000) throw new Error('Campaign pagination limit')
    cursor = next
  }
}

function recipientReport(rows, campaign) {
  const delivery = rows.length ? { ...initialDelivery(), linked_messages: rows.length } : null
  const byId = new Map(rows.map(row => [row.id, row]))
  const retryIds = new Set(rows.map(row => row.broadcast_retry_id).filter(Boolean))
  const originals = rows.filter(row => !retryIds.has(row.id))
  const excludedPhones = new Set(originals.filter(row => row.broadcast_retry_id || !failureFor(row)).map(row => normalizePhone(row.to_number)).filter(Boolean))
  const failures = []
  const pending = []
  const retryablePhones = new Set()
  const finished = ['completed', 'failed'].includes(campaign.status)
  for (const original of originals) {
    const retry = byId.get(original.broadcast_retry_id)
    const row = original.delivery_receipts?.delivered_at || original.delivery_receipts?.read_at ? original : retry || original
    const failure = failureFor(row)
    addDelivery(delivery, original.broadcast_retry_id && !retry && failure ? { direction: 'outbound', status: 'sent' } : row)
    if (!failure) {
      if (row.to_number && !row.delivery_receipts?.delivered_at && !row.delivery_receipts?.read_at) {
        pending.push({ id: original.id, phone: row.to_number,
          reason: retry ? 'Retry submitted. Waiting for WhatsApp delivery confirmation.' : 'WhatsApp delivery is unconfirmed.' })
      }
      continue
    }
    const phone = normalizePhone(original.to_number)
    const spec = original.broadcast_send_spec
    const legacyText = !spec && !campaign.message?.startsWith('[Template] ') && original.message_body === campaign.message
    const legacyTemplate = !spec && Boolean(original.message_body && legacyTemplateIdentity(campaign.message))
    const canRetry = Boolean(finished && failure.temporary && phone && !excludedPhones.has(phone)
      && !retryablePhones.has(phone) && original.whatsapp_number_id && !original.broadcast_retry_id
      && (spec ? normalizePhone(spec.to) === phone : legacyText || legacyTemplate))
    if (canRetry) retryablePhones.add(phone)
    if (original.broadcast_retry_id && !retry) {
      pending.push({ id: original.id, phone: original.to_number, reason: 'Retry requested. Waiting for confirmation.' })
      continue
    }
    failures.push({
      id: original.id, phone: original.to_number, code: failure.code, can_retry: canRetry,
      reason: original.broadcast_retry_id
        ? 'Still failed after retry. ' + failure.reason
        : failure.temporary && !spec && !legacyText
          ? legacyTemplate ? 'Temporary failure. Retry requires the original approved template to match.' : 'Temporary failure. The original send details were not saved.'
          : failure.reason
    })
  }
  return { delivery, failures, pending }
}

function legacyTemplateIdentity(message) {
  const match = /^\[Template\] ([a-z0-9_]+) \(([a-zA-Z_]+)\)$/.exec(message || '')
  return match ? { name: match[1], language: match[2] } : null
}

async function retryCampaignMessage(db, campaign, original, send) {
  const retryId = randomUUID()
  const claimed = await db.from('messages').update({ broadcast_retry_id: retryId })
    .eq('customer_id', original.customer_id).eq('broadcast_id', campaign.id).eq('id', original.id)
    .eq('status', 'failed').is('broadcast_retry_id', null).select('id,status').maybeSingle()
  if (claimed.error) throw claimed.error
  if (claimed.data?.status !== 'failed') return 'skipped'

  const retry = {
    id: retryId, customer_id: original.customer_id, broadcast_id: campaign.id,
    whatsapp_number_id: original.whatsapp_number_id, contact_id: original.contact_id,
    direction: 'outbound', to_number: original.to_number, message_body: original.message_body
  }
  let messageId, code
  try {
    const result = await send()
    messageId = result?.messages?.[0]?.id
  } catch (error) {
    code = rejectionCode(error)
  }
  // An uncertain submission stays claimed. A second click cannot resend it.
  if (!messageId && !code) return 'unconfirmed'
  const saved = await db.from('messages').insert({
    ...retry, status: messageId ? 'accepted' : 'failed', meta_message_id: messageId || null,
    broadcast_rejection_code: code || null
  })
  if (saved.error) throw saved.error
  return messageId ? 'accepted' : 'failed'
}

module.exports = { campaignMessages, recipientReport, rejectionCode, retryCampaignMessage, legacyTemplateIdentity }
