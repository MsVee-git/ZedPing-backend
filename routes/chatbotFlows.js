const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { requireAdmin } = require('../middleware/auth')
const { validateDefinition, simulateFlow } = require('../lib/chatbotRuntime')

function cleanName(value) {
  const name = String(value || '').trim()
  if (!name || name.length > 160) throw new Error('Flow name must be between 1 and 160 characters')
  return name
}

async function workspaceNumber(customerId, id) {
  const { data, error } = await supabase.from('whatsapp_numbers').select('id,customer_id,status')
    .eq('id', id).eq('customer_id', customerId).maybeSingle()
  if (error) throw error
  if (!data) throw new Error('Select a connected WhatsApp number from this workspace')
  return data
}

async function flowForWorkspace(customerId, id) {
  const { data, error } = await supabase.from('chatbot_flows').select('*')
    .eq('id', id).eq('customer_id', customerId).maybeSingle()
  if (error) throw error
  if (!data) throw new Error('Chatbot flow not found')
  return data
}

async function contentForDefinition(customerId, definition) {
  const ids = [...new Set((definition?.steps || []).filter((step) => step?.type === 'content').map((step) => step.content_library_item_id).filter(Boolean))]
  if (!ids.length) return new Map()
  const { data, error } = await supabase.from('content_library_items')
    .select('id,customer_id,content_type,archived_at').eq('customer_id', customerId).in('id', ids)
  if (error) throw error
  return new Map((data || []).map((item) => [item.id, item]))
}

async function checkedDefinition(customerId, definition) {
  return validateDefinition(definition, { contentItems: await contentForDefinition(customerId, definition) })
}

router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('chatbot_flows')
    .select('id,name,customer_id,whatsapp_number_id,is_active,lifecycle_status,current_published_version_id,created_at,updated_at,archived_at')
    .eq('customer_id', req.workspace.customerId).is('archived_at', null).order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: 'Unable to load chatbot flows' })
  res.json(data || [])
})

router.post('/', requireAdmin, async (req, res) => {
  try {
    const whatsappNumber = await workspaceNumber(req.workspace.customerId, req.body?.whatsapp_number_id)
    const draft = await checkedDefinition(req.workspace.customerId, req.body?.draft_definition)
    const { data, error } = await supabase.from('chatbot_flows').insert({
      customer_id: req.workspace.customerId, whatsapp_number_id: whatsappNumber.id, name: cleanName(req.body?.name),
      draft_definition: draft, draft_updated_at: new Date().toISOString(), lifecycle_status: 'draft', is_active: false
    }).select().single()
    if (error) throw error
    res.status(201).json(data)
  } catch (error) { res.status(400).json({ error: error.message || 'Unable to create chatbot flow' }) }
})

router.patch('/:id/draft', requireAdmin, async (req, res) => {
  try {
    const flow = await flowForWorkspace(req.workspace.customerId, req.params.id)
    if (flow.lifecycle_status === 'archived') throw new Error('Archived flows cannot be edited')
    const draft = await checkedDefinition(req.workspace.customerId, req.body?.draft_definition)
    const { data, error } = await supabase.from('chatbot_flows').update({
      name: req.body?.name === undefined ? flow.name : cleanName(req.body.name),
      draft_definition: draft, draft_updated_at: new Date().toISOString()
    }).eq('id', flow.id).eq('customer_id', req.workspace.customerId).select().single()
    if (error) throw error
    res.json(data)
  } catch (error) { res.status(400).json({ error: error.message || 'Unable to save chatbot draft' }) }
})

router.post('/:id/publish', requireAdmin, async (req, res) => {
  try {
    const flow = await flowForWorkspace(req.workspace.customerId, req.params.id)
    if (flow.lifecycle_status === 'archived') throw new Error('Archived flows cannot be published')
    await workspaceNumber(req.workspace.customerId, flow.whatsapp_number_id)
    const definition = await checkedDefinition(req.workspace.customerId, flow.draft_definition)
    const { data: latest, error: latestError } = await supabase.from('chatbot_flow_versions').select('version')
      .eq('flow_id', flow.id).order('version', { ascending: false }).limit(1).maybeSingle()
    if (latestError) throw latestError
    const { data: version, error: versionError } = await supabase.from('chatbot_flow_versions').insert({
      flow_id: flow.id, customer_id: req.workspace.customerId, whatsapp_number_id: flow.whatsapp_number_id,
      version: Number(latest?.version || 0) + 1, definition, entry_step_key: definition.entry_step_key, published_by: req.workspace.userId
    }).select().single()
    if (versionError) throw versionError
    const { data, error } = await supabase.from('chatbot_flows').update({
      current_published_version_id: version.id, lifecycle_status: 'published', is_active: true, updated_at: new Date().toISOString()
    }).eq('id', flow.id).eq('customer_id', req.workspace.customerId).select().single()
    if (error) throw error
    res.json({ flow: data, version: { id: version.id, version: version.version, published_at: version.published_at } })
  } catch (error) { res.status(400).json({ error: error.message || 'Unable to publish chatbot flow' }) }
})

router.post('/:id/pause', requireAdmin, async (req, res) => {
  try {
    const flow = await flowForWorkspace(req.workspace.customerId, req.params.id)
    const { data, error } = await supabase.from('chatbot_flows').update({ lifecycle_status: 'paused', is_active: false, updated_at: new Date().toISOString() })
      .eq('id', flow.id).eq('customer_id', req.workspace.customerId).select().single()
    if (error) throw error
    res.json(data)
  } catch (error) { res.status(400).json({ error: error.message || 'Unable to pause chatbot flow' }) }
})

router.post('/:id/archive', requireAdmin, async (req, res) => {
  try {
    const flow = await flowForWorkspace(req.workspace.customerId, req.params.id)
    const now = new Date().toISOString()
    const { data, error } = await supabase.from('chatbot_flows').update({ lifecycle_status: 'archived', is_active: false, archived_at: now, updated_at: now })
      .eq('id', flow.id).eq('customer_id', req.workspace.customerId).select().single()
    if (error) throw error
    res.json(data)
  } catch (error) { res.status(400).json({ error: error.message || 'Unable to archive chatbot flow' }) }
})

router.post('/:id/test', requireAdmin, async (req, res) => {
  try {
    const flow = await flowForWorkspace(req.workspace.customerId, req.params.id)
    const definition = await checkedDefinition(req.workspace.customerId, flow.draft_definition)
    const inputs = Array.isArray(req.body?.inputs) ? req.body.inputs.slice(0, 20).map((value) => String(value || '').slice(0, 4096)) : []
    // Pure simulation: no database writes, contact/conversation creation, or WhatsApp calls.
    res.json({ simulation: simulateFlow(definition, inputs) })
  } catch (error) { res.status(400).json({ error: error.message || 'Unable to simulate chatbot flow' }) }
})

module.exports = router
