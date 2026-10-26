const { loadGroupLinks, loadWorkspaceContacts } = require('../lib/groupAudience')
const { initialDelivery, addDelivery } = require('../lib/deliveryMetrics')
const { sendWorkspaceText, sendWorkspaceTemplate, uploadWorkspaceMedia } = require('../lib/whatsappRuntime')
const multer = require('multer')
const { validateTemplateHeaderMedia } = require('../lib/templateMedia')
const mediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } })
function parseBroadcastUpload(req, res, next) {
 mediaUpload.single('header_media')(req, res, error => {
  if (error) return res.status(400).json({ error: 'Select one header file up to 10 MB.' })
  if (typeof req.body?.variable_mappings === 'string') {
   try { req.body.variable_mappings = JSON.parse(req.body.variable_mappings) } catch { return res.status(400).json({ error: 'Invalid template variable mappings.' }) }
  }
  next()
 })
}
const { resolveWhatsAppAccessToken } = require('../lib/whatsappCredentials')
const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { requireAdmin } = require('../middleware/auth')
const { sendTextMessage, sendTemplateMessage, uploadWhatsAppMedia } = require('../lib/whatsapp')
const { transientRecipient, dedupeRecipients } = require('../lib/broadcastRecipients')
const { loadWorkspaceTemplates } = require('../lib/workspaceTemplates')
const { describeTemplate, resolveTemplateRecipients, renderedTemplatePreview } = require('../lib/broadcastTemplates')
const { MetaTemplateError } = require('../lib/metaTemplates')
const { filterWorkspaceMarketingRecipients } = require('../lib/marketingOptOut')

// The Meta Phone Number ID is an API identifier, never a customer-facing
// telephone number. Keep it internal and derive display data from the
// canonical connected-number record instead.
function displayPhoneNumber(number) {
  const raw = String(number?.phone_number || '').trim()
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  if (!digits) return null
  // Make the existing Zambian canonical format easy to scan without changing
  // storage. Other connected international numbers still retain their E.164
  // representation rather than being confused with a Meta ID.
  if (digits.length === 12 && digits.startsWith('260')) return `+260 ${digits.slice(3, 6)} ${digits.slice(6, 9)} ${digits.slice(9)}`
  return raw.startsWith('+') ? raw : `+${digits}`
}

function publicConnection(number) {
  return {
    id: number.id,
    display_name: number.display_name || null,
    display_phone_number: displayPhoneNumber(number)
  }
}

async function numberFor(workspace, id) {
  if (!id || typeof id !== 'string') return null
  const { data, error } = await supabase.from('whatsapp_numbers').select('*')
    .eq('customer_id', workspace).eq('id', id).eq('status', 'connected').maybeSingle()
  return error ? null : data
}

async function recipientsForWorkspace(workspace, requested) {
  if (!Array.isArray(requested) || !requested.length) return { error: 'At least one recipient is required' }
  const ids = [...new Set(requested.map((item) => item?.id).filter(Boolean))]
  const { data: saved = [], error } = ids.length
    ? await supabase.from('contacts').select('id,name,phone_number,email,custom_fields,marketing_opted_out').eq('customer_id', workspace).in('id', ids)
    : { data: [], error: null }
  if (error) throw error
  if (saved.length !== ids.length) return { error: 'One or more contacts do not belong to this workspace', status: 403 }
  const transient = []
  for (const contact of requested.filter((item) => !item?.id)) {
    const normalized = transientRecipient(contact)
    if (!normalized) return { error: 'One or more phone numbers are invalid' }
    transient.push(normalized)
  }
  return { recipients: dedupeRecipients([...saved, ...transient]) }
}

async function audienceForGroup(workspace, groupId) {
  if (!groupId || typeof groupId !== 'string') return { error: 'Choose a contact group.' }
  const { data: group, error: groupError } = await supabase.from('contact_groups')
    .select('id,name,description,total_contacts').eq('id', groupId).eq('customer_id', workspace).maybeSingle()
  if (groupError) throw groupError
  if (!group) return { error: 'This contact group is not available in the active workspace.', status: 403 }
  const links = await loadGroupLinks(supabase, group.id)
  const ids = [...new Set(links.map((item) => item.contact_id).filter(Boolean))]
  if (!ids.length) return { group, recipients: [] }
  const contacts = await loadWorkspaceContacts(supabase, workspace, ids,
    'id,name,phone_number,email,custom_fields,marketing_opted_out')
  return { group, recipients: dedupeRecipients(contacts || []) }
}

