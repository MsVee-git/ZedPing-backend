const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { sendTextMessage } = require('../lib/whatsapp')
const { getAIResponse } = require('../lib/openai')

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'zedping123'

router.get('/', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  const expected = (VERIFY_TOKEN).trim()
  const received = (token || '').trim()
  if (mode === 'subscribe' && received === expected) {
    res.status(200).send(challenge)
  } else {
    res.sendStatus(403)
  }
})

router.post('/', async (req, res) => {
  const body = req.body
  if (body.object === 'whatsapp_business_account') {
    for (const entry of body.entry) {
      for (const change of entry.changes) {
        const value = change.value
        if (value.messages) {
          for (const message of value.messages) {
            const fromNumber = message.from
            const messageBody = message.text?.body || ''
            const toNumber = value.metadata.display_phone_number
            const phoneNumberId = value.metadata.phone_number_id
            await supabase.from('messages').insert({
              direction: 'inbound',
              from_number: fromNumber,
              to_number: toNumber,
              message_body: messageBody,
              status: 'received'
            })
            console.log('Message received from:', fromNumber, ':', messageBody)
            const handled = await checkAISession(fromNumber, messageBody, phoneNumberId)
            if (handled) continue
            const flowHandled = await checkFlowSession(fromNumber, messageBody, phoneNumberId)
            if (flowHandled) continue
            await checkAutomations(fromNumber, messageBody, phoneNumberId)
          }
        }
      }
    }
  }
  res.sendStatus(200)
})

async function checkAutomations(fromNumber, messageBody, phoneNumberId) {
  try {
    const keyword = messageBody.trim().toUpperCase()
    const { data: automations, error } = await supabase
      .from('automations')
      .select('*')
      .eq('trigger_type', 'keyword')
      .eq('is_active', true)
    if (error || !automations || automations.length === 0) return
    let matched = false
    for (const automation of automations) {
      const triggerValue = (automation.trigger_value || '').toUpperCase()
      if (keyword === triggerValue && triggerValue !== 'DEFAULT') {
        console.log('Automation matched:', automation.trigger_value)
        if (triggerValue === 'CHAT') {
          const { data: agents } = await supabase
            .from('ai_agents')
            .select('*')
            .eq('is_active', true)
            .limit(1)
          if (agents && agents.length > 0) {
            await supabase.from('ai_agent_sessions').upsert({
              agent_id: agents[0].id,
              contact_phone: fromNumber,
              messages: [],
              status: 'active',
              updated_at: new Date().toISOString()
            }, { onConflict: 'contact_phone' })
          }
        }
        if (automation.chatbot_flow_id) {
          await startChatbotFlow(fromNumber, phoneNumberId, automation.chatbot_flow_id)
          return
        }
        await sendTextMessage(phoneNumberId, fromNumber, automation.message_template)
        await supabase.from('messages').insert({
          direction: 'outbound',
          to_number: fromNumber,
          message_body: automation.message_template,
          status: 'sent'
        })
        console.log('Auto-reply sent to:', fromNumber)
        matched = true
        break
      }
    }
    if (!matched) {
      const defaultAuto = automations.find(a => a.trigger_value.toUpperCase() === 'DEFAULT')
      if (defaultAuto) {
        await sendTextMessage(phoneNumberId, fromNumber, defaultAuto.message_template)
        await supabase.from('messages').insert({
          direction: 'outbound',
          to_number: fromNumber,
          message_body: defaultAuto.message_template,
          status: 'sent'
        })
        console.log('Default fallback sent to:', fromNumber)
      }
    }
  } catch (err) {
    console.error('Automation error:', err)
  }
}

