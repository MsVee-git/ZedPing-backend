const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { requireAdmin } = require('../middleware/auth')
const { sendTextMessage, sendTemplateMessage } = require('../lib/whatsapp')
const { transientRecipient, dedupeRecipients } = require('../lib/broadcastRecipients')
const { loadWorkspaceTemplates } = require('../lib/workspaceTemplates')
const { describeTemplate, resolveTemplateRecipients } = require('../lib/broadcastTemplates')
const { MetaTemplateError } = require('../lib/metaTemplates')

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
    ? await supabase.from('contacts').select('id,name,phone_number,email,custom_fields').eq('customer_id', workspace).in('id', ids)
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
  const { data: links, error: linkError } = await supabase.from('contact_group_members').select('contact_id').eq('group_id', group.id)
  if (linkError) throw linkError
  const ids = [...new Set((links || []).map((item) => item.contact_id).filter(Boolean))]
  if (!ids.length) return { group, recipients: [] }
  const { data: contacts, error: contactError } = await supabase.from('contacts')
    .select('id,name,phone_number,email,custom_fields').eq('customer_id', workspace).in('id', ids)
  if (contactError) throw contactError
  return { group, recipients: dedupeRecipients(contacts || []) }
}

function fail(res, error) {
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
  const resolved = resolveTemplateRecipients(template, audience.recipients, body?.variable_mappings)
  return { number, group: audience.group, ...resolved, total_selected: audience.recipients.length, eligible_recipients: resolved.recipients.length, skipped_recipients: resolved.unresolved.length }
}

router.get('/setup', requireAdmin, async (req, res) => {
  try {
    const [{ data: numbers, error: numbersError }, { data: groups, error: groupsError }] = await Promise.all([
      supabase.from('whatsapp_numbers').select('id,phone_number_id,display_name,status').eq('customer_id', req.workspace.customerId).eq('status', 'connected').order('created_at'),
      supabase.from('contact_groups').select('id,name,description,total_contacts').eq('customer_id', req.workspace.customerId).order('name')
    ])
    if (numbersError || groupsError) throw numbersError || groupsError
    res.json({ numbers: numbers || [], groups: groups || [] })
  } catch (_) { res.status(500).json({ error: 'Could not load broadcast setup.' }) }
})

router.get('/templates', requireAdmin, async (req, res) => {
  try {
    const number = await numberFor(req.workspace.customerId, req.query.whatsapp_number_id)
    if (!number) return res.status(404).json({ error: 'Choose a connected WhatsApp number in the active workspace.' })
    const catalog = await loadWorkspaceTemplates(req.workspace.customerId, number.id)
    if (catalog.kind !== 'ok') return res.status(409).json({ error: 'Templates are unavailable for this WhatsApp number.' })
    res.json({ connection: { id: number.id, display_name: number.display_name || null, phone_number_id: number.phone_number_id }, templates: catalog.templates.map(describeTemplate) })
  } catch (error) { fail(res, error) }
})

router.post('/review-template', requireAdmin, async (req, res) => {
  try {
    const review = await templateReview(req.workspace.customerId, req.body || {})
    if (review.error) return res.status(review.status || 400).json({ error: review.error })
    res.json({ sending_number: { id: review.number.id, display_name: review.number.display_name || null, phone_number_id: review.number.phone_number_id }, audience: { id: review.group.id, name: review.group.name }, template: review.template, variable_mappings: review.mappings, total_selected: review.total_selected, eligible_recipients: review.eligible_recipients, skipped_recipients: review.skipped_recipients, unresolved: review.unresolved.map((item) => ({ reason: item.reason })) })
  } catch (error) { fail(res, error) }
})

