const express = require('express')
const crypto = require('crypto')
const router = express.Router()
const supabase = require('../lib/supabase')
const { requireAdmin } = require('../middleware/auth')
const { createMetaEmbeddedSignupClient, MetaSignupError, emitEmbeddedSignupDiagnostic, completionFailureDiagnostic } = require('../lib/metaEmbeddedSignup')
const { createCredentialVault, CredentialVaultError } = require('../lib/credentialVault')

const SESSION_TTL_MINUTES = 15
const PHONE_NUMBER_ID_PATTERN = /^[0-9]{5,32}$/
const PROVISIONING_CLAIM_RECOVERY_MS = 5 * 60 * 1000

function stateHash(state) {
  return crypto.createHash('sha256').update(state).digest('hex')
}

function signupSessionTokenCredentialKey(sessionId) {
  return `signup_session_${crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 32)}`
}

async function loadOrExchangeSignupToken({ vault, customerId, sessionId, code, exchangeCode, onStage = () => {} }) {
  const credentialKey = signupSessionTokenCredentialKey(sessionId)
  const existing = await vault.get({ customerId, integration: 'meta_whatsapp', credentialKey })
  if (existing) return { token: existing, resumed: true }
  if (typeof code !== 'string' || code.length < 5) throw new MetaSignupError('The Embedded Signup authorization code is unavailable')
  onStage('oauth_code_exchange')
  const token = await exchangeCode(code)
  onStage('credential_storage')
  await vault.put({ customerId, integration: 'meta_whatsapp', credentialKey, plaintext: token })
  return { token, resumed: false }
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
  if (keys.some((key) => !['session_id', 'state', 'code', 'phone_number_id', 'finish_waba_id'].includes(key))) return 'Invalid Embedded Signup result'
  if (!validId(body.session_id) || typeof body.state !== 'string' || body.state.length < 32 || body.state.length > 200) return 'Invalid Embedded Signup result'
  if (body.code != null && (typeof body.code !== 'string' || body.code.length < 5 || body.code.length > 4096)) return 'Invalid Embedded Signup result'
  if (!PHONE_NUMBER_ID_PATTERN.test(String(body.phone_number_id || ''))) return 'Invalid Embedded Signup result'
  if (body.finish_waba_id != null && !PHONE_NUMBER_ID_PATTERN.test(String(body.finish_waba_id))) return 'Invalid Embedded Signup result'
  return null
}

function emitPersistenceReady(success, error) {
  emitEmbeddedSignupDiagnostic(
    { stage: 'persistence_ready', success, ...(error ? { error } : {}) },
    (record) => console.info(JSON.stringify(record))
  )
}

function emitCompletionFailure({ stage, sessionId, customerId, error }) {
  console.info(JSON.stringify(completionFailureDiagnostic({ stage, sessionId, workspaceId: customerId, error })))
}

function provisioningView(connection) {
  return { id: connection.id, customer_id: connection.customer_id, phone_number: connection.phone_number, phone_number_id: connection.phone_number_id, whatsapp_business_account_id: connection.whatsapp_business_account_id, display_name: connection.display_name, status: connection.status, provisioning_state: connection.provisioning_state, provisioning_error: connection.provisioning_error, provisioned_at: connection.provisioned_at }
}

function pin() { return crypto.randomInt(0, 1000000).toString().padStart(6, '0') }

function signupAssetPatch(session, { phoneNumberId, finishWabaId, validatedWabaId = null }) {
  const incomingWabaId = validatedWabaId || finishWabaId || null
  if (session.signup_phone_number_id && session.signup_phone_number_id !== phoneNumberId) {
    throw new MetaSignupError('This connection session already belongs to a different WhatsApp number')
  }
  if (session.signup_waba_id && incomingWabaId && session.signup_waba_id !== incomingWabaId) {
    throw new MetaSignupError('This connection session already belongs to a different WhatsApp Business Account')
  }
  return {
    signup_phone_number_id: phoneNumberId,
    signup_waba_id: incomingWabaId || session.signup_waba_id || null
  }
}

function isOperationalConnection(connection) {
  return connection?.status === 'connected' || connection?.provisioning_state === 'operational'
}

function recoveryAction(connection, now = Date.now()) {
  if (isOperationalConnection(connection)) return 'operational'
  if (connection?.provisioning_state === 'registration_confirmation_required') return 'confirmation_required'
  if (connection?.provisioning_state !== 'registering') return 'normal'
  if (connection.provisioning_registration_attempted_at) return 'confirmation_required'
  const claimedAt = Date.parse(connection.provisioning_claimed_at || '')
  return Number.isFinite(claimedAt) && now - claimedAt >= PROVISIONING_CLAIM_RECOVERY_MS ? 'recover_interrupted_claim' : 'in_progress'
}

