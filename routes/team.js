const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { requireAdmin, requireAuthenticated } = require('../middleware/auth')
const {
  normalizeEmail,
  cleanInvitableRole,
  hashInvitationToken,
  createInvitationCredential,
  isExpired,
  safeInvitation
} = require('../lib/teamInvitations')

function isAdmin(role) {
  return ['owner', 'admin'].includes(role)
}

function cleanToken(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(value)) throw new Error('Invitation link is invalid')
  return value
}

async function audit({ customerId, actorUserId = null, targetUserId = null, invitationId = null, eventType, metadata = {} }) {
  await supabase.from('workspace_audit_events').insert({
    customer_id: customerId,
    actor_user_id: actorUserId,
    target_user_id: targetUserId,
    invitation_id: invitationId,
    event_type: eventType,
    metadata
  })
}

async function expirePendingInvitations(customerId) {
  const now = new Date().toISOString()
  const { error } = await supabase.from('workspace_invitations')
    .update({ status: 'expired', updated_at: now })
    .eq('customer_id', customerId)
    .eq('status', 'pending')
    .lt('expires_at', now)
  if (error) throw error
}

async function workspaceOwnerAndMembers(customerId) {
  const [{ data: workspace, error: workspaceError }, { data: memberships, error: membershipsError }] = await Promise.all([
    supabase.from('customers').select('id,auth_user_id').eq('id', customerId).maybeSingle(),
    supabase.from('workspace_members').select('id,customer_id,user_id,role,created_at').eq('customer_id', customerId)
  ])
  if (workspaceError || membershipsError) throw workspaceError || membershipsError
  if (!workspace) return null

  const entries = new Map()
  if (workspace.auth_user_id) entries.set(workspace.auth_user_id, { user_id: workspace.auth_user_id, role: 'owner', membership_id: null, created_at: null })
  for (const membership of memberships || []) {
    const current = entries.get(membership.user_id)
    if (!current || membership.role === 'owner') {
      entries.set(membership.user_id, { ...membership, membership_id: membership.id })
    }
  }

  const members = await Promise.all([...entries.values()].map(async (member) => {
    const { data } = await supabase.auth.admin.getUserById(member.user_id)
    return {
      id: member.user_id,
      email: data?.user?.email || null,
      name: data?.user?.user_metadata?.name || null,
      role: member.role,
      status: 'active',
      created_at: member.created_at
    }
  }))
  return { workspace, members }
}

async function memberForWorkspace(customerId, userId) {
  const result = await workspaceOwnerAndMembers(customerId)
  if (!result) return null
  return result.members.find((member) => member.id === userId) || null
}

async function sendInvitationEmail({ email, role, token }) {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM_EMAIL
  const baseUrl = process.env.APP_BASE_URL
  if (!apiKey || !from || !baseUrl) throw new Error('Invitation email is not configured')

  const link = `${baseUrl.replace(/\\/$/, '')}/#invite=${encodeURIComponent(token)}`
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [email],
      subject: 'You are invited to join a ZedPing workspace',
      html: `<p>You have been invited to join a ZedPing workspace as an <strong>${role}</strong>.</p><p><a href="${link}">Accept invitation</a></p><p>This invitation expires in 7 days.</p>`
    })
  })
  if (!response.ok) throw new Error('Unable to send the invitation email')
}

async function activeInvitation(customerId, invitationId) {
  await expirePendingInvitations(customerId)
  const { data, error } = await supabase.from('workspace_invitations')
    .select('*').eq('id', invitationId).eq('customer_id', customerId).maybeSingle()
  if (error) throw error
  return data || null
}

router.get('/members', async (req, res) => {
  try {
    const result = await workspaceOwnerAndMembers(req.workspace.customerId)
    if (!result) return res.status(404).json({ error: 'Workspace not found' })
    return res.json(result.members)
  } catch {
    return res.status(500).json({ error: 'Unable to load workspace members' })
  }
})

router.get('/invitations', requireAdmin, async (req, res) => {
  try {
    await expirePendingInvitations(req.workspace.customerId)
    const { data, error } = await supabase.from('workspace_invitations')
      .select('id,email_normalized,intended_role,status,expires_at,created_at,last_sent_at,resend_count')
      .eq('customer_id', req.workspace.customerId)
      .in('status', ['pending', 'expired'])
      .order('created_at', { ascending: false })
    if (error) throw error
    return res.json((data || []).map(safeInvitation))
  } catch {
    return res.status(500).json({ error: 'Unable to load invitations' })
  }
})

