const { loadGroupLinks, loadWorkspaceContacts, loadAllWorkspaceContacts } = require('../lib/groupAudience')
const { campaignMessages, recipientReport, rejectionCode, retryCampaignMessage, legacyTemplateIdentity } = require('../lib/broadcastRetry')
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
const { transientRecipient, dedupeRecipients, normalizePhone } = require('../lib/broadcastRecipients')
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

async function audienceForAllContacts(workspace) {
  const contacts = await loadAllWorkspaceContacts(supabase, workspace,
    'id,name,phone_number,email,custom_fields,marketing_opted_out')
  return {
    audience: { type: 'all_contacts', name: 'All contacts' },
    recipients: dedupeRecipients(contacts || [])
  }
}

async function broadcastAudience(workspace, body) {
  if (body?.audience_type === 'all_contacts') return audienceForAllContacts(workspace)
  const groupAudience = await audienceForGroup(workspace, body?.contact_group_id)
  if (groupAudience.error) return groupAudience
  return {
    audience: { type: 'contact_group', id: groupAudience.group.id, name: groupAudience.group.name },
    recipients: groupAudience.recipients
  }
}

function fail(res, error) {
  console.error('Broadcast preparation failed', { code: error?.code || null, type: error?.name || 'Error' })
  if (res.headersSent) return
  if (error instanceof MetaTemplateError) return res.status(400).json({ error: error.message })
  return res.status(502).json({ error: 'Broadcast details could not be prepared. Please try again.' })
}

async function templateReview(workspace, body, snapshot = null) {
  const number = await numberFor(workspace, body?.whatsapp_number_id)
  if (!number) return { error: 'Choose a connected WhatsApp number in the active workspace.', status: 404 }
  const audience = snapshot ? { audience: {type: 'scheduled_snapshot'}, recipients: snapshot } : await broadcastAudience(workspace, body)
  if (audience.error) return audience
  const catalog = await loadWorkspaceTemplates(workspace, number.id)
  if (catalog.kind !== 'ok') return { error: 'Templates are unavailable for this WhatsApp number.', status: 409 }
  const template = catalog.templates.find((item) => String(item.id) === String(body?.template_id || ''))
  if (!template) return { error: 'This template is not available for the selected WhatsApp business.', status: 403 }
  const marketing = await filterWorkspaceMarketingRecipients(supabase, workspace, audience.recipients)
  const resolved = resolveTemplateRecipients(template, marketing.eligible, body?.variable_mappings)
  return { number, audience: audience.audience, ...resolved, total_selected: audience.recipients.length, eligible_recipients: resolved.recipients.length, opted_out_recipients: marketing.optedOut.length, suppressed: marketing.optedOut.map(({ id, name, phone_number }) => ({ id, name, phone_number })), skipped_recipients: resolved.unresolved.length }
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
    res.json({ sending_number: publicConnection(review.number), audience: review.audience, template: review.template, variable_mappings: review.mappings, total_selected: review.total_selected, eligible_recipients: review.eligible_recipients, opted_out_recipients: review.opted_out_recipients, suppressed: review.suppressed, skipped_recipients: review.skipped_recipients, unresolved: review.unresolved.map((item) => ({ reason: item.reason })) })
  } catch (error) { fail(res, error) }
})

