const test = require('node:test')
const assert = require('node:assert/strict')
const {
  normalizeEmail,
  cleanInvitableRole,
  hashInvitationToken,
  createInvitationCredential,
  isExpired,
  safeInvitation
} = require('../lib/teamInvitations')

test('invitation credentials are opaque, hashed, and expire in seven days', () => {
  const credential = createInvitationCredential()
  assert.match(credential.token, /^[A-Za-z0-9_-]{32,}$/)
  assert.equal(hashInvitationToken(credential.token), credential.tokenHash)
  const lifetime = new Date(credential.expiresAt).getTime() - Date.now()
  assert.ok(lifetime > 6.9 * 24 * 60 * 60 * 1000)
  assert.ok(lifetime < 7.1 * 24 * 60 * 60 * 1000)
})

test('resend credentials rotate hashes so a previous acceptance credential is invalid', () => {
  const first = createInvitationCredential()
  const second = createInvitationCredential()
  assert.notEqual(first.token, second.token)
  assert.notEqual(first.tokenHash, second.tokenHash)
  assert.notEqual(hashInvitationToken(first.token), second.tokenHash)
})

test('only admin or member roles are invitable and emails are normalized', () => {
  assert.equal(normalizeEmail('  Team@Example.com '), 'team@example.com')
  assert.equal(cleanInvitableRole('admin'), 'admin')
  assert.equal(cleanInvitableRole('member'), 'member')
  assert.throws(() => cleanInvitableRole('owner'))
  assert.throws(() => normalizeEmail('not-an-email'))
})

test('safe invitation responses never expose an acceptance credential', () => {
  const response = safeInvitation({
    id: 'invite-id',
    email_normalized: 'person@example.com',
    intended_role: 'member',
    status: 'pending',
    expires_at: '2026-10-01T00:00:00.000Z',
    created_at: '2026-09-24T00:00:00.000Z',
    last_sent_at: null,
    resend_count: 1,
    token_hash: 'must-not-be-exposed'
  })
  assert.deepEqual(Object.keys(response).sort(), ['created_at', 'email_normalized', 'expires_at', 'id', 'intended_role', 'last_sent_at', 'resend_count', 'status'])
  assert.equal(response.token_hash, undefined)
})

test('expiration recognises a past invitation', () => {
  assert.equal(isExpired(new Date(Date.now() - 1000).toISOString()), true)
  assert.equal(isExpired(new Date(Date.now() + 1000).toISOString()), false)
})