router.post('/invitations', requireAdmin, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email)
    const role = cleanInvitableRole(req.body?.role)
    await expirePendingInvitations(req.workspace.customerId)

    const { data: existing, error: existingError } = await supabase.from('workspace_invitations')
      .select('id').eq('customer_id', req.workspace.customerId).eq('email_normalized', email).eq('status', 'pending').maybeSingle()
    if (existingError) throw existingError
    if (existing) return res.status(409).json({ error: 'A pending invitation already exists for this email address' })

    const credential = createInvitationCredential()
    if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL || !process.env.APP_BASE_URL) {
      return res.status(503).json({ error: 'Invitation email is not configured' })
    }

    const { data: invitation, error } = await supabase.from('workspace_invitations').insert({
      customer_id: req.workspace.customerId,
      email_normalized: email,
      intended_role: role,
      invited_by_user_id: req.workspace.userId,
      token_hash: credential.tokenHash,
      status: 'pending',
      expires_at: credential.expiresAt,
      last_sent_at: new Date().toISOString()
    }).select('*').single()
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'A pending invitation already exists for this email address' })
      throw error
    }

    try {
      await sendInvitationEmail({ email, role, token: credential.token })
    } catch {
      return res.status(502).json({ error: 'Invitation was created but the email could not be delivered. Use resend after email configuration is corrected.' })
    }
    await audit({ customerId: req.workspace.customerId, actorUserId: req.workspace.userId, invitationId: invitation.id, eventType: 'invitation_created', metadata: { role } })
    return res.status(201).json({ invitation: safeInvitation(invitation) })
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Unable to create invitation' })
  }
})

router.post('/invitations/:id/resend', requireAdmin, async (req, res) => {
  try {
    const invitation = await activeInvitation(req.workspace.customerId, req.params.id)
    if (!invitation || invitation.status !== 'pending') return res.status(404).json({ error: 'Pending invitation not found' })

    const credential = createInvitationCredential()
    const now = new Date().toISOString()
    const { data: updated, error } = await supabase.from('workspace_invitations').update({
      token_hash: credential.tokenHash,
      expires_at: credential.expiresAt,
      last_sent_at: now,
      resend_count: Number(invitation.resend_count || 0) + 1,
      updated_at: now
    }).eq('id', invitation.id).eq('customer_id', req.workspace.customerId).eq('status', 'pending').select('*').single()
    if (error) throw error

    try {
      await sendInvitationEmail({ email: updated.email_normalized, role: updated.intended_role, token: credential.token })
    } catch {
      return res.status(502).json({ error: 'Invitation token was rotated but the email could not be delivered. Resend again after email configuration is corrected.' })
    }
    await audit({ customerId: req.workspace.customerId, actorUserId: req.workspace.userId, invitationId: updated.id, eventType: 'invitation_resent', metadata: { role: updated.intended_role } })
    return res.json({ invitation: safeInvitation(updated) })
  } catch {
    return res.status(400).json({ error: 'Unable to resend invitation' })
  }
})

router.post('/invitations/:id/revoke', requireAdmin, async (req, res) => {
  try {
    const invitation = await activeInvitation(req.workspace.customerId, req.params.id)
    if (!invitation || invitation.status !== 'pending') return res.status(404).json({ error: 'Pending invitation not found' })
    const now = new Date().toISOString()
    const { data, error } = await supabase.from('workspace_invitations').update({
      status: 'revoked', revoked_at: now, revoked_by_user_id: req.workspace.userId, updated_at: now
    }).eq('id', invitation.id).eq('customer_id', req.workspace.customerId).eq('status', 'pending').select('*').single()
    if (error) throw error
    await audit({ customerId: req.workspace.customerId, actorUserId: req.workspace.userId, invitationId: invitation.id, eventType: 'invitation_revoked' })
    return res.json({ invitation: safeInvitation(data) })
  } catch {
    return res.status(400).json({ error: 'Unable to revoke invitation' })
  }
})

router.patch('/members/:userId/role', requireAdmin, async (req, res) => {
  try {
    const role = cleanInvitableRole(req.body?.role)
    const target = await memberForWorkspace(req.workspace.customerId, req.params.userId)
    if (!target) return res.status(404).json({ error: 'Team member not found' })
    if (target.role === 'owner') return res.status(403).json({ error: 'Owner role cannot be changed' })

    const { data, error } = await supabase.from('workspace_members').update({ role })
      .eq('customer_id', req.workspace.customerId).eq('user_id', req.params.userId).neq('role', 'owner')
      .select('user_id,role,created_at').single()
    if (error) throw error
    await audit({ customerId: req.workspace.customerId, actorUserId: req.workspace.userId, targetUserId: data.user_id, eventType: 'member_role_changed', metadata: { role } })
    return res.json({ member: { id: data.user_id, role: data.role, status: 'active', created_at: data.created_at } })
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Unable to change member role' })
  }
})