async function sendTemplateBroadcast(req, res) {
  let activeActivity = null
  const results = []
  try {
    // The review is repeated at this boundary. Browser state is never a grant.
    const review = await templateReview(req.workspace.customerId, req.body || {}, req.scheduledRecipients)
    if (review.error) return res.status(review.status || 400).json({ error: review.error })
    if (!review.eligible_recipients) return res.status(400).json({ error: 'No recipients can receive this template.' })
    if (review.skipped_recipients) return res.status(400).json({ error: 'Resolve all required template values before sending.' })
    const mediaType = review.template.header_media_type
    if (mediaType && !['image', 'document', 'text'].includes(mediaType)) return res.status(400).json({ error: 'This header format is not supported yet.' })
    const needsMedia = ['image', 'document'].includes(mediaType)
    if (needsMedia) req.file = validateTemplateHeaderMedia(req.file, mediaType)
    if (!needsMedia && req.file) return res.status(400).json({ error: 'This template does not use header media.' })
    if (req.body?.scheduled_at && !req.scheduledActivity) {
      return await require('../lib/campaignScheduler').saveScheduledCampaign({db:supabase,req,res,review})
    }
    const mediaId = needsMedia ? await uploadWorkspaceMedia({number:review.number,customerId:req.workspace.customerId,file:req.file}) : null
    const { data: activity, error: activityError } = req.scheduledActivity ? {data:req.scheduledActivity} : await supabase.from('scheduled_broadcasts').insert({ customer_id: req.workspace.customerId, broadcast_name: String(req.body?.broadcast_name || review.template.name).trim().slice(0, 160) || review.template.name, contacts: review.recipients.map(({ id, name, phone_number }) => ({ id, name, phone_number })), message: '[Template] ' + review.template.name + ' (' + review.template.language + ')', phone_number_id: review.number.phone_number_id, scheduled_at: new Date().toISOString(), status: 'sending' }).select().single()
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
      const template = { name: review.template.name, language: review.template.language, components: recipient.template_components,
        ...(mediaId ? { headerMedia: { type: mediaType, id: mediaId } } : {}) }
      const record = {
        customer_id: req.workspace.customerId, whatsapp_number_id: review.number.id, direction: 'outbound',
        to_number: recipient.phone_number, message_body: renderedTemplatePreview(review.template, recipient.template_components),
        broadcast_id: activity.id, contact_id: recipient.id || null,
        broadcast_send_spec: { to: recipient.phone_number, template, category: review.template.category }
      }
      let metaResult, rejected
      try {
        metaResult = await sendWorkspaceTemplate({number:review.number,customerId:req.workspace.customerId,to:recipient.phone_number,category:review.template.category,template})
      } catch (error) {
        rejected = { code: rejectionCode(error) }
      }
      const saved = await supabase.from('messages').insert({
        ...record, status: rejected ? 'failed' : 'accepted', meta_message_id: metaResult?.messages?.[0]?.id || null,
        broadcast_rejection_code: rejected?.code || null
      })
      if (saved.error) console.error('Broadcast message evidence could not be saved', { code: saved.error.code || null })
      results.push({ status: rejected ? 'failed' : 'sent' })
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
}

router.post('/send-template', requireAdmin, parseBroadcastUpload, sendTemplateBroadcast)
router.post('/scheduled/:id/cancel', requireAdmin, async (req,res) => {
  try {
    const {data,error}=await supabase.rpc('cancel_scheduled_campaign',{p_customer_id:req.workspace.customerId,p_id:req.params.id})
    if(error)throw error
    if(!data)return res.status(409).json({error:'This campaign has already started or is no longer scheduled.'})
    if(data.media_path)await supabase.storage.from('campaign-media').remove([data.media_path])
    res.json({success:true})
  } catch (_) {res.status(500).json({error:'Could not cancel the scheduled campaign.'})}
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
      const record = {
        customer_id: req.workspace.customerId, whatsapp_number_id: number.id, direction: 'outbound',
        to_number: contact.phone_number, message_body: body, broadcast_id: activity.id, contact_id: contact.id || null,
        broadcast_send_spec: { to: contact.phone_number, body }
      }
      let rejected
      let metaResult
      try {
        metaResult = await sendWorkspaceText({number,customerId:req.workspace.customerId,to:contact.phone_number,body})
      } catch (error) {
        rejected = { code: rejectionCode(error) }
      }
      const saved = await supabase.from('messages').insert({
        ...record, status: rejected ? 'failed' : 'accepted', meta_message_id: metaResult?.messages?.[0]?.id || null,
        broadcast_rejection_code: rejected?.code || null
      })
      if (saved.error) console.error('Broadcast message evidence could not be saved', { code: saved.error.code || null })
      results.push({ status: rejected ? 'failed' : 'sent' })
    }
    const accepted = results.filter((item) => item.status === 'sent').length
    const failed = results.length - accepted
    await supabase.from('scheduled_broadcasts').update({ status: accepted ? 'completed' : 'failed', sent_count: accepted, failed_count: failed, completed_at: new Date().toISOString() }).eq('id', activity.id).eq('customer_id', req.workspace.customerId)
    res.json({ success: true, activity_id: activity.id, accepted, failed, opted_out_recipients: marketing.optedOut.length })
  } catch (_) { res.status(502).json({ error: 'Broadcast could not be sent' }) }
})

router.get('/scheduled', async (req, res) => {
  const { data, error } = await supabase.from('scheduled_broadcasts').select('*').eq('customer_id', req.workspace.customerId).order('scheduled_at', {ascending:false})
  if (error) return res.status(500).json({ error: 'Could not load broadcast activity.' })
  res.json(data)
})

