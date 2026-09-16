const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { requireAdmin } = require('../middleware/auth')
const { sendTextMessage } = require('../lib/whatsapp')
const { mayResolve } = require('../lib/conversationState')
const { recordConversationEvent } = require('../lib/conversationEvents')

const CONVERSATION_FIELDS = 'id, customer_id, whatsapp_number_id, contact_id, status, control_mode, assigned_user_id, handoff_reason, handoff_at, taken_over_at, resolved_at, resolved_by_user_id, last_message_at, last_inbound_at, last_outbound_at, unread_count, created_at, updated_at, contacts(id,name,phone_number,tag)'

function isAdmin(role) {
  return ['owner', 'admin'].includes(role)
}

function cleanMessage(value) {
  const message = String(value || '').trim()
  if (!message || message.length > 4096) throw new Error('Reply must be between 1 and 4096 characters')
  return message
}

function cleanReason(value) {
  const reason = String(value || 'Requested by team member').trim()
  if (!reason || reason.length > 500) throw new Error('Handoff reason must be between 1 and 500 characters')
  return reason
}

async function getConversation(customerId, id) {
  const { data, error } = await supabase.from('conversations')
    .select(CONVERSATION_FIELDS)
    .eq('id', id)
    .eq('customer_id', customerId)
    .maybeSingle()
  if (error) throw error
  return data || null
}

async function memberForWorkspace(customerId, userId) {
  const [{ data: owner, error: ownerError }, { data: member, error: memberError }] = await Promise.all([
    supabase.from('customers').select('auth_user_id').eq('id', customerId).maybeSingle(),
    supabase.from('workspace_members').select('user_id,role').eq('customer_id', customerId).eq('user_id', userId).maybeSingle()
  ])
  if (ownerError || memberError) throw ownerError || memberError
  if (owner?.auth_user_id === userId) return { user_id: userId, role: 'owner' }
  return member || null
}

async function assertAssignableMember(customerId, userId) {
  if (!userId) return null
  const member = await memberForWorkspace(customerId, userId)
  if (!member) throw new Error('That team member does not belong to this workspace')
  return member
}

async function lastMessages(customerId, conversationIds) {
  if (!conversationIds.length) return new Map()
  const { data, error } = await supabase.from('messages')
    .select('conversation_id,message_body,direction,status,created_at')
    .eq('customer_id', customerId)
    .in('conversation_id', conversationIds)
    .order('created_at', { ascending: false })
  if (error) throw error
  const map = new Map()
  for (const message of data || []) {
    if (!map.has(message.conversation_id)) map.set(message.conversation_id, message)
  }
  return map
}

router.get('/members', async (req, res) => {
  try {
    const [{ data: workspace, error: workspaceError }, { data: memberships, error: memberError }] = await Promise.all([
      supabase.from('customers').select('auth_user_id').eq('id', req.workspace.customerId).single(),
      supabase.from('workspace_members').select('user_id,role').eq('customer_id', req.workspace.customerId)
    ])
    if (workspaceError || memberError) throw workspaceError || memberError
    const entries = new Map()
    if (workspace.auth_user_id) entries.set(workspace.auth_user_id, 'owner')
    for (const member of memberships || []) entries.set(member.user_id, member.role)
    const members = await Promise.all([...entries].map(async ([id, role]) => {
      const { data } = await supabase.auth.admin.getUserById(id)
      return { id, role, email: data?.user?.email || null, name: data?.user?.user_metadata?.name || null }
    }))
    return res.json(members)
  } catch {
    return res.status(500).json({ error: 'Unable to load workspace members' })
  }
})

router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase.from('conversations')
      .select(CONVERSATION_FIELDS)
      .eq('customer_id', req.workspace.customerId)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(100)
    if (error) throw error
    const previews = await lastMessages(req.workspace.customerId, (data || []).map((conversation) => conversation.id))
    return res.json((data || []).map((conversation) => ({ ...conversation, last_message: previews.get(conversation.id) || null })))
  } catch {
    return res.status(500).json({ error: 'Unable to load conversations' })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const conversation = await getConversation(req.workspace.customerId, req.params.id)
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' })
    const { data: messages, error } = await supabase.from('messages')
      .select('id,direction,to_number,from_number,message_body,status,created_at,meta_message_id')
      .eq('customer_id', req.workspace.customerId)
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: true })
    if (error) throw error
    return res.json({ conversation, messages: messages || [] })
  } catch {
    return res.status(500).json({ error: 'Unable to load this conversation' })
  }
})

