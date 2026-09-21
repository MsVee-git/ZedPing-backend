const supabase = require('./supabase')
const { validateCapture, findChoice, formatChoicePrompt } = require('./chatbotRuntime')
const { recordConversationEvent } = require('./conversationEvents')

function stepFor(version, key) {
  return (version?.definition?.steps || []).find((step) => step.id === key) || null
}

async function event(ctx, session, type, metadata = {}) {
  await supabase.from('chatbot_flow_events').insert({
    customer_id: ctx.customerId, whatsapp_number_id: ctx.number.id, flow_id: session.flow_id,
    flow_version_id: session.flow_version_id, session_id: session.id, conversation_id: ctx.conversation?.id || session.conversation_id || null,
    event_type: type, metadata
  })
}

async function finish(ctx, session, status, reason, metadata = {}) {
  const now = new Date().toISOString()
  const { data, error } = await supabase.from('chatbot_sessions').update({
    status, completion_reason: reason, ended_at: now, last_activity_at: now
  }).eq('id', session.id).eq('customer_id', ctx.customerId).eq('whatsapp_number_id', ctx.number.id).eq('status', 'active').select().maybeSingle()
  if (error) throw error
  if (data) await event(ctx, data, status === 'completed' ? 'completed' : status === 'handed_off' ? 'handed_off' : status === 'cancelled' ? 'cancelled' : status === 'failed' ? 'failed' : status, { reason, ...metadata })
  return data || session
}

async function promoteCapturedFields(ctx, session) {
  const values = session.captured_fields?.values || {}
  if (!Object.keys(values).length || !ctx.contact?.id) return
  const { data: contact, error } = await supabase.from('contacts').select('custom_fields,name,phone_number')
    .eq('id', ctx.contact.id).eq('customer_id', ctx.customerId).maybeSingle()
  if (error || !contact) return
  const existing = contact.custom_fields && typeof contact.custom_fields === 'object' ? contact.custom_fields : {}
  const additions = Object.fromEntries(Object.entries(values).filter(([key]) => !Object.hasOwn(existing, key)))
  const patch = Object.keys(additions).length ? { custom_fields: { ...existing, ...additions } } : {}
  if (!contact.name && typeof values.name === 'string' && values.name.trim()) patch.name = values.name.trim()
  if (Object.keys(patch).length) await supabase.from('contacts').update(patch).eq('id', ctx.contact.id).eq('customer_id', ctx.customerId)
}

async function handoff(ctx, session, reason) {
  const now = new Date().toISOString()
  const current = await finish(ctx, session, 'handed_off', 'flow_handoff', { reason: String(reason || '').slice(0, 500) })
  await promoteCapturedFields(ctx, current)
  const { data, error } = await supabase.from('conversations').update({
    status: 'needs_attention', control_mode: 'needs_attention', assigned_user_id: null,
    handoff_reason: String(reason || 'Requested by chatbot flow').slice(0, 500), handoff_at: now, updated_at: now
  }).eq('id', ctx.conversation.id).eq('customer_id', ctx.customerId).eq('whatsapp_number_id', ctx.number.id).select().maybeSingle()
  if (error || !data) throw error || new Error('Conversation is unavailable for flow handoff')
  await recordConversationEvent({ customerId: ctx.customerId, conversationId: data.id, eventType: 'handoff_requested', metadata: { source: 'chatbot_flow' } })
}

async function updateSession(ctx, session, patch) {
  const now = new Date().toISOString()
  const { data, error } = await supabase.from('chatbot_sessions').update({ ...patch, last_activity_at: now })
    .eq('id', session.id).eq('customer_id', ctx.customerId).eq('whatsapp_number_id', ctx.number.id).eq('status', 'active').select().maybeSingle()
  if (error) throw error
  if (!data) throw new Error('Chatbot session is no longer active')
  return data
}

async function contentBody(ctx, step) {
  const { data, error } = await supabase.from('content_library_items').select('content_type,text_content,link_url,archived_at')
    .eq('id', step.content_library_item_id).eq('customer_id', ctx.customerId).maybeSingle()
  if (error) throw error
  if (!data || data.archived_at || !['TEXT', 'LINK'].includes(data.content_type)) throw new Error('Flow content is no longer available')
  return data.content_type === 'TEXT' ? data.text_content : data.link_url
}