async function runProvisioningClaim({ claim, loadCurrent, onClaimed, onOperational }) {
  const claimed = await claim()
  if (claimed) return { kind: 'claimed', connection: await onClaimed(claimed) }
  const current = await loadCurrent()
  if (isOperationalConnection(current)) return { kind: 'operational', connection: await onOperational(current) }
  return { kind: 'in_progress', connection: null }
}

function failedProvisioningState({ registrationSubmitted, registrationConfirmed, error }) {
  const outcomeUnknown = registrationSubmitted && (registrationConfirmed || !error?.response)
  return outcomeUnknown
    ? { state: 'registration_confirmation_required', error: 'registration_outcome_unknown' }
    : { state: 'failed', error: 'registration_failed' }
}

async function loadCompletedConnection(session, customerId) {
  if (!session.whatsapp_number_id) return null
  return loadConnection(session.whatsapp_number_id, customerId)
}

async function loadConnection(connectionId, customerId) {
  const { data } = await supabase
    .from('whatsapp_numbers')
    .select('id, customer_id, phone_number, phone_number_id, whatsapp_business_account_id, display_name, status, provisioning_state, provisioning_error, provisioned_at, provisioning_claimed_at, provisioning_registration_attempted_at')
    .eq('id', connectionId)
    .eq('customer_id', customerId)
    .maybeSingle()
  return data || null
}

async function markSessionCompleted(session, customerId, connectionId) {
  const { error } = await supabase
    .from('whatsapp_connection_sessions')
    .update({ completed_at: new Date().toISOString(), whatsapp_number_id: connectionId })
    .eq('id', session.id)
    .eq('customer_id', customerId)
    .eq('created_by', session.created_by)
    .is('completed_at', null)
  if (error) throw error
}

