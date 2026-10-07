const { resolveWhatsAppAccessToken } = require('../lib/whatsappCredentials')
const express = require('express')
const multer = require('multer')
const router = express.Router()
const supabase = require('../lib/supabase')
const { requireAdmin } = require('../middleware/auth')
const { sendTextMessage, sendImageMessage, sendDocumentMessage, sendLocationMessage, uploadWhatsAppMedia } = require('../lib/whatsapp')
const { VIEWS, applyView, runBulk } = require('../lib/inboxTriage')
const { mayResolve } = require('../lib/conversationState')
const { recordConversationEvent } = require('../lib/conversationEvents')
const { handoffActiveFlowForConversation } = require('../lib/chatbotExecution')
const { closeActiveAiSessionsForConversation } = require('../lib/aiAgentSessions')
const { storedInboundAttachment, publicInboundMedia } = require('../lib/inboundMedia')
const { fetchWhatsAppMedia, WhatsAppMediaError } = require('../lib/whatsappMedia')
const { validateOutboundUpload, parseLocation, storedAttachment, publicMessageMedia } = require('../lib/conversationMedia')

function parseConversationUpload(req, res, next) {
  // Some isolated route tests intentionally provide a no-op multer shim. The
  // production dependency always exposes memoryStorage; defer construction so
  // that importing unrelated Inbox handlers does not depend on upload setup.
  if (typeof multer.memoryStorage !== 'function') return next()
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } })
  upload.single('file')(req, res, error => {
    if (error) return res.status(400).json({ error: 'Attachment must be one file up to 10 MB' })
    next()
  })
}

const CONVERSATION_FIELDS = 'id, customer_id, whatsapp_number_id, contact_id, status, control_mode, assigned_user_id, handoff_reason, handoff_at, taken_over_at, resolved_at, resolved_by_user_id, last_message_at, last_inbound_at, last_outbound_at, unread_count, created_at, updated_at, contacts(id,name,phone_number,tag,marketing_opted_out)'

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

