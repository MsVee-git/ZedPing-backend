const crypto = require('crypto')

const INVITABLE_ROLES = new Set(['admin', 'member'])
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000

function normalizeEmail(value) {
  if (typeof value !== 'string') throw new Error('Enter a valid email address')
  const email = value.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error('Enter a valid email address')
  }
  return email
}

function cleanInvitableRole(value) {
  if (!INVITABLE_ROLES.has(value)) throw new Error('Invitation role must be admin or member')
  return value
}

function hashInvitationToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function createInvitationCredential(now = new Date()) {
  const token = crypto.randomBytes(32).toString('base64url')
  return {
    token,
    tokenHash: hashInvitationToken(token),
    expiresAt: new Date(now.getTime() + INVITATION_TTL_MS).toISOString()
  }
}

function isExpired(expiresAt, now = new Date()) {
  return new Date(expiresAt).getTime() <= now.getTime()
}

function safeInvitation(invitation) {
  return {
    id: invitation.id,
    email: invitation.email_normalized,
    role: invitation.intended_role,
    status: invitation.status,
    expires_at: invitation.expires_at,
    created_at: invitation.created_at,
    last_sent_at: invitation.last_sent_at,
    resend_count: invitation.resend_count
  }
}

module.exports = {
  INVITATION_TTL_MS,
  normalizeEmail,
  cleanInvitableRole,
  hashInvitationToken,
  createInvitationCredential,
  isExpired,
  safeInvitation
}