router.delete('/members/:userId', requireAdmin, async (req, res) => {
  try {
    const target = await memberForWorkspace(req.workspace.customerId, req.params.userId)
    if (!target) return res.status(404).json({ error: 'Team member not found' })
    if (target.role === 'owner') return res.status(403).json({ error: 'Owner cannot be removed' })

    const { error } = await supabase.from('workspace_members').delete()
      .eq('customer_id', req.workspace.customerId).eq('user_id', req.params.userId).neq('role', 'owner')
    if (error) throw error
    await audit({ customerId: req.workspace.customerId, actorUserId: req.workspace.userId, targetUserId: req.params.userId, eventType: 'member_removed' })
    return res.status(204).send()
  } catch {
    return res.status(400).json({ error: 'Unable to remove member' })
  }
})

async function acceptInvitation(req, res) {
  try {
    if (!req.authUser.email_confirmed_at) return res.status(403).json({ error: 'Verify your email before accepting this invitation' })
    const token = cleanToken(req.body?.token)
    const tokenHash = hashInvitationToken(token)
    const { data: invitation, error } = await supabase.from('workspace_invitations').select('*').eq('token_hash', tokenHash).maybeSingle()
    if (error) throw error
    if (!invitation) return res.status(400).json({ error: 'Invitation is invalid, revoked, or already completed' })
    const email = normalizeEmail(req.authUser.email)
    if (email !== invitation.email_normalized) return res.status(403).json({ error: 'Sign in with the email address that received this invitation' })

    const { data: workspace, error: workspaceError } = await supabase.from('customers').select('id,auth_user_id').eq('id', invitation.customer_id).maybeSingle()
    if (workspaceError || !workspace) return res.status(404).json({ error: 'Invitation workspace is unavailable' })

    // Browser auth restoration can legitimately replay the same completed link.
    // Treat only the same verified recipient's accepted invitation as idempotent.
    if (invitation.status === 'accepted' && invitation.accepted_by_user_id === req.authUser.id) {
      const acceptedMembership = await memberForWorkspace(invitation.customer_id, req.authUser.id)
      if (acceptedMembership) {
        return res.json({ workspace_id: invitation.customer_id, membership: { id: acceptedMembership.id, role: acceptedMembership.role }, idempotent: true })
      }
    }
    if (invitation.status !== 'pending') return res.status(400).json({ error: 'Invitation is invalid, revoked, or already completed' })
    if (isExpired(invitation.expires_at)) {
      await supabase.from('workspace_invitations').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('id', invitation.id).eq('status', 'pending')
      return res.status(410).json({ error: 'This invitation has expired' })
    }

    const existing = await memberForWorkspace(invitation.customer_id, req.authUser.id)
    const now = new Date().toISOString()
    if (existing) {
      await supabase.from('workspace_invitations').update({
        status: 'accepted', accepted_at: now, accepted_by_user_id: req.authUser.id, updated_at: now
      }).eq('id', invitation.id).eq('status', 'pending')
      await audit({ customerId: invitation.customer_id, actorUserId: req.authUser.id, targetUserId: req.authUser.id, invitationId: invitation.id, eventType: 'invitation_accepted_existing_member', metadata: { role: existing.role } })
      return res.json({ workspace_id: invitation.customer_id, membership: { id: existing.id, role: existing.role }, idempotent: true })
    }

    const { data: membership, error: memberError } = await supabase.from('workspace_members').insert({
      customer_id: invitation.customer_id, user_id: req.authUser.id, role: invitation.intended_role
    }).select('id,user_id,role,created_at').single()

    let effectiveMembership = membership
    if (memberError) {
      if (memberError.code !== '23505') throw memberError
      const concurrent = await memberForWorkspace(invitation.customer_id, req.authUser.id)
      if (!concurrent) throw memberError
      effectiveMembership = { id: concurrent.id, user_id: concurrent.id, role: concurrent.role, created_at: concurrent.created_at }
    }

    await supabase.from('workspace_invitations').update({
      status: 'accepted', accepted_at: now, accepted_by_user_id: req.authUser.id, updated_at: now
    }).eq('id', invitation.id).eq('status', 'pending')
    await audit({ customerId: invitation.customer_id, actorUserId: req.authUser.id, targetUserId: req.authUser.id, invitationId: invitation.id, eventType: 'invitation_accepted', metadata: { role: effectiveMembership.role } })
    return res.status(201).json({ workspace_id: invitation.customer_id, membership: { id: effectiveMembership.user_id, role: effectiveMembership.role }, idempotent: false })
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Unable to accept invitation' })
  }
}

module.exports = { router, acceptInvitation }
