const express = require('express')
const crypto = require('crypto')
const router = express.Router()
const supabase = require('../lib/supabase')
const { requireAdmin } = require('../middleware/auth')
const { createMetaEmbeddedSignupClient, MetaSignupError } = require('../lib/metaEmbeddedSignup')

const SESSION_TTL_MINUTES = 15
const PHONE_NUMBER_ID_PATTERN = /^[0-9]{5,32}$/

function stateHash(state) {
  return crypto.createHash('sha256').update(state).digest('hex')
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function validId(value) {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)
}

function invalidCompletionBody(body) {
  if (!body || typeof body !== 'object') return 'Invalid Embedded Signup result'
  const keys = Object.keys(body)
  if (keys.some((key) => !['session_id', 'state', 'code', 'phone_number_id'].includes(key))) return 'Invalid Embedded Signup result'
  if (!validId(body.session_id) || typeof body.state !== 'string' || body.state.length < 32 || body.state.length > 200) return 'Invalid Embedded Signup result'
  if (typeof body.code !== 'string' || body.code.length < 5 || body.code.length > 4096) return 'Invalid Embedded Signup result'
  if (!PHONE_NUMBER_ID_PATTERN.test(String(body.phone_number_id || ''))) return 'Invalid Embedded Signup result'
  return null
}

async function loadCompletedConnection(session, customerId) {
  if (!session.whatsapp_number_id) return null
  const { data } = await supabase
    .from('whatsapp_numbers')
    .select('id, customer_id, phone_number, phone_number_id, whatsapp_business_account_id, display_name, status')
    .eq('id', session.whatsapp_number_id)
    .eq('customer_id', customerId)
    .maybeSingle()
  return data || null
}

async function findConflict(customerId, phoneNumberId, wabaId, phoneNumber) {
  const [{ data: byId }, { data: byWabaPhone }] = await Promise.all([
    supabase.from('whatsapp_numbers').select('id, customer_id, phone_number_id, whatsapp_business_account_id, phone_number, display_name, status').eq('phone_number_id', phoneNumberId).maybeSingle(),
    supabase.from('whatsapp_numbers').select('id, customer_id, phone_number_id, whatsapp_business_account_id, phone_number, display_name, status').eq('whatsapp_business_account_id', wabaId).eq('phone_number', phoneNumber).maybeSingle()
  ])
  const records = [byId, byWabaPhone].filter(Boolean)
  const foreign = records.find((record) => record.customer_id !== customerId)
  if (foreign) return { kind: 'foreign' }
  const existing = records[0]
  if (existing && (existing.phone_number_id !== phoneNumberId || existing.whatsapp_business_account_id !== wabaId || existing.phone_number !== phoneNumber)) {
    return { kind: 'mismatch' }
  }
  return { kind: 'same', record: existing || null }
}

router.post('/embedded-signup/prepare', requireAdmin, async (req, res) => {
  if (!req.workspace.emailVerified) return res.status(403).json({ error: 'Verify your email before connecting WhatsApp' })
  try {
    const state = crypto.randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60 * 1000).toISOString()
    const { data, error } = await supabase
      .from('whatsapp_connection_sessions')
      .insert({
        customer_id: req.workspace.customerId,
        created_by: req.workspace.userId,
        state_hash: stateHash(state),
        expires_at: expiresAt
      })
      .select('id, expires_at')
      .single()
    if (error) throw error
    return res.status(201).json({ session_id: data.id, state, expires_at: data.expires_at })
  } catch (_) {
    return res.status(500).json({ error: 'Unable to prepare WhatsApp connection' })
  }
})

router.post('/embedded-signup/complete', requireAdmin, async (req, res) => {
  const invalid = invalidCompletionBody(req.body)
  if (invalid) return res.status(400).json({ error: invalid })
  if (!req.workspace.emailVerified) return res.status(403).json({ error: 'Verify your email before connecting WhatsApp' })

  try {
    const { session_id: sessionId, state, code, phone_number_id: phoneNumberId } = req.body
    const { data: session } = await supabase
      .from('whatsapp_connection_sessions')
      .select('id, customer_id, created_by, state_hash, expires_at, completed_at, whatsapp_number_id')
      .eq('id', sessionId)
      .maybeSingle()

    if (!session || session.customer_id !== req.workspace.customerId || session.created_by !== req.workspace.userId || !safeEqual(session.state_hash, stateHash(state))) {
      return res.status(403).json({ error: 'This connection session is not authorized' })
    }
    if (session.completed_at) {
      const connection = await loadCompletedConnection(session, req.workspace.customerId)
      if (!connection) return res.status(409).json({ error: 'This connection session is no longer valid' })
      return res.json({ connection, idempotent: true })
    }
    if (new Date(session.expires_at).getTime() <= Date.now()) return res.status(410).json({ error: 'This connection session has expired. Start again.' })

    const meta = createMetaEmbeddedSignupClient()
    const temporaryToken = await meta.exchangeCode(code)
    const validated = await meta.validatePhoneOwnership({ accessToken: temporaryToken, phoneNumberId })
    const conflict = await findConflict(req.workspace.customerId, validated.phoneNumberId, validated.wabaId, validated.displayPhoneNumber)
    if (conflict.kind === 'foreign') return res.status(409).json({ error: 'This WhatsApp number is already connected to another workspace' })
    if (conflict.kind === 'mismatch') return res.status(409).json({ error: 'This WhatsApp number has conflicting existing connection data' })

    // The platform token stays server-side; the temporary Embedded Signup token is never stored or returned.
    await meta.subscribeApp(validated.wabaId)

    let connection = conflict.record
    if (!connection) {
      const { data, error } = await supabase
        .from('whatsapp_numbers')
        .insert({
          customer_id: req.workspace.customerId,
          phone_number: validated.displayPhoneNumber,
          phone_number_id: validated.phoneNumberId,
          whatsapp_business_account_id: validated.wabaId,
          display_name: validated.displayName,
          status: 'connected'
        })
        .select('id, customer_id, phone_number, phone_number_id, whatsapp_business_account_id, display_name, status')
        .single()
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'This WhatsApp number is already connected to another workspace' })
        throw error
      }
      connection = data
    }

    const { error: sessionError } = await supabase
      .from('whatsapp_connection_sessions')
      .update({ completed_at: new Date().toISOString(), whatsapp_number_id: connection.id })
      .eq('id', session.id)
      .eq('customer_id', req.workspace.customerId)
      .eq('created_by', req.workspace.userId)
      .is('completed_at', null)
    if (sessionError) throw sessionError

    return res.status(201).json({ connection, idempotent: Boolean(conflict.record) })
  } catch (error) {
    if (error instanceof MetaSignupError) return res.status(422).json({ error: 'Meta could not validate this WhatsApp connection' })
    return res.status(500).json({ error: 'Unable to complete WhatsApp connection' })
  }
})

module.exports = router
