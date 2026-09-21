const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { requireAdmin } = require('../middleware/auth')
const { BETA_MODEL } = require('../lib/aiRuntime')

const TYPES = new Set(['support', 'sales', 'booking'])
const LIFECYCLES = new Set(['draft', 'active', 'paused', 'archived'])

function text(value, label, max, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${label} is required`)
    return null
  }
  if (typeof value !== 'string') throw new Error(`${label} is invalid`)
  const result = value.trim()
  if (required && !result) throw new Error(`${label} is required`)
  if (result.length > max) throw new Error(`${label} is too long`)
  return result || null
}

async function workspaceNumber(customerId, id) {
  const { data, error } = await supabase.from('whatsapp_numbers').select('id')
    .eq('id', id).eq('customer_id', customerId).eq('status', 'connected').maybeSingle()
  if (error) throw error
  if (!data) throw new Error('Select a connected WhatsApp number from this workspace')
  return data
}

async function agentForWorkspace(customerId, id) {
  const { data, error } = await supabase.from('ai_agents').select('*')
    .eq('id', id).eq('customer_id', customerId).is('legacy_contained_at', null).maybeSingle()
  if (error) throw error
  if (!data) throw new Error('AI agent not found')
  return data
}

function safeAgent(agent) {
  const { system_prompt, ...safe } = agent
  return safe
}

function readCreate(body) {
  const allowed = ['name','system_prompt','agent_type','handoff_keyword','whatsapp_number_id']
  if (!body || Object.keys(body).some((key) => !allowed.includes(key))) throw new Error('Invalid AI agent request')
  const agent_type = String(body.agent_type || 'support').toLowerCase()
  if (!TYPES.has(agent_type)) throw new Error('AI agent type is invalid')
  return {
    name: text(body.name, 'Agent name', 160, true),
    system_prompt: text(body.system_prompt, 'Agent instructions', 6000, true),
    agent_type,
    handoff_keyword: text(body.handoff_keyword, 'Handoff keyword', 100)
  }
}

function readPatch(body, current) {
  const allowed = ['name','system_prompt','agent_type','handoff_keyword','lifecycle_status']
  if (!body || !Object.keys(body).length || Object.keys(body).some((key) => !allowed.includes(key))) throw new Error('Invalid AI agent update')
  const patch = {}
  if (Object.hasOwn(body, 'name')) patch.name = text(body.name, 'Agent name', 160, true)
  if (Object.hasOwn(body, 'system_prompt')) patch.system_prompt = text(body.system_prompt, 'Agent instructions', 6000, true)
  if (Object.hasOwn(body, 'handoff_keyword')) patch.handoff_keyword = text(body.handoff_keyword, 'Handoff keyword', 100)
  if (Object.hasOwn(body, 'agent_type')) {
    const type = String(body.agent_type || '').toLowerCase()
    if (!TYPES.has(type)) throw new Error('AI agent type is invalid')
    patch.agent_type = type
  }
  if (Object.hasOwn(body, 'lifecycle_status')) {
    const lifecycle = String(body.lifecycle_status || '').toLowerCase()
    if (!LIFECYCLES.has(lifecycle)) throw new Error('AI agent lifecycle is invalid')
    patch.lifecycle_status = lifecycle
    patch.is_active = lifecycle === 'active'
    if (lifecycle === 'archived') {
      patch.archived_at = new Date().toISOString()
      patch.archive_reason = 'archived_by_workspace'
    }
  }
  if (Object.keys(patch).some((key) => ['name','system_prompt','agent_type','handoff_keyword'].includes(key))) {
    patch.configuration_version = Number(current.configuration_version || 1) + 1
  }
  return patch
}

router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('ai_agents')
    .select('id,customer_id,whatsapp_number_id,name,model,is_active,agent_type,handoff_keyword,lifecycle_status,configuration_version,created_at,archived_at')
    .eq('customer_id', req.workspace.customerId).is('legacy_contained_at', null)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: 'Unable to load AI agents' })
  res.json({ agents: data || [], model: BETA_MODEL })
})

router.post('/', requireAdmin, async (req, res) => {
  try {
    const input = readCreate(req.body)
    const number = await workspaceNumber(req.workspace.customerId, req.body?.whatsapp_number_id)
    const { data, error } = await supabase.from('ai_agents').insert({
      customer_id: req.workspace.customerId, whatsapp_number_id: number.id,
      ...input, model: BETA_MODEL, lifecycle_status: 'draft', is_active: false, configuration_version: 1
    }).select().single()
    if (error) throw error
    res.status(201).json({ agent: safeAgent(data) })
  } catch (error) {
    const status = error?.code === '23505' ? 409 : 400
    res.status(status).json({ error: error.message || 'Unable to create AI agent' })
  }
})

router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const current = await agentForWorkspace(req.workspace.customerId, req.params.id)
    const patch = readPatch(req.body, current)
    const { data, error } = await supabase.from('ai_agents').update(patch)
      .eq('id', current.id).eq('customer_id', req.workspace.customerId).is('legacy_contained_at', null).select().single()
    if (error) throw error
    res.json({ agent: safeAgent(data) })
  } catch (error) {
    const status = error?.code === '23505' ? 409 : 400
    res.status(status).json({ error: error.message || 'Unable to update AI agent' })
  }
})

module.exports = router