async function findConflict(customerId, phoneNumberId, wabaId, phoneNumber) {
  const [{ data: byId }, { data: byWabaPhone }] = await Promise.all([
    supabase.from('whatsapp_numbers').select('id, customer_id, phone_number_id, whatsapp_business_account_id, phone_number, display_name, status, provisioning_state, provisioning_error, provisioned_at, provisioning_attempts, provisioning_started_at, provisioning_claimed_at, provisioning_registration_attempted_at').eq('phone_number_id', phoneNumberId).maybeSingle(),
    supabase.from('whatsapp_numbers').select('id, customer_id, phone_number_id, whatsapp_business_account_id, phone_number, display_name, status, provisioning_state, provisioning_error, provisioned_at, provisioning_attempts, provisioning_started_at, provisioning_claimed_at, provisioning_registration_attempted_at').eq('whatsapp_business_account_id', wabaId).eq('phone_number', phoneNumber).maybeSingle()
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

  let completionStage = 'oauth_code_exchange'
  let completionSessionId = req.body?.session_id || null
  try {
    const { session_id: sessionId, state, code, phone_number_id: phoneNumberId, finish_waba_id: finishWabaId } = req.body
    const { data: session } = await supabase
      .from('whatsapp_connection_sessions')
      .select('id, customer_id, created_by, state_hash, expires_at, completed_at, whatsapp_number_id, signup_phone_number_id, signup_waba_id')
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
    if (new Date(session.expires_at).getTime() <= Date.now() && !(session.signup_phone_number_id && session.signup_waba_id)) {
      return res.status(410).json({ error: 'This connection session has expired. Start again.' })
    }

    // Persist the event's identifiers only after its signed, workspace-scoped
    // session has been verified. Meta ownership validation below replaces the
    // claimed WABA with the WABA Meta proves for this phone number.
    completionStage = 'signup_asset_capture'
    const { error: capturedAssetsError } = await supabase
      .from('whatsapp_connection_sessions')
      .update(signupAssetPatch(session, { phoneNumberId, finishWabaId }))
      .eq('id', session.id)
      .eq('customer_id', req.workspace.customerId)
      .eq('created_by', req.workspace.userId)
      .is('completed_at', null)
    if (capturedAssetsError) throw capturedAssetsError

    const meta = createMetaEmbeddedSignupClient()
    const vault = createCredentialVault()
    completionStage = 'credential_storage'
    const { token: temporaryToken } = await loadOrExchangeSignupToken({
      vault,
      customerId: req.workspace.customerId,
      sessionId: session.id,
      code,
      exchangeCode: meta.exchangeCode,
      onStage: stage => { completionStage = stage }
    })
    completionStage = 'ownership_validation'
    const validated = await meta.validatePhoneOwnership({ accessToken: temporaryToken, phoneNumberId, finishWabaId: finishWabaId || null })
    completionStage = 'signup_asset_capture'
    const { error: validatedAssetsError } = await supabase
      .from('whatsapp_connection_sessions')
      .update(signupAssetPatch(session, { phoneNumberId: validated.phoneNumberId, finishWabaId, validatedWabaId: validated.wabaId }))
      .eq('id', session.id)
      .eq('customer_id', req.workspace.customerId)
      .eq('created_by', req.workspace.userId)
      .is('completed_at', null)
    if (validatedAssetsError) throw validatedAssetsError
    completionStage = 'whatsapp_number_persistence'
    const conflict = await findConflict(req.workspace.customerId, validated.phoneNumberId, validated.wabaId, validated.displayPhoneNumber)
    if (conflict.kind === 'foreign') {
      emitPersistenceReady(false, new MetaSignupError('This WhatsApp number is already connected to another workspace'))
      return res.status(409).json({ error: 'This WhatsApp number is already connected to another workspace' })
    }
    if (conflict.kind === 'mismatch') {
      emitPersistenceReady(false, new MetaSignupError('This WhatsApp number has conflicting existing connection data'))
      return res.status(409).json({ error: 'This WhatsApp number has conflicting existing connection data' })
    }

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
          status: 'provisioning', provisioning_state: 'embedded_signup_completed', provisioning_attempts: 0, provisioning_started_at: new Date().toISOString()
        })
        .select('id, customer_id, phone_number, phone_number_id, whatsapp_business_account_id, display_name, status, provisioning_state, provisioning_error, provisioned_at, provisioning_attempts, provisioning_started_at, provisioning_claimed_at, provisioning_registration_attempted_at')
        .single()
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'This WhatsApp number is already connected to another workspace' })
        throw error
      }
      connection = data
    }

    // Legacy and already-operational connections are never reprovisioned by a
    // duplicate Embedded Signup completion.
    if (isOperationalConnection(connection)) {
      await markSessionCompleted(session, req.workspace.customerId, connection.id)
      return res.json({ connection: provisioningView(connection), idempotent: true })
    }

    // Claim a pending/failed connection before any Meta mutation. Concurrent
    // duplicate completion requests can observe the claim, but cannot register
    // the same number twice.
    const claimResult = await runProvisioningClaim({
      claim: async () => {
        const { data: claimed, error: claimError } = await supabase
          .from('whatsapp_numbers')
          .update({
            status: 'provisioning',
            provisioning_state: 'registering',
            provisioning_error: null,
            provisioning_attempts: Number(connection.provisioning_attempts || 0) + 1,
            provisioning_started_at: connection.provisioning_started_at || new Date().toISOString(),
            provisioning_claimed_at: new Date().toISOString(),
            provisioning_registration_attempted_at: null
          })
          .eq('id', connection.id)
          .eq('customer_id', req.workspace.customerId)
          .eq('status', 'provisioning')
          .in('provisioning_state', ['embedded_signup_completed', 'failed'])
          .select('id, customer_id, phone_number, phone_number_id, whatsapp_business_account_id, display_name, status, provisioning_state, provisioning_error, provisioned_at, provisioning_attempts, provisioning_started_at, provisioning_claimed_at, provisioning_registration_attempted_at')
          .maybeSingle()
        if (claimError) throw claimError
        return claimed
      },
      loadCurrent: () => loadConnection(connection.id, req.workspace.customerId),
      onClaimed: async claimed => claimed,
      onOperational: async current => {
        await markSessionCompleted(session, req.workspace.customerId, current.id)
        return current
      }
    })
    if (claimResult.kind === 'operational') return res.json({ connection: provisioningView(claimResult.connection), idempotent: true })
    if (claimResult.kind === 'in_progress') return res.status(409).json({ error: 'WhatsApp provisioning is already in progress' })
    connection = claimResult.connection

    // The exchanged Business Integration System User token is only retained in
    // the server-side vault. It is never returned, logged, or copied to the
    // legacy plaintext access_token field.
    let registrationSubmitted = false
    let registrationConfirmed = false
    try {
      const registrationPin = pin()
      completionStage = 'credential_storage'
      await vault.put({ customerId: req.workspace.customerId, integration: 'meta_whatsapp', credentialKey: `phone_${validated.phoneNumberId}`, plaintext: temporaryToken })
      await vault.put({ customerId: req.workspace.customerId, integration: 'meta_whatsapp', credentialKey: `phone_${validated.phoneNumberId}_registration_pin`, plaintext: registrationPin })
      completionStage = 'waba_subscription'
      await meta.subscribeApp(validated.wabaId, temporaryToken)
      completionStage = 'phone_registration'
      const { error: registrationAttemptError } = await supabase
        .from('whatsapp_numbers')
        .update({ provisioning_registration_attempted_at: new Date().toISOString() })
        .eq('id', connection.id)
        .eq('customer_id', req.workspace.customerId)
        .eq('status', 'provisioning')
        .eq('provisioning_state', 'registering')
      if (registrationAttemptError) throw registrationAttemptError
      registrationSubmitted = true
      await meta.registerPhone(validated.phoneNumberId, temporaryToken, registrationPin)
      registrationConfirmed = true
      const { data: operational, error: operationalError } = await supabase.from('whatsapp_numbers').update({ status: 'connected', provisioning_state: 'operational', provisioning_error: null, provisioned_at: new Date().toISOString() }).eq('id', connection.id).eq('customer_id', req.workspace.customerId).select('id, customer_id, phone_number, phone_number_id, whatsapp_business_account_id, display_name, status, provisioning_state, provisioning_error, provisioned_at').single()
      if (operationalError) throw operationalError
      connection = operational
      await supabase.from('customers').update({ whatsapp_connected_at: new Date().toISOString() }).eq('id', req.workspace.customerId).is('whatsapp_connected_at', null)
      emitPersistenceReady(true)
    } catch (error) {
      emitCompletionFailure({ stage: completionStage, sessionId: completionSessionId, customerId: req.workspace.customerId, error })
      const failure = failedProvisioningState({ registrationSubmitted, registrationConfirmed, error })
      await supabase.from('whatsapp_numbers').update({
        status: 'provisioning',
        provisioning_state: failure.state,
        provisioning_error: failure.error
      }).eq('id', connection.id).eq('customer_id', req.workspace.customerId)
      emitPersistenceReady(false, error)
      return res.status(422).json({ error: failure.state === 'registration_confirmation_required' ? 'WhatsApp registration needs confirmation before another attempt.' : 'WhatsApp provisioning needs attention. You can retry safely.', connection: { ...provisioningView(connection), status: 'provisioning', provisioning_state: failure.state, provisioning_error: failure.error } })
    }

    await markSessionCompleted(session, req.workspace.customerId, connection.id)

    return res.status(201).json({ connection: provisioningView(connection), idempotent: Boolean(conflict.record) })
  } catch (error) {
    emitCompletionFailure({ stage: completionStage, sessionId: completionSessionId, customerId: req.workspace.customerId, error })
    if (error instanceof MetaSignupError || error instanceof CredentialVaultError) return res.status(422).json({ error: 'Meta could not complete secure WhatsApp provisioning' })
    return res.status(500).json({ error: 'Unable to complete WhatsApp connection' })
  }
})