function fail(res, error) {
  console.error('Broadcast preparation failed', { code: error?.code || null, type: error?.name || 'Error' })
  if (res.headersSent) return
  if (error instanceof MetaTemplateError) return res.status(400).json({ error: error.message })
  return res.status(502).json({ error: 'Broadcast details could not be prepared. Please try again.' })
}

async function templateReview(workspace, body) {
  const number = await numberFor(workspace, body?.whatsapp_number_id)
  if (!number) return { error: 'Choose a connected WhatsApp number in the active workspace.', status: 404 }
  const audience = await audienceForGroup(workspace, body?.contact_group_id)
  if (audience.error) return audience
  const catalog = await loadWorkspaceTemplates(workspace, number.id)
  if (catalog.kind !== 'ok') return { error: 'Templates are unavailable for this WhatsApp number.', status: 409 }
  const template = catalog.templates.find((item) => String(item.id) === String(body?.template_id || ''))
  if (!template) return { error: 'This template is not available for the selected WhatsApp business.', status: 403 }
  const marketing = await filterWorkspaceMarketingRecipients(supabase, workspace, audience.recipients)
  const resolved = resolveTemplateRecipients(template, marketing.eligible, body?.variable_mappings)
  return { number, group: audience.group, ...resolved, total_selected: audience.recipients.length, eligible_recipients: resolved.recipients.length, opted_out_recipients: marketing.optedOut.length, suppressed: marketing.optedOut.map(({ id, name, phone_number }) => ({ id, name, phone_number })), skipped_recipients: resolved.unresolved.length }
}

router.get('/setup', requireAdmin, async (req, res) => {
  try {
    const [{ data: numbers, error: numbersError }, { data: groups, error: groupsError }] = await Promise.all([
      supabase.from('whatsapp_numbers').select('id,phone_number,phone_number_id,display_name,status').eq('customer_id', req.workspace.customerId).eq('status', 'connected').order('created_at'),
      supabase.from('contact_groups').select('id,name,description,total_contacts').eq('customer_id', req.workspace.customerId).order('name')
    ])
    if (numbersError || groupsError) throw numbersError || groupsError
    res.json({ numbers: (numbers || []).map(publicConnection), groups: groups || [] })
  } catch (_) { res.status(500).json({ error: 'Could not load broadcast setup.' }) }
})

router.get('/templates', requireAdmin, async (req, res) => {
  try {
    const number = await numberFor(req.workspace.customerId, req.query.whatsapp_number_id)
    if (!number) return res.status(404).json({ error: 'Choose a connected WhatsApp number in the active workspace.' })
    const catalog = await loadWorkspaceTemplates(req.workspace.customerId, number.id)
    if (catalog.kind !== 'ok') return res.status(409).json({ error: 'Templates are unavailable for this WhatsApp number.' })
    res.json({ connection: publicConnection(number), templates: catalog.templates.map(describeTemplate) })
  } catch (error) { fail(res, error) }
})

router.post('/review-template', requireAdmin, async (req, res) => {
  try {
    const review = await templateReview(req.workspace.customerId, req.body || {})
    if (review.error) return res.status(review.status || 400).json({ error: review.error })
    res.json({ sending_number: publicConnection(review.number), audience: { id: review.group.id, name: review.group.name }, template: review.template, variable_mappings: review.mappings, total_selected: review.total_selected, eligible_recipients: review.eligible_recipients, opted_out_recipients: review.opted_out_recipients, suppressed: review.suppressed, skipped_recipients: review.skipped_recipients, unresolved: review.unresolved.map((item) => ({ reason: item.reason })) })
  } catch (error) { fail(res, error) }
})