async function startChatbotFlow(fromNumber, phoneNumberId, flowId) {
  try {
    const { data: steps } = await supabase
      .from('chatbot_steps')
      .select('*')
      .eq('flow_id', flowId)
      .order('step_order', { ascending: true })
      .limit(1)
    if (!steps || steps.length === 0) return
    const firstStep = steps[0]
    await supabase.from('chatbot_sessions').upsert({
      contact_phone: fromNumber,
      flow_id: flowId,
      current_step_id: firstStep.id,
      status: 'active',
      updated_at: new Date().toISOString()
    }, { onConflict: 'contact_phone' })
    await sendTextMessage(phoneNumberId, fromNumber, firstStep.message_body)
    await supabase.from('messages').insert({
      direction: 'outbound',
      to_number: fromNumber,
      message_body: firstStep.message_body,
      status: 'sent'
    })
    console.log('Chatbot flow started for:', fromNumber)
  } catch (err) {
    console.error('Chatbot flow error:', err)
  }
}

async function checkFlowSession(fromNumber, messageBody, phoneNumberId) {
  try {
    const { data: session } = await supabase
      .from('chatbot_sessions')
      .select('*')
      .eq('contact_phone', fromNumber)
      .eq('status', 'active')
      .single()
    if (!session) return false
    const reply = messageBody.trim().toUpperCase()
    const { data: routes } = await supabase
      .from('chatbot_step_routes')
      .select('*')
      .eq('step_id', session.current_step_id)
      .eq('match_value', reply)
    let nextStepId = null
    if (routes && routes.length > 0) {
      nextStepId = routes[0].next_step_id
    } else {
      const { data: currentStep } = await supabase
        .from('chatbot_steps')
        .select('*')
        .eq('id', session.current_step_id)
        .single()
      if (currentStep && currentStep.next_step_id) {
        nextStepId = currentStep.next_step_id
      }
    }
    if (!nextStepId) {
      await supabase.from('chatbot_sessions')
        .update({ status: 'ended', updated_at: new Date().toISOString() })
        .eq('contact_phone', fromNumber)
      console.log('Chatbot flow ended for:', fromNumber)
      return true
    }
    const { data: nextStep } = await supabase
      .from('chatbot_steps')
      .select('*')
      .eq('id', nextStepId)
      .single()
    if (!nextStep) return false
    await supabase.from('chatbot_sessions')
      .update({ current_step_id: nextStepId, updated_at: new Date().toISOString() })
      .eq('contact_phone', fromNumber)
    await sendTextMessage(phoneNumberId, fromNumber, nextStep.message_body)
    await supabase.from('messages').insert({
      direction: 'outbound',
      to_number: fromNumber,
      message_body: nextStep.message_body,
      status: 'sent'
    })
    console.log('Chatbot advanced to step:', nextStepId)
    return true
  } catch (err) {
    console.error('Flow session error:', err)
    return false
  }
}

async function checkAISession(fromNumber, messageBody, phoneNumberId) {
  try {
    const { data: session } = await supabase
      .from('ai_agent_sessions')
      .select('*, ai_agents(*)')
      .eq('contact_phone', fromNumber)
      .eq('status', 'active')
      .single()
    if (!session) return false
    const agent = session.ai_agents
    if (agent.handoff_keyword && messageBody.trim().toUpperCase() === agent.handoff_keyword.toUpperCase()) {
      await supabase.from('ai_agent_sessions')
        .update({ status: 'handed_off', updated_at: new Date().toISOString() })
        .eq('id', session.id)
      const handoffMsg = 'You have been connected to a human agent. Someone will be with you shortly. You can also call us on +260 771 442 247.'
      await sendTextMessage(phoneNumberId, fromNumber, handoffMsg)
      console.log('AI session handed off for:', fromNumber)
      return true
    }
    const messages = session.messages || []
    messages.push({ role: 'user', content: messageBody })
    const aiReply = await getAIResponse(agent.system_prompt, messages, agent)
    messages.push({ role: 'assistant', content: aiReply })
    await supabase.from('ai_agent_sessions')
      .update({ messages, updated_at: new Date().toISOString() })
      .eq('id', session.id)
    await sendTextMessage(phoneNumberId, fromNumber, aiReply)
    await supabase.from('messages').insert({
      direction: 'outbound',
      to_number: fromNumber,
      message_body: aiReply,
      status: 'sent'
    })
    console.log('AI reply sent to:', fromNumber)
    return true
  } catch (err) {
    console.error('AI session error:', err)
    return false
  }
}

module.exports = router