router.post('/:id/read', async (req, res) => {
  try {
    const { data, error } = await supabase.from('conversations')
      .update({ unread_count: 0, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('customer_id', req.workspace.customerId)
      .select(CONVERSATION_FIELDS).maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Conversation not found' })
    return res.json({ conversation: data })
  } catch {
    return res.status(500).json({ error: 'Unable to mark this conversation read' })
  }
})

router.post('/:id/handoff', async (req, res) => {
  try {
    const conversation = await getConversation(req.workspace.customerId, req.params.id)
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' })
    const requestedAssignee = req.body?.assigned_user_id || null
    if (requestedAssignee && !isAdmin(req.workspace.role) && requestedAssignee !== req.workspace.userId) {
      return res.status(403).json({ error: 'Only owners and admins can assign another team member' })
    }
    await assertAssignableMember(req.workspace.customerId, requestedAssignee)
    const now = new Date().toISOString()
    const { data, error } = await supabase.from('conversations').update({
      status: 'needs_attention',
      control_mode: 'needs_attention',
      assigned_user_id: requestedAssignee,
      handoff_reason: cleanReason(req.body?.reason),
      handoff_at: now,
      updated_at: now
    }).eq('id', conversation.id).eq('customer_id', req.workspace.customerId).select(CONVERSATION_FIELDS).single()
    if (error) throw error
    await recordConversationEvent({ customerId: req.workspace.customerId, conversationId: conversation.id, actorUserId: req.workspace.userId, eventType: 'handoff_requested', metadata: { assigned: Boolean(requestedAssignee) } })
    return res.json({ conversation: data })
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Unable to request human attention' })
  }
})

router.post('/:id/take', async (req, res) => {
  try {
    const now = new Date().toISOString()
    const { data, error } = await supabase.from('conversations').update({
      status: 'open',
      control_mode: 'human',
      assigned_user_id: req.workspace.userId,
      taken_over_at: now,
      updated_at: now
    }).eq('id', req.params.id)
      .eq('customer_id', req.workspace.customerId)
      .eq('status', 'needs_attention')
      .eq('control_mode', 'needs_attention')
      .or(`assigned_user_id.is.null,assigned_user_id.eq.${req.workspace.userId}`)
      .select(CONVERSATION_FIELDS)
      .maybeSingle()
    if (error) throw error
    if (!data) {
      const current = await getConversation(req.workspace.customerId, req.params.id)
      if (!current) return res.status(404).json({ error: 'Conversation not found' })
      return res.status(409).json({ error: 'Another team member has already taken or changed this conversation', conversation: current })
    }
    await recordConversationEvent({ customerId: req.workspace.customerId, conversationId: data.id, actorUserId: req.workspace.userId, eventType: 'conversation_taken' })
    return res.json({ conversation: data })
  } catch {
    return res.status(500).json({ error: 'Unable to take this conversation' })
  }
})

router.patch('/:id/assignment', requireAdmin, async (req, res) => {
  try {
    const conversation = await getConversation(req.workspace.customerId, req.params.id)
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' })
    const assignedUserId = req.body?.assigned_user_id || null
    await assertAssignableMember(req.workspace.customerId, assignedUserId)
    const { data, error } = await supabase.from('conversations').update({
      assigned_user_id: assignedUserId,
      updated_at: new Date().toISOString()
    }).eq('id', conversation.id).eq('customer_id', req.workspace.customerId).select(CONVERSATION_FIELDS).single()
    if (error) throw error
    await recordConversationEvent({ customerId: req.workspace.customerId, conversationId: data.id, actorUserId: req.workspace.userId, eventType: 'assignment_changed', metadata: { assigned: Boolean(assignedUserId) } })
    return res.json({ conversation: data })
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Unable to update assignment' })
  }
})

router.post('/:id/resolve', async (req, res) => {
  try {
    const conversation = await getConversation(req.workspace.customerId, req.params.id)
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' })
    if (!mayResolve({ role: req.workspace.role, userId: req.workspace.userId, conversation })) {
      return res.status(403).json({ error: 'Only the assigned team member or an administrator can resolve this conversation' })
    }
    const now = new Date().toISOString()
    const { data, error } = await supabase.from('conversations').update({
      status: 'resolved',
      control_mode: 'human',
      resolved_at: now,
      resolved_by_user_id: req.workspace.userId,
      unread_count: 0,
      updated_at: now
    }).eq('id', conversation.id).eq('customer_id', req.workspace.customerId).select(CONVERSATION_FIELDS).single()
    if (error) throw error
    await recordConversationEvent({ customerId: req.workspace.customerId, conversationId: data.id, actorUserId: req.workspace.userId, eventType: 'conversation_resolved' })
    return res.json({ conversation: data })
  } catch {
    return res.status(500).json({ error: 'Unable to resolve this conversation' })
  }
})

router.post('/:id/reply', async (req, res) => {
  let conversation
  let message
  try {
    message = cleanMessage(req.body?.message)
    conversation = await getConversation(req.workspace.customerId, req.params.id)
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' })
    if (conversation.status === 'resolved' || conversation.control_mode !== 'human') {
      return res.status(409).json({ error: 'Take this conversation before sending a human reply' })
    }
    if (!isAdmin(req.workspace.role) && conversation.assigned_user_id !== req.workspace.userId) {
      return res.status(403).json({ error: 'Only the assigned team member can reply' })
    }
    const { data: contact, error: contactError } = await supabase.from('contacts')
      .select('id,phone_number').eq('id', conversation.contact_id).eq('customer_id', req.workspace.customerId).maybeSingle()
    if (contactError) throw contactError
    if (!contact) return res.status(409).json({ error: 'This conversation has no valid contact' })
    const { data: number, error: numberError } = await supabase.from('whatsapp_numbers')
      .select('id,phone_number_id,access_token').eq('id', conversation.whatsapp_number_id).eq('customer_id', req.workspace.customerId).eq('status', 'connected').maybeSingle()
    if (numberError) throw numberError
    if (!number) return res.status(409).json({ error: 'The WhatsApp connection for this conversation is unavailable' })

    const result = await sendTextMessage(number.phone_number_id, contact.phone_number, message, number.access_token)
    const now = new Date().toISOString()
    const { error: messageError } = await supabase.from('messages').insert({
      customer_id: req.workspace.customerId,
      whatsapp_number_id: number.id,
      contact_id: contact.id,
      conversation_id: conversation.id,
      direction: 'outbound',
      to_number: contact.phone_number,
      message_body: message,
      status: 'sent',
      meta_message_id: result?.messages?.[0]?.id || null
    })
    if (messageError) throw messageError
    const { data, error } = await supabase.from('conversations').update({
      last_message_at: now,
      last_outbound_at: now,
      updated_at: now
    }).eq('id', conversation.id).eq('customer_id', req.workspace.customerId).select(CONVERSATION_FIELDS).single()
    if (error) throw error
    await recordConversationEvent({ customerId: req.workspace.customerId, conversationId: conversation.id, actorUserId: req.workspace.userId, eventType: 'human_reply_sent' })
    return res.json({ conversation: data, message_status: 'sent' })
  } catch (error) {
    if (conversation && message) {
      const now = new Date().toISOString()
      await supabase.from('messages').insert({
        customer_id: req.workspace.customerId,
        whatsapp_number_id: conversation.whatsapp_number_id,
        contact_id: conversation.contact_id,
        conversation_id: conversation.id,
        direction: 'outbound',
        message_body: message,
        status: 'failed'
      })
      await supabase.from('conversations').update({ last_message_at: now, last_outbound_at: now, updated_at: now })
        .eq('id', conversation.id).eq('customer_id', req.workspace.customerId)
      await recordConversationEvent({ customerId: req.workspace.customerId, conversationId: conversation.id, actorUserId: req.workspace.userId, eventType: 'human_reply_failed' }).catch(() => {})
    }
    return res.status(502).json({ error: 'Unable to send this reply' })
  }
})

module.exports = router