router.post('/send-template', requireAdmin, parseBroadcastUpload, async (req, res) => {
  let activeActivity = null
  const results = []
  try {
    // The review is repeated at this boundary. Browser state is never a grant.
    const review = await templateReview(req.workspace.customerId, req.body || {})
    if (review.error) return res.status(review.status || 400).json({ error: review.error })
    if (!review.eligible_recipients) return res.status(400).json({ error: 'No recipients can receive this template.' })
    if (review.skipped_recipients) return res.status(400).json({ error: 'Resolve all required template values before sending.' })
    const mediaType = review.template.header_media_type
    if (mediaType && !['image', 'document', 'text'].includes(mediaType)) return res.status(400).json({ error: 'This header format is not supported yet.' })
    const needsMedia = ['image', 'document'].includes(mediaType)
    if (needsMedia) req.file = validateTemplateHeaderMedia(req.file, mediaType)
    if (!needsMedia && req.file) return res.status(400).json({ error: 'This template does not use header media.' })
    const mediaId = needsMedia ? await uploadWorkspaceMedia({number:review.number,customerId:req.workspace.customerId,file:req.file}) : null
    const { data: activity, error: activityError } = await supabase.from('scheduled_broadcasts').insert({ customer_id: req.workspace.customerId, broadcast_name: String(req.body?.broadcast_name || review.template.name).trim().slice(0, 160) || review.template.name, contacts: review.recipients.map(({ id, name, phone_number }) => ({ id, name, phone_number })), message: '[Template] ' + review.template.name + ' (' + review.template.language + ')', phone_number_id: review.number.phone_number_id, scheduled_at: new Date().toISOString(), status: 'sending' }).select().single()
    if (activityError) throw activityError
    activeActivity = activity
    // Persist the campaign before acknowledging it. The same server-side loop
    // continues; the browser follows the saved record instead of holding a
    // multi-minute HTTP request open. Older clients retain the final response.
    if (req.headers?.prefer === 'respond-async') {
      res.status(202).json({ success: true, status: 'sending', activity_id: activity.id,
        total_recipients: review.recipients.length, opted_out_recipients: review.opted_out_recipients })
    }
    for (const recipient of review.recipients) {
      try {
        const metaResult = await sendWorkspaceTemplate({number:review.number,customerId:req.workspace.customerId,to:recipient.phone_number,category:review.template.category,template:{ name: review.template.name, language: review.template.language, components: recipient.template_components, ...(mediaId ? { headerMedia: { type: mediaType, id: mediaId } } : {}) }})
        await supabase.from('messages').insert({ customer_id: req.workspace.customerId, whatsapp_number_id: review.number.id, direction: 'outbound', to_number: recipient.phone_number, message_body: renderedTemplatePreview(review.template, recipient.template_components), status: 'accepted', broadcast_id: activity.id, meta_message_id: metaResult?.messages?.[0]?.id || null, contact_id: recipient.id || null })
        results.push({ status: 'sent' })
      } catch (_) {
        await supabase.from('messages').insert({customer_id:req.workspace.customerId,whatsapp_number_id:review.number.id,direction:'outbound',broadcast_id:activity.id,to_number:recipient.phone_number,status:'failed'})
        results.push({ status: 'failed' })
      }
      if (results.length % 5 === 0) {
        const acceptedSoFar = results.filter(item => item.status === 'sent').length
        try {
          const progress = await supabase.from('scheduled_broadcasts')
            .update({ sent_count: acceptedSoFar, failed_count: results.length - acceptedSoFar })
            .eq('id', activity.id).eq('customer_id', req.workspace.customerId)
          if (progress.error) console.error('Broadcast progress update failed', { code: progress.error.code || null })
        } catch (_) { console.error('Broadcast progress update unavailable') }
      }
    }
    const accepted = results.filter((item) => item.status === 'sent').length
    const failed = results.length - accepted
    await supabase.from('scheduled_broadcasts').update({ status: accepted ? 'completed' : 'failed', sent_count: accepted, failed_count: failed, completed_at: new Date().toISOString() }).eq('id', activity.id).eq('customer_id', req.workspace.customerId)
    if (!res.headersSent) res.json({ success: true, activity_id: activity.id, accepted, failed, opted_out_recipients: review.opted_out_recipients })
  } catch (error) {
    // Never turn a post-acknowledgement processing error into a second HTTP
    // response, and never retry provider sends after an uncertain outcome.
    if (activeActivity) {
      try {
        const accepted = results.filter(item => item.status === 'sent').length
        await supabase.from('scheduled_broadcasts').update({ status: 'failed',
          sent_count: accepted, failed_count: results.length - accepted,
          completed_at: new Date().toISOString() })
          .eq('id', activeActivity.id).eq('customer_id', req.workspace.customerId)
      } catch (_) { console.error('Broadcast failure status could not be saved') }
    }
    fail(res, error)
  }
})

