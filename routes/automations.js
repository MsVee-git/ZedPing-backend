const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { requireAdmin } = require('../middleware/auth')

function readAutomation(input = {}) {
  const allowed = ['trigger_type', 'trigger_value', 'message_template', 'chatbot_flow_id', 'priority']
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error('Invalid automation request')
  const triggerType = String(input.trigger_type || '').trim()
  const triggerValue = String(input.trigger_value || '').trim()
  const messageTemplate = typeof input.message_template === 'string' ? input.message_template.trim() : ''
  const priority = input.priority === undefined ? 100 : Number(input.priority)
  if (!['keyword', 'new_booking', 'webhook'].includes(triggerType)) throw new Error('Automation trigger type is invalid')
  if (!triggerValue || triggerValue.length > 160) throw new Error('Automation trigger value is invalid')
  if (!messageTemplate || messageTemplate.length > 4096) throw new Error('Automation message is invalid')
  if (!Number.isInteger(priority) || priority < 0 || priority > 100000) throw new Error('Automation priority is invalid')
  const chatbotFlowId = input.chatbot_flow_id || null
  if (chatbotFlowId !== null && (typeof chatbotFlowId !== 'string' || chatbotFlowId.length > 64)) throw new Error('Chatbot flow is invalid')
  return { trigger_type: triggerType, trigger_value: triggerValue, message_template: messageTemplate, chatbot_flow_id: chatbotFlowId, priority }
}

router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('automations').select('*')
    .eq('customer_id', req.workspace.customerId)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
  if (error) return res.status(500).json({ error: 'Unable to load automations' })
  res.json(data)
})

router.post('/', requireAdmin, async (req, res) => {
  try {
    const automation = readAutomation(req.body)
    const { data, error } = await supabase.from('automations').insert({
      customer_id: req.workspace.customerId,
      ...automation,
      is_active: true
    }).select()
    if (error) throw error
    res.status(201).json(data)
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to create automation' })
  }
})

router.patch('/:id', requireAdmin, async (req, res) => {
  const body = req.body || {}
  if (Object.keys(body).some((key) => key !== 'is_active') || typeof body.is_active !== 'boolean') {
    return res.status(400).json({ error: 'Automation status is invalid' })
  }
  const { data, error } = await supabase.from('automations').update({ is_active: body.is_active })
    .eq('id', req.params.id).eq('customer_id', req.workspace.customerId).select()
  if (error) return res.status(500).json({ error: 'Unable to update automation' })
  if (!data?.length) return res.status(404).json({ error: 'Automation not found' })
  res.json(data)
})

router.post('/airtable-webhook', (req, res) => res.status(410).json({
  error: 'This integration is disabled until tenant-specific signed webhook credentials are configured'
}))

module.exports = router