async function executeUntilInput(ctx, session, version, send) {
  let current = session
  for (let guard = 0; guard < 100; guard += 1) {
    const step = stepFor(version, current.current_step_key)
    if (!step) return finish(ctx, current, 'failed', 'missing_published_step')
    if (step.type === 'send_message') {
      await send(ctx, step.text)
      current = await updateSession(ctx, current, { current_step_key: step.next_step_id, current_step_attempts: 0 })
      await event(ctx, current, 'step_advanced', { step_type: 'send_message' })
      continue
    }
    if (step.type === 'content') {
      await send(ctx, await contentBody(ctx, step))
      current = await updateSession(ctx, current, { current_step_key: step.next_step_id, current_step_attempts: 0 })
      await event(ctx, current, 'step_advanced', { step_type: 'content' })
      continue
    }
    if (step.type === 'ask_capture') {
      await send(ctx, step.text)
      return current
    }
    if (step.type === 'choose_option') {
      await send(ctx, formatChoicePrompt(step))
      return current
    }
    if (step.type === 'human_handoff') {
      await handoff(ctx, current, step.reason)
      return null
    }
    if (step.type === 'end') {
      if (step.text) await send(ctx, step.text)
      const completed = await finish(ctx, current, 'completed', 'explicit_end')
      await promoteCapturedFields(ctx, completed)
      return null
    }
    return finish(ctx, current, 'failed', 'unsupported_published_step')
  }
  return finish(ctx, current, 'failed', 'execution_guard_exceeded')
}

async function loadVersion(ctx, session) {
  const { data, error } = await supabase.from('chatbot_flow_versions').select('*')
    .eq('id', session.flow_version_id).eq('customer_id', ctx.customerId).eq('whatsapp_number_id', ctx.number.id).maybeSingle()
  if (error) throw error
  return data || null
}

async function continueFlow(ctx, send) {
  const { data: session, error } = await supabase.from('chatbot_sessions').select('*')
    .eq('customer_id', ctx.customerId).eq('whatsapp_number_id', ctx.number.id).eq('contact_phone', ctx.from).eq('status', 'active').maybeSingle()
  if (error) throw error
  if (!session) return false
  const version = await loadVersion(ctx, session)
  if (!version) { await finish(ctx, session, 'failed', 'published_version_unavailable'); return true }
  const step = stepFor(version, session.current_step_key)
  if (!step) { await finish(ctx, session, 'failed', 'missing_published_step'); return true }
  if (step.type === 'ask_capture') {
    const result = validateCapture(ctx.body, step.capture)
    if (!result.ok) {
      const attempts = Number(session.current_step_attempts || 0) + 1
      if (attempts >= 2) {
        await event(ctx, session, 'validation_failed', { capture_type: step.capture.type, final_attempt: true })
        if (step.capture.failure_action === 'handoff') await handoff(ctx, session, 'Unable to validate customer response')
        else {
          await send(ctx, 'We could not complete this request.')
          await finish(ctx, session, 'completed', 'capture_validation_exhausted')
        }
        return true
      }
      const updated = await updateSession(ctx, session, { current_step_attempts: attempts })
      await event(ctx, updated, 'validation_failed', { capture_type: step.capture.type, final_attempt: false })
      await send(ctx, `${result.reason}. ${step.text}`)
      return true
    }
    const captured = session.captured_fields && typeof session.captured_fields === 'object' ? session.captured_fields : {}
    const values = captured.values && typeof captured.values === 'object' ? captured.values : {}
    const updated = await updateSession(ctx, session, {
      captured_fields: { ...captured, namespace: `flow_version:${session.flow_version_id}`, values: { ...values, [step.capture.key]: result.value } },
      current_step_key: step.next_step_id, current_step_attempts: 0
    })
    await event(ctx, updated, 'step_advanced', { step_type: 'ask_capture', capture_type: step.capture.type })
    await executeUntilInput(ctx, updated, version, send)
    return true
  }
  if (step.type === 'choose_option') {
    const choice = findChoice(step, ctx.body)
    if (!choice) {
      const attempts = Number(session.current_step_attempts || 0) + 1
      if (attempts >= 2) {
        await event(ctx, session, 'validation_failed', { choice: true, final_attempt: true })
        await handoff(ctx, session, 'Unable to understand customer selection')
      } else {
        const updated = await updateSession(ctx, session, { current_step_attempts: attempts })
        await event(ctx, updated, 'validation_failed', { choice: true, final_attempt: false })
        await send(ctx, `Please reply with one of the numbered choices.\n${formatChoicePrompt(step)}`)
      }
      return true
    }
    if (choice.outcome === 'human_handoff') { await handoff(ctx, session, 'Requested by customer choice'); return true }
    if (choice.outcome === 'end') { const completed = await finish(ctx, session, 'completed', 'choice_end'); await promoteCapturedFields(ctx, completed); return true }
    const updated = await updateSession(ctx, session, { current_step_key: choice.next_step_id, current_step_attempts: 0 })
    await event(ctx, updated, 'step_advanced', { step_type: 'choose_option' })
    await executeUntilInput(ctx, updated, version, send)
    return true
  }
  // A malformed historical session cannot swallow customer messages forever.
  await finish(ctx, session, 'failed', 'session_waiting_on_non_input_step')
  return true
}