router.post('/send', requireAdmin, async (req, res) => {
  const { contacts, message, phoneNumberId } = req.body || {}
  if (!Array.isArray(contacts) || !String(message || '').trim()) return res.status(400).json({ error: 'contacts and message required' })
  try {
    const number = await numberFor(req.workspace.customerId, phoneNumberId)
    if (!number) return res.status(404).json({ error: 'Connected WhatsApp number not found' })
    const resolved = await recipientsForWorkspace(req.workspace.customerId, contacts)
    if (resolved.error) return res.status(resolved.status || 400).json({ error: resolved.error })
    const marketing = await filterWorkspaceMarketingRecipients(supabase, req.workspace.customerId, resolved.recipients)
    if (!marketing.eligible.length) return res.status(400).json({ error: 'No recipients can receive this broadcast.', opted_out_recipients: marketing.optedOut.length })
    const body = String(message).trim()
    const { data: activity, error } = await supabase.from('scheduled_broadcasts').insert({ customer_id: req.workspace.customerId, broadcast_name: String(req.body.broadcast_name || 'Immediate Broadcast').trim().slice(0, 160) || 'Immediate Broadcast', contacts: marketing.eligible, message: body, phone_number_id: number.phone_number_id, scheduled_at: new Date().toISOString(), status: 'sending' }).select().single()
    if (error) throw error
    const results = []
    for (const contact of marketing.eligible) {
      try {
        const metaResult = await sendWorkspaceText({number,customerId:req.workspace.customerId,to:contact.phone_number,body})
        await supabase.from('messages').insert({ customer_id: req.workspace.customerId, whatsapp_number_id: number.id, direction: 'outbound', to_number: contact.phone_number, message_body: body, status: 'accepted', broadcast_id: activity.id, meta_message_id: metaResult?.messages?.[0]?.id || null, contact_id: contact.id || null })
        results.push({ status: 'sent' })
      } catch (_) {
        await supabase.from('messages').insert({customer_id:req.workspace.customerId,whatsapp_number_id:number.id,direction:'outbound',broadcast_id:activity.id,to_number:contact.phone_number,status:'failed'})
        results.push({ status: 'failed' })
      }
    }
    const accepted = results.filter((item) => item.status === 'sent').length
    const failed = results.length - accepted
    await supabase.from('scheduled_broadcasts').update({ status: accepted ? 'completed' : 'failed', sent_count: accepted, failed_count: failed, completed_at: new Date().toISOString() }).eq('id', activity.id).eq('customer_id', req.workspace.customerId)
    res.json({ success: true, activity_id: activity.id, accepted, failed, opted_out_recipients: marketing.optedOut.length })
  } catch (_) { res.status(502).json({ error: 'Broadcast could not be sent' }) }
})

router.get('/scheduled', async (req, res) => {
  const { data, error } = await supabase.from('scheduled_broadcasts').select('*').eq('customer_id', req.workspace.customerId).order('scheduled_at')
  if (error) return res.status(500).json({ error: 'Could not load broadcast activity.' })
  res.json(data)
})

// Historical facts only: never join current contact consent or group membership.
router.get('/scheduled/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('scheduled_broadcasts')
      .select('id,broadcast_name,message,contacts,status,sent_count,failed_count,created_at,scheduled_at,completed_at')
      .eq('id', req.params.id).eq('customer_id', req.workspace.customerId).maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Broadcast not found.' })
    const { contacts, ...broadcast } = data
    let delivery = null;
    // Explicit campaign links only; no historical audience or text matching.
    let cursor = null, total = 0;
    while(true) {
      let query = supabase.from('messages').select('id,direction,status,delivery_receipts')
        .eq('customer_id',req.workspace.customerId).eq('broadcast_id',data.id).eq('direction','outbound')
        .order('id',{ascending:true}).limit(500);
      if(cursor)query=query.gt('id',cursor);
      const page=await query;
      if(page.error)throw page.error;
      const rows=page.data||[];
      if(!rows.length)break;
      total+=rows.length;
      if(total>250000)throw new Error('Campaign report too large');
      if(!delivery)delivery={...initialDelivery(),linked_messages:0};
      for(const row of rows){delivery.linked_messages++;addDelivery(delivery,row);}
      const next=rows[rows.length-1].id;
      if(!next||next===cursor)throw new Error('Campaign pagination did not advance');
      cursor=next;
    }
    res.set('Cache-Control','no-store');
    res.json({ ...broadcast, delivery, recorded_recipients: Array.isArray(contacts) ? contacts.length : null })
  } catch (_) { res.status(500).json({ error: 'Could not load broadcast details.' }) }
})

module.exports = router