async function campaignFor(workspace, id) {
  const { data, error } = await supabase.from('scheduled_broadcasts')
    .select('id,broadcast_name,message,contacts,status,sent_count,failed_count,created_at,scheduled_at,completed_at,failure_reason')
    .eq('id', id).eq('customer_id', workspace).maybeSingle()
  if (error) throw error
  return data
}

router.post('/scheduled/:id/retry-failed', requireAdmin, async (req, res) => {
  const customerId = req.workspace.customerId
  try {
    const campaign = await campaignFor(customerId, req.params.id)
    if (!campaign) return res.status(404).json({ error: 'Broadcast not found.' })
    const rows = await campaignMessages(supabase, customerId, campaign.id)
    const { failures } = recipientReport(rows, campaign)
    const retryable = new Set(failures.filter(failure => failure.can_retry).map(failure => failure.id))
    if (!retryable.size) return res.status(409).json({ error: 'There are no failed numbers eligible for retry.' })

    const candidates = rows.filter(row => retryable.has(row.id))
    const { eligible } = await filterWorkspaceMarketingRecipients(supabase, customerId,
      candidates.map(row => ({ id: row.id, phone_number: row.to_number })))
    const eligibleIds = new Set(eligible.map(row => row.id))
    const contactIds = [...new Set(candidates.map(row => row.contact_id).filter(Boolean))]
    const contacts = await loadWorkspaceContacts(supabase, customerId, contactIds, 'id,phone_number,marketing_opted_out')
    const currentContacts = new Map(contacts.map(contact => [contact.id, contact]))
    const connections = new Map()
    const legacyTemplates = new Map()
    const targets = []
    for (const row of candidates) {
      if (!eligibleIds.has(row.id)) continue
      const contact = currentContacts.get(row.contact_id)
      if (row.contact_id && (!contact || contact.marketing_opted_out || normalizePhone(contact.phone_number) !== normalizePhone(row.to_number))) continue
      if (!connections.has(row.whatsapp_number_id)) connections.set(row.whatsapp_number_id, await numberFor(customerId, row.whatsapp_number_id))
      const number = connections.get(row.whatsapp_number_id)
      if (!number) continue
      let spec = row.broadcast_send_spec
      if (!spec) {
        const identity = legacyTemplateIdentity(campaign.message)
        if (!identity) spec = { body: campaign.message }
        else {
          if (!legacyTemplates.has(number.id)) {
            const catalog = await loadWorkspaceTemplates(customerId, number.id)
            const match = catalog.kind === 'ok' && catalog.templates.find(item => item.name === identity.name && item.language === identity.language)
            legacyTemplates.set(number.id, match ? describeTemplate(match) : null)
          }
          const template = legacyTemplates.get(number.id)
          if (!template?.sendable || template.variables.length || (template.header_media_type && template.header_media_type !== 'text')
            || renderedTemplatePreview(template, []) !== row.message_body) continue
          spec = { template: { ...identity, components: [] }, category: template.category }
        }
      }
      targets.push({ row, number, spec })
    }
    if (!targets.length) return res.status(409).json({ error: 'No failed numbers can be retried with the current contact consent, connection or original template details.' })
    res.status(202).json({ queued: targets.length, skipped: candidates.length - targets.length })
    for (const { row, number, spec } of targets) {
      const send = { number, customerId, to: row.to_number }
      try {
        await retryCampaignMessage(supabase, campaign, row, () => spec.template
          ? sendWorkspaceTemplate({ ...send, template: spec.template, category: spec.category })
          : sendWorkspaceText({ ...send, body: spec.body }))
      } catch (error) {
        console.error('Broadcast retry could not be recorded', { code: error?.code || null })
      }
    }
  } catch (error) { fail(res, error) }
})

router.get('/scheduled/:id', async (req, res) => {
  try {
    const workspace = req.workspace.customerId
    const data = await campaignFor(workspace, req.params.id)
    if (!data) return res.status(404).json({ error: 'Broadcast not found.' })
    const { contacts, ...broadcast } = data
    const rows = await campaignMessages(supabase, workspace, data.id)
    const { delivery, failures, pending } = recipientReport(rows, data)
    const canManage = ['owner', 'admin'].includes(req.workspace.role)
    res.set('Cache-Control','no-store')
    res.json({ ...broadcast, delivery, failed_recipients: canManage ? failures : undefined,
      pending_recipients: canManage ? pending : undefined,
      recorded_recipients: Array.isArray(contacts) ? contacts.length : null })
  } catch (_) { res.status(500).json({ error: 'Could not load broadcast details.' }) }
})

module.exports = router
module.exports.sendTemplateBroadcast = sendTemplateBroadcast