router.post('/:id/provision/retry', requireAdmin, async (req, res) => {
  try {
    let { data: connection, error } = await supabase.from('whatsapp_numbers')
      .select('id, customer_id, phone_number_id, whatsapp_business_account_id, phone_number, display_name, status, provisioning_state, provisioning_error, provisioned_at, provisioning_attempts, provisioning_started_at, provisioning_claimed_at, provisioning_registration_attempted_at')
      .eq('id', req.params.id).eq('customer_id', req.workspace.customerId).maybeSingle()
    if (error) throw error
    if (!connection) return res.status(404).json({ error: 'WhatsApp connection not found' })
    const action = recoveryAction(connection)
    if (action === 'operational') return res.json({ connection: provisioningView(connection), idempotent: true })
    if (action === 'confirmation_required') {
      await supabase.from('whatsapp_numbers').update({ provisioning_state: 'registration_confirmation_required', provisioning_error: 'registration_outcome_unknown' }).eq('id', connection.id).eq('customer_id', req.workspace.customerId).eq('status', 'provisioning')
      return res.status(409).json({ error: 'WhatsApp registration needs confirmation before another attempt' })
    }
    if (action === 'recover_interrupted_claim') {
      const { data: recovered, error: recoveryError } = await supabase.from('whatsapp_numbers')
        .update({ provisioning_state: 'failed', provisioning_error: 'interrupted_before_registration' })
        .eq('id', connection.id)
        .eq('customer_id', req.workspace.customerId)
        .eq('status', 'provisioning')
        .eq('provisioning_state', 'registering')
        .is('provisioning_registration_attempted_at', null)
        .select('id, customer_id, phone_number_id, whatsapp_business_account_id, phone_number, display_name, status, provisioning_state, provisioning_error, provisioned_at, provisioning_attempts, provisioning_started_at, provisioning_claimed_at, provisioning_registration_attempted_at')
        .maybeSingle()
      if (recoveryError) throw recoveryError
      if (!recovered) return res.status(409).json({ error: 'Provisioning is already in progress' })
      connection = recovered
    }
    if (action === 'in_progress') return res.status(409).json({ error: 'Provisioning is already in progress' })
    if (connection.status !== 'provisioning' || connection.provisioning_state !== 'failed') return res.status(409).json({ error: 'This WhatsApp connection cannot be retried yet' })
    const { data: claimed } = await supabase.from('whatsapp_numbers').update({ provisioning_state: 'registering', provisioning_error: null, provisioning_attempts: Number(connection.provisioning_attempts || 0) + 1, provisioning_claimed_at: new Date().toISOString(), provisioning_registration_attempted_at: null }).eq('id', connection.id).eq('customer_id', req.workspace.customerId).eq('status', 'provisioning').eq('provisioning_state', 'failed').select('id').maybeSingle()
    if (!claimed) return res.status(409).json({ error: 'Provisioning is already in progress' })
    const vault = createCredentialVault()
    const token = await vault.get({ customerId: req.workspace.customerId, integration: 'meta_whatsapp', credentialKey: `phone_${connection.phone_number_id}` })
    const registrationPin = await vault.get({ customerId: req.workspace.customerId, integration: 'meta_whatsapp', credentialKey: `phone_${connection.phone_number_id}_registration_pin` })
    if (!token || !registrationPin) throw new CredentialVaultError('Provisioning credentials are unavailable')
    const meta = createMetaEmbeddedSignupClient()
    let registrationSubmitted = false
    let registrationConfirmed = false
    try {
      await meta.subscribeApp(connection.whatsapp_business_account_id, token)
      const { error: registrationAttemptError } = await supabase.from('whatsapp_numbers')
        .update({ provisioning_registration_attempted_at: new Date().toISOString() })
        .eq('id', connection.id)
        .eq('customer_id', req.workspace.customerId)
        .eq('status', 'provisioning')
        .eq('provisioning_state', 'registering')
      if (registrationAttemptError) throw registrationAttemptError
      registrationSubmitted = true
      await meta.registerPhone(connection.phone_number_id, token, registrationPin)
      registrationConfirmed = true
      const { data: operational, error: operationalError } = await supabase.from('whatsapp_numbers').update({ status: 'connected', provisioning_state: 'operational', provisioning_error: null, provisioned_at: new Date().toISOString() }).eq('id', connection.id).eq('customer_id', req.workspace.customerId).select('id, customer_id, phone_number, phone_number_id, whatsapp_business_account_id, display_name, status, provisioning_state, provisioning_error, provisioned_at').single()
      if (operationalError) throw operationalError
      await supabase.from('customers').update({ whatsapp_connected_at: new Date().toISOString() }).eq('id', req.workspace.customerId).is('whatsapp_connected_at', null)
      return res.json({ connection: provisioningView(operational) })
    } catch (retryError) {
      const failure = failedProvisioningState({ registrationSubmitted, registrationConfirmed, error: retryError })
      await supabase.from('whatsapp_numbers').update({ status: 'provisioning', provisioning_state: failure.state, provisioning_error: failure.error }).eq('id', connection.id).eq('customer_id', req.workspace.customerId)
      return res.status(422).json({ error: failure.state === 'registration_confirmation_required' ? 'WhatsApp registration needs confirmation before another attempt.' : 'WhatsApp provisioning needs attention. You can retry safely.' })
    }
  } catch (error) {
    if (error instanceof CredentialVaultError || error instanceof MetaSignupError) return res.status(422).json({ error: 'WhatsApp provisioning credentials need attention' })
    return res.status(500).json({ error: 'Unable to retry WhatsApp provisioning' })
  }
})

module.exports = router
module.exports.signupAssetPatch = signupAssetPatch
module.exports.isOperationalConnection = isOperationalConnection
module.exports.signupSessionTokenCredentialKey = signupSessionTokenCredentialKey
module.exports.loadOrExchangeSignupToken = loadOrExchangeSignupToken
module.exports.recoveryAction = recoveryAction
module.exports.runProvisioningClaim = runProvisioningClaim
module.exports.failedProvisioningState = failedProvisioningState
