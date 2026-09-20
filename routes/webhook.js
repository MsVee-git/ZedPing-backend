const express = require('express')
const crypto = require('crypto')
const router = express.Router()
const supabase = require('../lib/supabase')
const { sendTextMessage } = require('../lib/whatsapp')
const { getAIResponse } = require('../lib/openai')
const { shouldSuppressAutomation, stateForInbound } = require('../lib/conversationState')
const { recordConversationEvent } = require('../lib/conversationEvents')
const { selectExplicitAutomation, selectAwayAutomation, selectWelcomeAutomation, selectDefaultAutomation, isOutsideBusinessHours } = require('../lib/automationRuntime')
const { recordAutomationEvent, claimWelcome, completeWelcome, releaseWelcome } = require('../lib/automationExecution')
const { inboundEventPayload, isDuplicateInboundEventError } = require('../lib/inboundWebhookEvents')
const { selectSoleActiveAgent } = require('../lib/aiAgentSelection')

router.get('/', (req, res) => {
  const received = Buffer.from(String(req.query['hub.verify_token'] || ''))
  const expected = Buffer.from(String(process.env.VERIFY_TOKEN || ''))
  const ok = req.query['hub.mode'] === 'subscribe' && received.length === expected.length && crypto.timingSafeEqual(received, expected)
  return ok ? res.status(200).send(req.query['hub.challenge']) : res.sendStatus(403)
})

function validSignature(req) {
  const secret = process.env.META_APP_SECRET
  const signature = req.get('x-hub-signature-256') || ''
  if (!secret || !signature.startsWith('sha256=')) return false
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex')
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}

router.post('/', async (req, res) => {
  if (!validSignature(req)) return res.sendStatus(401)
  res.sendStatus(200)
  try {
    for (const entry of req.body.entry || []) for (const change of entry.changes || []) {
      const value = change.value || {}
      const phoneNumberId = value.metadata?.phone_number_id
      if (!phoneNumberId) continue
      const { data: number } = await supabase.from('whatsapp_numbers').select('*')
        .eq('phone_number_id', phoneNumberId).eq('status', 'connected').maybeSingle()
      if (!number) continue
      for (const incoming of value.messages || []) {
        await processMessage({ customerId: number.customer_id, number, from: incoming.from, body: incoming.text?.body || '', metaId: incoming.id })
      }
    }
  } catch (error) {
    console.error('Webhook processing error', error)
  }
})

async function findOrCreateContact(ctx) {
  let { data: contact } = await supabase.from('contacts').select('*')
    .eq('customer_id', ctx.customerId).eq('phone_number', ctx.from).maybeSingle()
  if (!contact) {
    const { data, error } = await supabase.from('contacts').insert({
      customer_id: ctx.customerId, name: '', phone_number: ctx.from, custom_fields: {}
    }).select().single()
    if (error) throw error
    contact = data
  }
  return contact
}

async function findConversation(ctx, contact) {
  const { data, error } = await supabase.from('conversations').select('*')
    .eq('customer_id', ctx.customerId)
    .eq('whatsapp_number_id', ctx.number.id)
    .eq('contact_id', contact.id)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data || null
}

async function persistInbound(ctx, contact, conversation) {
  const now = new Date().toISOString()
  const state = stateForInbound(conversation)
  if (!conversation) {
    const { data, error } = await supabase.from('conversations').insert({
      customer_id: ctx.customerId,
      whatsapp_number_id: ctx.number.id,
      contact_id: contact.id,
      status: state.status,
      control_mode: state.control_mode,
      unread_count: 1,
      last_message_at: now,
      last_inbound_at: now
    }).select().single()
    if (error) throw error
    conversation = data
  } else {
    const patch = {
      status: state.status,
      control_mode: state.control_mode,
      assigned_user_id: state.assigned_user_id,
      unread_count: Number(conversation.unread_count || 0) + 1,
      last_message_at: now,
      last_inbound_at: now,
      updated_at: now
    }
    const query = supabase.from('conversations').update(patch).eq('id', conversation.id).eq('customer_id', ctx.customerId)
    if (state.reopened) query.eq('status', 'resolved')
    const { data, error } = await query.select().maybeSingle()
    if (error) throw error
    if (!data) throw new Error('Conversation state changed before inbound processing')
    conversation = data
    if (state.reopened) {
      await recordConversationEvent({ customerId: ctx.customerId, conversationId: conversation.id, eventType: 'conversation_reopened_by_inbound' })
    }
  }

  const { error: messageError } = await supabase.from('messages').insert({
    customer_id: ctx.customerId,
    whatsapp_number_id: ctx.number.id,
    contact_id: contact.id,
    conversation_id: conversation.id,
    direction: 'inbound',
    from_number: ctx.from,
    to_number: ctx.number.phone_number,
    message_body: ctx.body,
    status: 'received',
    meta_message_id: ctx.metaId
  })
  if (messageError) throw messageError
  return conversation
}