function requestedReplyMessageId(value) {
  const id = String(value || '').trim()
  if (!id) return null
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Reply target is invalid')
  return id
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

async function resolveOutgoingReplyContext(customerId, conversation, value) {
  const id = requestedReplyMessageId(value)
  if (!id) return null
  const { data, error } = await supabase.from('messages').select('id,meta_message_id')
    .eq('id', id).eq('customer_id', customerId).eq('whatsapp_number_id', conversation.whatsapp_number_id).eq('conversation_id', conversation.id).maybeSingle()
  if (error) throw error
  if (!data?.meta_message_id) { const failure = new Error('This message is not available to reply to'); failure.status = 409; throw failure }
  return data
}

function publicReplyMessage(reply) {
  if (!reply) return null
  return { id: reply.id, direction: reply.direction, message_body: reply.message_body || null, status: reply.status || null, created_at: reply.created_at || null, inbound_media: publicInboundMedia(reply.inbound_media), outbound_media: publicMessageMedia(reply.outbound_media) }
}

function safeDiagnosticCode(error) {
  const value = String(error?.code || error?.status || error?.name || 'unknown')
  return /^[A-Za-z0-9_:-]{1,64}$/.test(value) ? value : 'unknown'
}

function safeUndefinedIdentifier(error) {
  if (safeDiagnosticCode(error) !== '42703') return null
  // PostgreSQL's undefined-column form names only a schema identifier. Parse
  // that allowlisted token without serializing any raw database error field.
  const raw = String(error?.message || error?.details || error?.hint || '')
  const match = raw.match(/\b(?:column|identifier)\s+["']?([A-Za-z_][A-Za-z0-9_$]{0,62}(?:\.[A-Za-z_][A-Za-z0-9_$]{0,62})?)["']?\s+(?:does not exist|is undefined)\b/i)
  return match?.[1] || null
}

function logConversationDetailFailure(req, stage, error) {
  // Keep this useful in Railway without recording request data, message data,
  // credentials, or raw upstream error text.
  console.error(JSON.stringify({
    event: 'conversation_detail_load_failed',
    stage,
    workspace_id: req.workspace?.customerId || null,
    conversation_id: req.params?.id || null,
    error_code: safeDiagnosticCode(error),
    undefined_identifier: safeUndefinedIdentifier(error)
  }))
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

router.get('/counts', async (req, res) => {
  try {
    const entries = await Promise.all(VIEWS.map(async view => {
      const { count, error } = await applyView(supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('customer_id', req.workspace.customerId), view, req.workspace.userId)
      if (error) throw error
      return [view, count || 0]
    }))
    return res.json(Object.fromEntries(entries))
  } catch { return res.status(500).json({ error: 'Unable to load Inbox counts' }) }
})

router.post('/bulk', async (req, res) => {
  try {
    const { status, ...result } = await runBulk({ db: supabase, fields: CONVERSATION_FIELDS, workspace: req.workspace, body: req.body, assertMember: assertAssignableMember, recordEvent: recordConversationEvent })
    return res.status(status).json(result)
  } catch { return res.status(400).json({ error: 'Invalid bulk request or team member. Refresh and try again.' }) }
})

router.get('/', async (req, res) => {
  try {
    const view = String(req.query.view || 'all')
    if (!VIEWS.includes(view)) return res.status(400).json({ error: 'Conversation view is invalid' })
    const paged = req.query.offset !== undefined
    const offset = Number(req.query.offset || 0), size = paged ? 50 : 100
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) return res.status(400).json({ error: 'Invalid conversation page' })
    let query = applyView(supabase.from('conversations')
      .select(CONVERSATION_FIELDS + ',messages(message_body,direction,status,created_at)')
      .eq('customer_id', req.workspace.customerId)
      .eq('messages.customer_id', req.workspace.customerId)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
      .order('created_at', { referencedTable: 'messages', ascending: false })
      .limit(1, { referencedTable: 'messages' }), view, req.workspace.userId)
    query = paged ? query.range(offset, offset + size) : query.limit(size)
    const { data, error } = await query
    if (error) throw error
    const conversations = (data || []).slice(0, size).map(({ messages, ...conversation }) => ({ ...conversation, last_message: messages?.[0] || null }))
    return res.json(paged ? { conversations, next_offset: (data || []).length > size ? offset + size : null } : conversations)
  } catch { return res.status(500).json({ error: 'Unable to load conversations' }) }
})

router.get('/:id', async (req, res) => {
  let stage = 'authorization_workspace_resolution'
  try {
    if (!req.workspace?.customerId) {
      const error = new Error('Workspace is unavailable')
      error.code = 'WORKSPACE_UNAVAILABLE'
      throw error
    }
    stage = 'conversation_lookup'
    const conversation = await getConversation(req.workspace.customerId, req.params.id)
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' })
    stage = 'whatsapp_number_resolution'
    if (!conversation.whatsapp_number_id) {
      const error = new Error('Conversation WhatsApp number is unavailable')
      error.code = 'CONVERSATION_NUMBER_UNAVAILABLE'
      throw error
    }
    stage = 'normal_messages_query'
    const { data: messages, error } = await supabase.from('messages')
      .select('id,direction,to_number,from_number,message_body,status,created_at,meta_message_id,inbound_media,outbound_media,reply_to_message_id')
      .eq('customer_id', req.workspace.customerId)
      .eq('whatsapp_number_id', conversation.whatsapp_number_id)
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: true })
    if (error) throw error
    const replyIds = [...new Set((messages || []).map(message => message.reply_to_message_id).filter(Boolean))]
    let repliesById = new Map()
    if (replyIds.length) {
      stage = 'reply_parent_lookup'
      const { data: replies, error: replyError } = await supabase.from('messages')
        .select('id,direction,message_body,status,created_at,inbound_media,outbound_media')
        .eq('customer_id', req.workspace.customerId)
        .eq('whatsapp_number_id', conversation.whatsapp_number_id)
        .eq('conversation_id', conversation.id)
        .in('id', replyIds)
      if (replyError) throw replyError
      repliesById = new Map((replies || []).map(reply => [reply.id, reply]))
    }
    const publicMessages = (messages || []).map(({ inbound_media, outbound_media, reply_to_message_id, ...message }) => {
      let publicInbound, publicOutbound
      try {
        publicInbound = publicInboundMedia(inbound_media)
        publicOutbound = publicMessageMedia(outbound_media)
      } catch (error) {
        stage = 'rich_media_transformation'
        throw error
      }
      let replyTo
      try {
        replyTo = publicReplyMessage(repliesById.get(reply_to_message_id))
      } catch (error) {
        stage = 'reply_preview_construction'
        throw error
      }
      return { ...message, inbound_media: publicInbound, outbound_media: publicOutbound, reply_to: replyTo }
    })
    stage = 'final_response_construction'
    return res.json({ conversation, messages: publicMessages })
  } catch (error) {
    logConversationDetailFailure(req, stage, error)
    return res.status(500).json({ error: 'Unable to load this conversation' })
  }
})

// The browser supplies only the conversation and message IDs. Both are scoped
// to the authenticated workspace before the stored Meta media ID is used.
router.get('/:id/messages/:messageId/media', async (req, res) => {
  try {
    const conversation = await getConversation(req.workspace.customerId, req.params.id)
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' })
    const { data: message, error } = await supabase.from('messages')
      .select('id,customer_id,whatsapp_number_id,conversation_id,direction,inbound_media,outbound_media')
      .eq('id', req.params.messageId)
      .eq('customer_id', req.workspace.customerId)
      .eq('conversation_id', conversation.id)
      .maybeSingle()
    if (error) throw error
    const attachment = message?.direction === 'inbound' ? storedInboundAttachment(message.inbound_media) : storedAttachment(message?.outbound_media)
    if (!attachment) return res.status(404).json({ error: 'Attachment is unavailable' })
    const { data: number, error: numberError } = await supabase.from('whatsapp_numbers')
      .select('id,customer_id,phone_number_id,access_token,status,provisioning_state,provisioned_at')
      .eq('id', message.whatsapp_number_id)
      .eq('customer_id', req.workspace.customerId)
      .eq('status', 'connected')
      .maybeSingle()
    if (numberError) throw numberError
    if (!number) return res.status(404).json({ error: 'Attachment is unavailable' })
    const accessToken = await resolveWhatsAppAccessToken(number, { customerId: req.workspace.customerId })
    if (!accessToken) return res.status(404).json({ error: 'Attachment is unavailable' })
    const media = await fetchWhatsAppMedia({ mediaId: attachment.mediaId, accessToken, expectedType: attachment.type })
    const mimeType = media.mimeType || attachment.mimeType || 'application/octet-stream'
    res.set({ 'Content-Type': mimeType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', ...(attachment.type === 'document' ? { 'Content-Disposition': `attachment; filename="${String(attachment.filename || 'document').replace(/["\\\r\n]/g, '_')}"` } : {}) })
    return res.status(200).send(media.buffer)
  } catch (error) {
    if (error instanceof WhatsAppMediaError) return res.status(error.status).json({ error: error.message })
    return res.status(502).json({ error: 'Attachment could not be loaded' })
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
    await handoffActiveFlowForConversation({ customerId: req.workspace.customerId, whatsappNumberId: conversation.whatsapp_number_id, conversationId: conversation.id, reason: 'manual_handoff' })
    await closeActiveAiSessionsForConversation({ customerId: req.workspace.customerId, whatsappNumberId: conversation.whatsapp_number_id, conversationId: conversation.id, contactPhone: conversation.contacts?.phone_number, reason: 'manual_handoff' })
    await recordConversationEvent({ customerId: req.workspace.customerId, conversationId: conversation.id, actorUserId: req.workspace.userId, eventType: 'handoff_requested', metadata: { assigned: Boolean(requestedAssignee) } })
    return res.json({ conversation: data })
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Unable to request human attention' })
  }
})

router.post('/:id/take', async (req, res) => {
  try {
    const fromAutomation = req.body?.from_automation === true
    const now = new Date().toISOString()
    const { data, error } = await supabase.from('conversations').update({
      status: 'open',
      control_mode: 'human',
      assigned_user_id: req.workspace.userId,
      taken_over_at: now,
      updated_at: now
    }).eq('id', req.params.id)
      .eq('customer_id', req.workspace.customerId)
      .eq('status', fromAutomation ? 'open' : 'needs_attention')
      .eq('control_mode', fromAutomation ? 'automation' : 'needs_attention')
      .or(`assigned_user_id.is.null,assigned_user_id.eq.${req.workspace.userId}`)
      .select(CONVERSATION_FIELDS)
      .maybeSingle()
    if (error) throw error
    if (!data) {
      const current = await getConversation(req.workspace.customerId, req.params.id)
      if (!current) return res.status(404).json({ error: 'Conversation not found' })
      return res.status(409).json({ error: 'Another team member has already taken or changed this conversation', conversation: current })
    }
    await handoffActiveFlowForConversation({ customerId: req.workspace.customerId, whatsappNumberId: data.whatsapp_number_id, conversationId: data.id, reason: 'manual_takeover' })
    await closeActiveAiSessionsForConversation({ customerId: req.workspace.customerId, whatsappNumberId: data.whatsapp_number_id, conversationId: data.id, contactPhone: data.contacts?.phone_number, reason: 'manual_takeover' })
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

router.post('/:id/reopen', async (req, res) => {
  try {
    const now = new Date().toISOString()
    const { data, error } = await supabase.from('conversations').update({
      status: 'open',
      control_mode: 'human',
      assigned_user_id: req.workspace.userId,
      taken_over_at: now,
      resolved_at: null,
      resolved_by_user_id: null,
      updated_at: now
    }).eq('id', req.params.id)
      .eq('customer_id', req.workspace.customerId)
      .eq('status', 'resolved')
      .select(CONVERSATION_FIELDS)
      .maybeSingle()
    if (error) throw error
    if (!data) {
      const current = await getConversation(req.workspace.customerId, req.params.id)
      if (!current) return res.status(404).json({ error: 'Conversation not found' })
      return res.status(409).json({ error: 'This conversation is no longer resolved', conversation: current })
    }
    await recordConversationEvent({ customerId: req.workspace.customerId, conversationId: data.id, actorUserId: req.workspace.userId, eventType: 'conversation_reopened_by_human' })
    return res.json({ conversation: data })
  } catch {
    return res.status(500).json({ error: 'Unable to reopen this conversation' })
  }
})

router.post('/:id/reply', async (req, res) => {
  let conversation
  let message
  let replyTo
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
      .select('id,customer_id,phone_number_id,access_token,provisioning_state,provisioned_at').eq('id', conversation.whatsapp_number_id).eq('customer_id', req.workspace.customerId).eq('status', 'connected').maybeSingle()
    if (numberError) throw numberError
    if (!number) return res.status(409).json({ error: 'The WhatsApp connection for this conversation is unavailable' })
    replyTo = await resolveOutgoingReplyContext(req.workspace.customerId, conversation, req.body?.reply_to_message_id)

    const result = await sendTextMessage(number.phone_number_id, contact.phone_number, message, await resolveWhatsAppAccessToken(number, { customerId: req.workspace.customerId }), replyTo?.meta_message_id)
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
      meta_message_id: result?.messages?.[0]?.id || null,
      reply_to_message_id: replyTo?.id || null
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
        reply_to_message_id: replyTo?.id || null,
        status: 'failed'
      })
      await supabase.from('conversations').update({ last_message_at: now, last_outbound_at: now, updated_at: now })
        .eq('id', conversation.id).eq('customer_id', req.workspace.customerId)
      await recordConversationEvent({ customerId: req.workspace.customerId, conversationId: conversation.id, actorUserId: req.workspace.userId, eventType: 'human_reply_failed' }).catch(() => {})
    }
    return res.status(502).json({ error: 'Unable to send this reply' })
  }
})

async function humanReplyTarget(req) {
  const conversation = await getConversation(req.workspace.customerId, req.params.id)
  if (!conversation) {
    const error = new Error('Conversation not found'); error.status = 404; throw error
  }
  if (conversation.status === 'resolved' || conversation.control_mode !== 'human') {
    const error = new Error('Take this conversation before sending a human reply'); error.status = 409; throw error
  }
  if (!isAdmin(req.workspace.role) && conversation.assigned_user_id !== req.workspace.userId) {
    const error = new Error('Only the assigned team member can reply'); error.status = 403; throw error
  }
  const { data: contact, error: contactError } = await supabase.from('contacts')
    .select('id,phone_number').eq('id', conversation.contact_id).eq('customer_id', req.workspace.customerId).maybeSingle()
  if (contactError) throw contactError
  if (!contact) { const error = new Error('This conversation has no valid contact'); error.status = 409; throw error }
  const { data: number, error: numberError } = await supabase.from('whatsapp_numbers')
    .select('id,customer_id,phone_number_id,access_token,provisioning_state,provisioned_at').eq('id', conversation.whatsapp_number_id).eq('customer_id', req.workspace.customerId).eq('status', 'connected').maybeSingle()
  if (numberError) throw numberError
  if (!number) { const error = new Error('The WhatsApp connection for this conversation is unavailable'); error.status = 409; throw error }
  return { conversation, contact, number }
}

async function recordHumanRichMessage({ workspace, target, messageBody, media, metaResult, eventType, replyTo = null }) {
  const now = new Date().toISOString()
  const { error: messageError } = await supabase.from('messages').insert({
    customer_id: workspace.customerId, whatsapp_number_id: target.number.id, contact_id: target.contact.id,
    conversation_id: target.conversation.id, direction: 'outbound', to_number: target.contact.phone_number,
    message_body: messageBody || null, outbound_media: media, status: 'sent', meta_message_id: metaResult?.messages?.[0]?.id || null, reply_to_message_id: replyTo?.id || null
  })
  if (messageError) throw messageError
  const { data: conversation, error } = await supabase.from('conversations').update({ last_message_at: now, last_outbound_at: now, updated_at: now })
    .eq('id', target.conversation.id).eq('customer_id', workspace.customerId).select(CONVERSATION_FIELDS).single()
  if (error) throw error
  await recordConversationEvent({ customerId: workspace.customerId, conversationId: target.conversation.id, actorUserId: workspace.userId, eventType })
  return conversation
}

router.post('/:id/media', parseConversationUpload, async (req, res) => {
  let target
  try {
    target = await humanReplyTarget(req)
    const replyTo = await resolveOutgoingReplyContext(req.workspace.customerId, target.conversation, req.body?.reply_to_message_id)
    const attachment = validateOutboundUpload(req.file, String(req.body?.type || '').toLowerCase(), req.body?.caption)
    const accessToken = await resolveWhatsAppAccessToken(target.number, { customerId: req.workspace.customerId })
    if (!accessToken) return res.status(409).json({ error: 'The WhatsApp connection for this conversation is unavailable' })
    const mediaId = await uploadWhatsAppMedia(target.number.phone_number_id, { ...attachment.file, mimetype: attachment.mime_type, originalname: attachment.filename }, accessToken)
    const metaResult = attachment.type === 'image'
      ? await sendImageMessage(target.number.phone_number_id, target.contact.phone_number, { id: mediaId, caption: attachment.caption }, accessToken, replyTo?.meta_message_id)
      : await sendDocumentMessage(target.number.phone_number_id, target.contact.phone_number, { id: mediaId, caption: attachment.caption, filename: attachment.filename }, accessToken, replyTo?.meta_message_id)
    const outboundMedia = { type: attachment.type, media_id: mediaId, mime_type: attachment.mime_type, filename: attachment.filename, caption: attachment.caption }
    const conversation = await recordHumanRichMessage({ workspace: req.workspace, target, messageBody: attachment.caption, media: outboundMedia, metaResult, eventType: 'human_attachment_sent', replyTo })
    return res.json({ conversation, message_status: 'sent' })
  } catch (error) {
    return res.status(error.status || 502).json({ error: error.status ? error.message : 'Unable to send this attachment' })
  }
})

router.post('/:id/location', async (req, res) => {
  try {
    const target = await humanReplyTarget(req)
    const replyTo = await resolveOutgoingReplyContext(req.workspace.customerId, target.conversation, req.body?.reply_to_message_id)
    const location = parseLocation(req.body)
    const accessToken = await resolveWhatsAppAccessToken(target.number, { customerId: req.workspace.customerId })
    if (!accessToken) return res.status(409).json({ error: 'The WhatsApp connection for this conversation is unavailable' })
    const metaResult = await sendLocationMessage(target.number.phone_number_id, target.contact.phone_number, location, accessToken, replyTo?.meta_message_id)
    const conversation = await recordHumanRichMessage({ workspace: req.workspace, target, messageBody: null, media: location, metaResult, eventType: 'human_location_sent', replyTo })
    return res.json({ conversation, message_status: 'sent' })
  } catch (error) {
    return res.status(error.status || 502).json({ error: error.status ? error.message : 'Unable to send this location' })
  }
})

module.exports = router