async function startFlow(ctx, flowId, send) {
  const { data: flow, error } = await supabase.from('chatbot_flows').select('*')
    .eq('id', flowId).eq('customer_id', ctx.customerId).eq('whatsapp_number_id', ctx.number.id)
    .eq('lifecycle_status', 'published').eq('is_active', true).is('archived_at', null).maybeSingle()
  if (error) throw error
  if (!flow?.current_published_version_id) return false
  const { data: version, error: versionError } = await supabase.from('chatbot_flow_versions').select('*')
    .eq('id', flow.current_published_version_id).eq('flow_id', flow.id).eq('customer_id', ctx.customerId).eq('whatsapp_number_id', ctx.number.id).maybeSingle()
  if (versionError) throw versionError
  if (!version) return false
  const { data: active } = await supabase.from('chatbot_sessions').select('*')
    .eq('customer_id', ctx.customerId).eq('whatsapp_number_id', ctx.number.id).eq('contact_phone', ctx.from).eq('status', 'active').maybeSingle()
  if (active) await finish(ctx, active, 'cancelled', 'replaced_by_new_flow')
  const now = new Date().toISOString()
  const { data: session, error: sessionError } = await supabase.from('chatbot_sessions').insert({
    customer_id: ctx.customerId, whatsapp_number_id: ctx.number.id, contact_phone: ctx.from, contact_id: ctx.contact?.id || null,
    conversation_id: ctx.conversation?.id || null, flow_id: flow.id, flow_version_id: version.id,
    current_step_key: version.entry_step_key, status: 'active', captured_fields: { namespace: `flow_version:${version.id}`, values: {} },
    started_at: now, last_activity_at: now, current_step_attempts: 0
  }).select().single()
  if (sessionError) throw sessionError
  await event(ctx, session, 'started', { flow_version: version.version })
  await executeUntilInput(ctx, session, version, send)
  return true
}

async function handoffActiveFlowForConversation({ customerId, whatsappNumberId, conversationId, reason = 'manual_human_takeover' }) {
  const now = new Date().toISOString()
  const { data: sessions, error } = await supabase.from('chatbot_sessions').update({
    status: 'handed_off', completion_reason: reason, ended_at: now, last_activity_at: now
  }).eq('customer_id', customerId).eq('whatsapp_number_id', whatsappNumberId).eq('conversation_id', conversationId).eq('status', 'active').select()
  if (error) throw error
  for (const session of sessions || []) {
    await supabase.from('chatbot_flow_events').insert({
      customer_id: customerId, whatsapp_number_id: whatsappNumberId, flow_id: session.flow_id,
      flow_version_id: session.flow_version_id, session_id: session.id, conversation_id: conversationId,
      event_type: 'handed_off', metadata: { reason }
    })
  }
  return sessions || []
}

module.exports = { startFlow, continueFlow, handoffActiveFlowForConversation }