async function claimInboundEvent(ctx) {
  const event = inboundEventPayload(ctx)
  if (!event) return true
  const { error } = await supabase.from('inbound_webhook_events').insert(event)
  if (!error) return true
  if (isDuplicateInboundEventError(error)) return false
  throw error
}

async function processMessage(ctx) {
  // Claim the Meta message identity before any contact, conversation, message,
  // or automation side effect. A retry therefore cannot trigger twice.
  if (!(await claimInboundEvent(ctx))) return
  const contact = await findOrCreateContact(ctx)
  const existing = await findConversation(ctx, contact)
  const conversation = await persistInbound(ctx, contact, existing)
  ctx.contact = contact
  ctx.conversation = conversation

  // This server-side guard is intentionally before AI, flow and keyword execution.
  // Needs-attention and human conversations keep receiving/persisting inbound
  // messages but cannot produce an automated response.
  if (shouldSuppressAutomation(conversation)) return

  if (await checkAISession(ctx)) return
  if (await checkFlowSession(ctx)) return
  await checkAutomations(ctx)
}

async function outgoing(ctx, body) {
  const result = await sendTextMessage(ctx.number.phone_number_id, ctx.from, body, ctx.number.access_token)
  const now = new Date().toISOString()
  const { data: message, error } = await supabase.from('messages').insert({
    customer_id: ctx.customerId,
    whatsapp_number_id: ctx.number.id,
    contact_id: ctx.contact?.id || null,
    conversation_id: ctx.conversation?.id || null,
    direction: 'outbound',
    to_number: ctx.from,
    message_body: body,
    status: 'sent',
    meta_message_id: result?.messages?.[0]?.id || null
  }).select().single()
  if (error) throw error
  if (ctx.conversation?.id) {
    await supabase.from('conversations').update({ last_message_at: now, last_outbound_at: now, updated_at: now })
      .eq('id', ctx.conversation.id).eq('customer_id', ctx.customerId)
  }
  return message
}

async function workspaceAutomationSettings(customerId) {
  const { data, error } = await supabase.from('workspace_automation_settings')
    .select('timezone,business_hours').eq('customer_id', customerId).maybeSingle()
  if (error) throw error
  return data || null
}

async function responseBody(ctx, automation) {
  const action = automation.action_config || {}
  if (action.kind !== 'content_library') return automation.message_template
  const { data: item, error } = await supabase.from('content_library_items')
    .select('content_type,text_content,link_url').eq('id', automation.content_library_item_id)
    .eq('customer_id', ctx.customerId).is('archived_at', null).maybeSingle()
  if (error) throw error
  if (!item || !['TEXT', 'LINK'].includes(item.content_type)) throw new Error('Automation content is unavailable')
  return item.content_type === 'TEXT' ? item.text_content : item.link_url
}

async function handoffFromAutomation(ctx, automation) {
  const now = new Date().toISOString()
  const reason = String(automation.action_config?.reason || 'Requested by automation').trim().slice(0, 500) || 'Requested by automation'
  const { data, error } = await supabase.from('conversations').update({
    status: 'needs_attention',
    control_mode: 'needs_attention',
    assigned_user_id: null,
    handoff_reason: reason,
    handoff_at: now,
    updated_at: now
  }).eq('id', ctx.conversation.id).eq('customer_id', ctx.customerId).select().maybeSingle()
  if (error || !data) throw error || new Error('Conversation is unavailable for handoff')
  await recordConversationEvent({ customerId: ctx.customerId, conversationId: data.id, eventType: 'handoff_requested', metadata: { source: 'automation' } })
}

async function startLegacyAI(ctx) {
  const { data: agents, error: agentError } = await supabase.from('ai_agents').select('*')
    .eq('customer_id', ctx.customerId).eq('whatsapp_number_id', ctx.number.id).eq('is_active', true).limit(2)
  if (agentError) throw agentError
  const agent = selectSoleActiveAgent(agents)
  if (!agent) return false
  const { error: sessionError } = await supabase.from('ai_agent_sessions').insert({
    customer_id: ctx.customerId, whatsapp_number_id: ctx.number.id, agent_id: agent.id, contact_phone: ctx.from, status: 'active'
  })
  if (sessionError && !isDuplicateInboundEventError(sessionError)) throw sessionError
  return true
}

async function executeAutomation(ctx, automation) {
  const action = automation.action_config || {}
  const kind = action.kind || (automation.chatbot_flow_id ? 'start_chatbot_flow' : 'send_text')
  await recordAutomationEvent(ctx, 'triggered', 'success', { rule_kind: automation.automation_type || 'legacy_keyword', action_kind: kind }, automation.id)
  if (kind === 'human_handoff') {
    await handoffFromAutomation(ctx, automation)
    await recordAutomationEvent(ctx, 'handoff_initiated', 'success', { action_kind: kind }, automation.id)
    return
  }
  if (kind === 'start_chatbot_flow' || automation.chatbot_flow_id) {
    await startFlow(ctx, automation.chatbot_flow_id)
    await recordAutomationEvent(ctx, 'response_sent', 'success', { action_kind: 'start_chatbot_flow' }, automation.id)
    return
  }
  if ((automation.trigger_value || '').trim().toUpperCase() === 'CHAT' && !automation.automation_type) {
    if (await startLegacyAI(ctx)) return
  }
  const body = await responseBody(ctx, automation)
  const message = await outgoing(ctx, body)
  await recordAutomationEvent(ctx, 'response_sent', 'success', { action_kind: kind, content_type: action.kind === 'content_library' ? 'content_library' : 'written_text' }, automation.id)
  return message
}