router.post('/send-template', requireAdmin, async (req, res) => {
  try {
    // The review is repeated at this boundary. Browser state is never a grant.
    const review = await templateReview(req.workspace.customerId, req.body || {})
    if (review.error) return res.status(review.status || 400).json({ error: review.error })
    if (!review.eligible_recipients) return res.status(400).json({ error: 'No recipients can receive this template.' })
    if (review.skipped_recipients) return res.status(400).json({ error: 'Resolve all required template values before sending.' })
    const { data: activity, error: activityError } = await supabase.from('scheduled_broadcasts').insert({ customer_id: req.workspace.customerId, broadcast_name: String(req.body?.broadcast_name || review.template.name).trim().slice(0, 160) || review.template.name, contacts: review.recipients.map(({ id, name, phone_number }) => ({ id, name, phone_number })), message: '[Template] ' + review.template.name + ' (' + review.template.language + ')', phone_number_id: review.number.phone_number_id, scheduled_at: new Date().toISOString(), status: 'sending' }).select().single()
    if (activityError) throw activityError
    const results = []
    for (const recipient of review.recipients) {
      try {
        const metaResult = await sendTemplateMessage(review.number.phone_number_id, recipient.phone_number, { name: review.template.name, language: review.template.language, components: recipient.template_components }, review.number.access_token)
        await supabase.from('messages').insert({ customer_id: req.workspace.customerId, whatsapp_number_id: review.number.id, direction: 'outbound', to_number: recipient.phone_number, message_body: '[Template] ' + review.template.name + ' (' + review.template.language + ')', status: 'sent', meta_message_id: metaResult?.messages?.[0]?.id || null, contact_id: recipient.id || null })
        results.push({ status: 'sent' })
      } catch (_) { results.push({ status: 'failed' }) }
    }
    const accepted = results.filter((item) => item.status === 'sent').length
    const failed = results.length - accepted
    await supabase.from('scheduled_broadcasts').update({ status: accepted ? 'completed' : 'failed', sent_count: accepted, failed_count: failed, completed_at: new Date().toISOString() }).eq('id', activity.id).eq('customer_id', req.workspace.customerId)
    res.json({ success: true, activity_id: activity.id, accepted, failed })
  } catch (error) { fail(res, error) }
})

router.post('/send', requireAdmin, async (req, res) => {
  const { contacts, message, phoneNumberId } = req.body || {}
  if (!Array.isArray(contacts) || !String(message || '').trim()) return res.status(400).json({ error: 'contacts and message required' })
  try {
    const number = await numberFor(req.workspace.customerId, phoneNumberId)
    if (!number) return res.status(404).json({ error: 'Connected WhatsApp number not found' })
    const resolved = await recipientsForWorkspace(req.workspace.customerId, contacts)
    if (resolved.error) return res.status(resolved.status || 400).json({ error: resolved.error })
    const body = String(message).trim()
    const { data: activity, error } = await supabase.from('scheduled_broadcasts').insert({ customer_id: req.workspace.customerId, broadcast_name: String(req.body.broadcast_name || 'Immediate Broadcast').trim().slice(0, 160) || 'Immediate Broadcast', contacts: resolved.recipients, message: body, phone_number_id: number.phone_number_id, scheduled_at: new Date().toISOString(), status: 'sending' }).select().single()
    if (error) throw error
    const results = []
    for (const contact of resolved.recipients) {
      try { await sendTextMessage(number.phone_number_id, contact.phone_number, body, number.access_token); results.push({ status: 'sent' }) } catch (_) { results.push({ status: 'failed' }) }
    }
    const accepted = results.filter((item) => item.status === 'sent').length
    const failed = results.length - accepted
    await supabase.from('scheduled_broadcasts').update({ status: accepted ? 'completed' : 'failed', sent_count: accepted, failed_count: failed, completed_at: new Date().toISOString() }).eq('id', activity.id).eq('customer_id', req.workspace.customerId)
    res.json({ success: true, activity_id: activity.id, accepted, failed })
  } catch (_) { res.status(502).json({ error: 'Broadcast could not be sent' }) }
})

router.get('/scheduled', async (req, res) => {
  const { data, error } = await supabase.from('scheduled_broadcasts').select('*').eq('customer_id', req.workspace.customerId).order('scheduled_at')
  if (error) return res.status(500).json({ error: 'Could not load broadcast activity.' })
  res.json(data)
})

module.exports = router

