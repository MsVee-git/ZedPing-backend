const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { requireAdmin } = require('../middleware/auth')
const { validateTimezone, validateBusinessHours } = require('../lib/automationRuntime')

const TYPES = new Set(['welcome', 'away', 'keyword', 'faq', 'lead_capture', 'human_handoff', 'custom'])
const ACTIONS = new Set(['send_text', 'content_library', 'start_chatbot_flow', 'human_handoff'])

function cleanText(value, max, label, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${label} is required`)
    return ''
  }
  if (typeof value !== 'string') throw new Error(`${label} is invalid`)
  const text = value.trim()
  if (required && !text) throw new Error(`${label} is required`)
  if (text.length > max) throw new Error(`${label} is too long`)
  return text
}

function phrases(value, required) {
  const list = Array.isArray(value) ? value : []
  if ((required && !list.length) || list.length > 10) throw new Error('Use between 1 and 10 exact phrases')
  const cleaned = [...new Set(list.map((entry) => cleanText(entry, 160, 'Phrase', true).toUpperCase()))]
  if (required && !cleaned.length) throw new Error('Use at least one phrase')
  return cleaned
}

function leadCapture(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Lead-capture configuration is invalid')
  const standard = Array.isArray(value.standard_fields) ? value.standard_fields : []
  const allowed = new Set(['name', 'email', 'service_interest', 'phone'])
  if (standard.some((field) => !allowed.has(field))) throw new Error('Lead-capture standard field is invalid')
  const custom = Array.isArray(value.custom_questions) ? value.custom_questions : []
  if (custom.length > 5) throw new Error('Lead capture supports at most five custom questions')
  const custom_questions = custom.map((question) => ({ key: cleanText(question?.key, 60, 'Custom-question key', true), prompt: cleanText(question?.prompt, 300, 'Custom question', true) }))
  if (new Set(custom_questions.map((question) => question.key)).size !== custom_questions.length) throw new Error('Lead-capture custom-question keys must be unique')
  return { standard_fields: [...new Set(standard)], custom_questions }
}

async function assertContent(customerId, contentId) {
  const { data, error } = await supabase.from('content_library_items').select('id,content_type,archived_at')
    .eq('id', contentId).eq('customer_id', customerId).maybeSingle()
  if (error) throw error
  if (!data || data.archived_at || !['TEXT', 'LINK'].includes(data.content_type)) throw new Error('Select active Text or Link content from this workspace')
  return data
}

async function assertFlow(customerId, flowId) {
  if (!flowId) return null
  const { data, error } = await supabase.from('chatbot_flows').select('id')
    .eq('id', flowId).eq('customer_id', customerId).maybeSingle()
  if (error) throw error
  if (!data) throw new Error('Select a chatbot flow from this workspace')
  return data
}

async function readAutomation(input = {}, customerId) {
  const allowed = ['automation_type', 'trigger_type', 'trigger_value', 'trigger_config', 'condition_config', 'action_config', 'message_template', 'chatbot_flow_id', 'content_library_item_id', 'priority']
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error('Invalid automation request')
  const legacyTrigger = input.trigger_type === 'keyword' ? 'keyword' : ''
  const automation_type = cleanText(input.automation_type || legacyTrigger, 40, 'Automation type', true).toLowerCase()
  if (!TYPES.has(automation_type)) throw new Error('Automation type is invalid')
  const priority = input.priority === undefined ? 100 : Number(input.priority)
  if (!Number.isInteger(priority) || priority < 0 || priority > 100000) throw new Error('Automation priority is invalid')
  const trigger_config = input.trigger_config && typeof input.trigger_config === 'object' && !Array.isArray(input.trigger_config) ? { ...input.trigger_config } : {}
  const condition_config = input.condition_config && typeof input.condition_config === 'object' && !Array.isArray(input.condition_config) ? { ...input.condition_config } : {}
  const needsPhrase = ['keyword', 'faq', 'lead_capture', 'human_handoff', 'custom'].includes(automation_type)
  if (needsPhrase) trigger_config.phrases = phrases(trigger_config.phrases || (input.trigger_value ? [input.trigger_value] : []), true)
  if (!needsPhrase && Object.hasOwn(trigger_config, 'phrases')) throw new Error('This automation type does not use phrases')
  const action_config = input.action_config && typeof input.action_config === 'object' && !Array.isArray(input.action_config) ? { ...input.action_config } : {}
  const kind = cleanText(action_config.kind || (automation_type === 'human_handoff' ? 'human_handoff' : 'send_text'), 40, 'Action type', true)
  if (!ACTIONS.has(kind)) throw new Error('Automation action is invalid')
  action_config.kind = kind
  const message_template = cleanText(input.message_template, 4096, 'Automation message', kind === 'send_text')
  const content_library_item_id = input.content_library_item_id || null
  const chatbot_flow_id = input.chatbot_flow_id || null
  if (kind === 'content_library') {
    if (!content_library_item_id) throw new Error('Select Content Library content')
    await assertContent(customerId, content_library_item_id)
  } else if (content_library_item_id) throw new Error('Content Library is only supported for a content response')
  if (kind === 'start_chatbot_flow' || automation_type === 'lead_capture') {
    if (!chatbot_flow_id) throw new Error('Select an existing chatbot flow')
    await assertFlow(customerId, chatbot_flow_id)
  } else if (chatbot_flow_id) {
    await assertFlow(customerId, chatbot_flow_id)
  }
  if (automation_type === 'lead_capture') action_config.lead_capture = leadCapture(action_config.lead_capture)
  if (automation_type === 'human_handoff' && kind !== 'human_handoff') throw new Error('Human handoff must use the handoff action')
  return { automation_type, trigger_type: 'keyword', trigger_value: trigger_config.phrases?.[0] || automation_type.toUpperCase(), trigger_config, condition_config, action_config, message_template, chatbot_flow_id, content_library_item_id, priority }
}

router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('automations').select('*')
    .eq('customer_id', req.workspace.customerId).is('archived_at', null)
    .order('priority', { ascending: true }).order('created_at', { ascending: true }).order('id', { ascending: true })
  if (error) return res.status(500).json({ error: 'Unable to load automations' })
  res.json(data)
})

router.post('/', requireAdmin, async (req, res) => {
  try {
    const automation = await readAutomation(req.body, req.workspace.customerId)
    const { data, error } = await supabase.from('automations').insert({ customer_id: req.workspace.customerId, ...automation, is_active: true }).select().single()
    if (error) throw error
    res.status(201).json(data)
  } catch (error) { res.status(400).json({ error: error.message || 'Unable to create automation' }) }
})

router.patch('/:id', requireAdmin, async (req, res) => {
  const body = req.body || {}
  try {
    if (Object.keys(body).length === 1 && typeof body.is_active === 'boolean') {
      const { data, error } = await supabase.from('automations').update({ is_active: body.is_active, updated_at: new Date().toISOString() }).eq('id', req.params.id).eq('customer_id', req.workspace.customerId).is('archived_at', null).select().maybeSingle()
      if (error) throw error
      if (!data) return res.status(404).json({ error: 'Automation not found' })
      return res.json(data)
    }
    const automation = await readAutomation(body, req.workspace.customerId)
    const { data, error } = await supabase.from('automations').update({ ...automation, updated_at: new Date().toISOString() }).eq('id', req.params.id).eq('customer_id', req.workspace.customerId).is('archived_at', null).select().maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Automation not found' })
    res.json(data)
  } catch (error) { res.status(400).json({ error: error.message || 'Unable to update automation' }) }
})

router.get('/settings', async (req, res) => {
  const { data, error } = await supabase.from('workspace_automation_settings').select('timezone,business_hours,updated_at').eq('customer_id', req.workspace.customerId).maybeSingle()
  if (error) return res.status(500).json({ error: 'Unable to load automation settings' })
  res.json(data || { timezone: null, business_hours: {} })
})

router.put('/settings', requireAdmin, async (req, res) => {
  try {
    if (Object.keys(req.body || {}).some((key) => !['timezone', 'business_hours'].includes(key))) throw new Error('Automation settings are invalid')
    const timezone = validateTimezone(req.body?.timezone)
    const business_hours = validateBusinessHours(req.body?.business_hours)
    const { data, error } = await supabase.from('workspace_automation_settings').upsert({ customer_id: req.workspace.customerId, timezone, business_hours, updated_by: req.workspace.userId, updated_at: new Date().toISOString() }, { onConflict: 'customer_id' }).select().single()
    if (error) throw error
    res.json(data)
  } catch (error) { res.status(400).json({ error: error.message || 'Unable to save automation settings' }) }
})

router.get('/history', async (req, res) => {
  const { data, error } = await supabase.from('automation_execution_events').select('id,whatsapp_number_id,contact_id,conversation_id,automation_id,event_type,outcome,metadata,created_at,expires_at')
    .eq('customer_id', req.workspace.customerId).order('created_at', { ascending: false }).limit(200)
  if (error) return res.status(500).json({ error: 'Unable to load automation history' })
  res.json(data || [])
})

router.post('/airtable-webhook', (req, res) => res.status(410).json({ error: 'This integration is disabled until tenant-specific signed webhook credentials are configured' }))

module.exports = router