async function runWelcome(ctx, automation) {
  const claimed = await claimWelcome(ctx, automation.id)
  if (!claimed) {
    await recordAutomationEvent(ctx, 'skipped', 'skipped', { reason: 'welcome_already_delivered' }, automation.id)
    return false
  }
  try {
    const message = await executeAutomation(ctx, automation)
    await completeWelcome(ctx, message?.id || null)
    return true
  } catch (error) {
    await releaseWelcome(ctx)
    await recordAutomationEvent(ctx, 'error', 'error', { reason: 'welcome_send_failed' }, automation.id).catch(() => {})
    throw error
  }
}

async function checkAutomations(ctx) {
  const { data: list, error } = await supabase.from('automations').select('*')
    .eq('customer_id', ctx.customerId).eq('is_active', true).is('archived_at', null)
    .order('priority', { ascending: true }).order('created_at', { ascending: true }).order('id', { ascending: true })
  if (error) throw error

  const explicit = selectExplicitAutomation(list, ctx.body)
  if (explicit) return executeAutomation(ctx, explicit)

  const settings = await workspaceAutomationSettings(ctx.customerId)
  if (settings && isOutsideBusinessHours(settings)) {
    const away = selectAwayAutomation(list)
    if (away) return executeAutomation(ctx, away)
  }

  const welcome = selectWelcomeAutomation(list)
  if (welcome && await runWelcome(ctx, welcome)) return

  const fallback = selectDefaultAutomation(list)
  if (fallback) return executeAutomation(ctx, fallback)
}

async function startFlow(ctx, flowId) {
  const { data: flow } = await supabase.from('chatbot_flows').select('id')
    .eq('id', flowId).eq('customer_id', ctx.customerId).eq('whatsapp_number_id', ctx.number.id).maybeSingle()
  if (!flow) return
  const { data: step } = await supabase.from('chatbot_steps').select('*').eq('flow_id', flow.id)
    .order('step_order').limit(1).maybeSingle()
  if (!step) return
  await supabase.from('chatbot_sessions').delete()
    .eq('customer_id', ctx.customerId)
    .eq('whatsapp_number_id', ctx.number.id)
    .eq('contact_phone', ctx.from)
  await supabase.from('chatbot_sessions').insert({
    customer_id: ctx.customerId, whatsapp_number_id: ctx.number.id, contact_phone: ctx.from,
    flow_id: flow.id, current_step_id: step.id, status: 'active'
  })
  await outgoing(ctx, step.message_body)
}

async function checkFlowSession(ctx) {
  const { data: session } = await supabase.from('chatbot_sessions').select('*')
    .eq('customer_id', ctx.customerId).eq('whatsapp_number_id', ctx.number.id)
    .eq('contact_phone', ctx.from).eq('status', 'active').maybeSingle()
  if (!session) return false
  const { data: route } = await supabase.from('chatbot_step_routes').select('*')
    .eq('step_id', session.current_step_id).eq('match_value', ctx.body.trim().toUpperCase()).maybeSingle()
  if (!route) {
    await supabase.from('chatbot_sessions').update({ status: 'ended' }).eq('id', session.id)
    return true
  }
  const { data: next } = await supabase.from('chatbot_steps').select('*').eq('id', route.next_step_id).maybeSingle()
  if (!next) return true
  await supabase.from('chatbot_sessions').update({ current_step_id: next.id }).eq('id', session.id)
  await outgoing(ctx, next.message_body)
  return true
}

async function checkAISession(ctx) {
  const { data: session } = await supabase.from('ai_agent_sessions').select('*,ai_agents(*)')
    .eq('customer_id', ctx.customerId).eq('whatsapp_number_id', ctx.number.id)
    .eq('contact_phone', ctx.from).eq('status', 'active').maybeSingle()
  if (!session) return false
  const agent = session.ai_agents
  if (!agent || agent.customer_id !== ctx.customerId || agent.whatsapp_number_id !== ctx.number.id) return false
  const history = [...(session.messages || []), { role: 'user', content: ctx.body }]
  const reply = await getAIResponse(agent.system_prompt, history, agent)
  history.push({ role: 'assistant', content: reply })
  await supabase.from('ai_agent_sessions').update({ messages: history, updated_at: new Date().toISOString() })
    .eq('id', session.id).eq('customer_id', ctx.customerId).eq('whatsapp_number_id', ctx.number.id)
  await outgoing(ctx, reply)
  return true
}

module.exports = router
