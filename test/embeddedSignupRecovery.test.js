const test = require('node:test')
const assert = require('node:assert/strict')
const { createMetaEmbeddedSignupClient, MetaSignupError } = require('../lib/metaEmbeddedSignup')

process.env.SUPABASE_URL ||= 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key'

const { signupAssetPatch, isOperationalConnection, signupSessionTokenCredentialKey, loadOrExchangeSignupToken, recoveryAction, runProvisioningClaim, failedProvisioningState } = require('../routes/whatsappConnections')

test('retains the same verified Embedded Signup assets for a retry but rejects substitution', () => {
  const session = { signup_phone_number_id: null, signup_waba_id: null }
  const first = signupAssetPatch(session, { phoneNumberId: '555500001111', finishWabaId: '993311773355' })
  const retry = signupAssetPatch(first, { phoneNumberId: '555500001111', finishWabaId: '993311773355', validatedWabaId: '993311773355' })
  assert.deepEqual(retry, first)
  assert.throws(() => signupAssetPatch(first, { phoneNumberId: '555500001112', finishWabaId: '993311773355' }))
  assert.throws(() => signupAssetPatch(first, { phoneNumberId: '555500001111', finishWabaId: '993311773356' }))
})

test('existing operational connections are recognized as idempotent and are never candidates for registration', () => {
  assert.equal(isOperationalConnection({ status: 'connected', provisioning_state: null }), true)
  assert.equal(isOperationalConnection({ status: 'provisioning', provisioning_state: 'operational' }), true)
  assert.equal(isOperationalConnection({ status: 'provisioning', provisioning_state: 'failed' }), false)
})

test('retains an exchanged signup token in the vault so later ownership recovery does not reuse an authorization code', async () => {
  const stored = new Map()
  const vault = {
    async get({ credentialKey }) { return stored.get(credentialKey) || null },
    async put({ credentialKey, plaintext }) { stored.set(credentialKey, plaintext) }
  }
  let exchanges = 0
  const first = await loadOrExchangeSignupToken({
    vault,
    customerId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    code: 'one-time-code',
    exchangeCode: async () => { exchanges += 1; return 'vault-only-token' }
  })
  const resumed = await loadOrExchangeSignupToken({
    vault,
    customerId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    exchangeCode: async () => { exchanges += 1; return 'should-not-be-used' }
  })
  assert.equal(first.resumed, false)
  assert.equal(resumed.resumed, true)
  assert.equal(resumed.token, 'vault-only-token')
  assert.equal(exchanges, 1)
  assert.match(signupSessionTokenCredentialKey('22222222-2222-4222-8222-222222222222'), /^signup_session_[a-f0-9]{32}$/)
})

test('an empty ownership result can later recover from the retained token without a new authorization code', async () => {
  const stored = new Map()
  const vault = {
    async get({ credentialKey }) { return stored.get(credentialKey) || null },
    async put({ credentialKey, plaintext }) { stored.set(credentialKey, plaintext) }
  }
  const tokenArgs = { vault, customerId: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222' }
  let exchanges = 0
  const first = await loadOrExchangeSignupToken({ ...tokenArgs, code: 'one-time-code', exchangeCode: async () => { exchanges += 1; return 'vault-only-token' } })
  let available = false
  const client = createMetaEmbeddedSignupClient({
    env: { META_APP_ID: '123456', META_APP_SECRET: 'app-secret', META_GRAPH_API_VERSION: 'v18.0' },
    delay: async () => {},
    diagnostic: () => {},
    http: {
      async get(url) {
        if (url.includes('debug_token')) return { data: { data: { is_valid: true, granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['100'] }] } } }
        return { data: { data: available ? [{ id: '200', display_phone_number: '+260 700 000 200' }] : [] } }
      }
    }
  })
  await assert.rejects(() => client.validatePhoneOwnership({ accessToken: first.token, phoneNumberId: '200' }), MetaSignupError)
  available = true
  const resumed = await loadOrExchangeSignupToken({ ...tokenArgs, exchangeCode: async () => { exchanges += 1; return 'must-not-exchange' } })
  const ownership = await client.validatePhoneOwnership({ accessToken: resumed.token, phoneNumberId: '200' })
  assert.equal(ownership.phoneNumberId, '200')
  assert.equal(exchanges, 1)
})

test('concurrent completion or retry claim attempts permit exactly one Meta-registration path', async () => {
  let claimed = false
  let registrationCalls = 0
  const claim = async () => {
    if (claimed) return null
    claimed = true
    return { id: 'connection-1', status: 'provisioning' }
  }
  const results = await Promise.all([
    runProvisioningClaim({ claim, loadCurrent: async () => ({ status: 'provisioning' }), onClaimed: async connection => { registrationCalls += 1; return connection }, onOperational: async connection => connection }),
    runProvisioningClaim({ claim, loadCurrent: async () => ({ status: 'provisioning' }), onClaimed: async connection => { registrationCalls += 1; return connection }, onOperational: async connection => connection })
  ])
  assert.deepEqual(results.map(result => result.kind).sort(), ['claimed', 'in_progress'])
  assert.equal(registrationCalls, 1)
})

test('interrupted claims recover only before registration submission and never blindly repeat an uncertain registration', () => {
  const now = Date.now()
  assert.equal(recoveryAction({ status: 'provisioning', provisioning_state: 'registering', provisioning_claimed_at: new Date(now - 6 * 60 * 1000).toISOString(), provisioning_registration_attempted_at: null }, now), 'recover_interrupted_claim')
  assert.equal(recoveryAction({ status: 'provisioning', provisioning_state: 'registering', provisioning_claimed_at: new Date(now - 6 * 60 * 1000).toISOString(), provisioning_registration_attempted_at: new Date(now - 5 * 60 * 1000).toISOString() }, now), 'confirmation_required')
  assert.equal(recoveryAction({ status: 'connected', provisioning_state: 'operational' }, now), 'operational')
})

test('a post-registration database interruption enters confirmation-required instead of retrying Meta registration', () => {
  assert.deepEqual(failedProvisioningState({ registrationSubmitted: false, registrationConfirmed: false, error: new Error('vault failure') }), { state: 'failed', error: 'registration_failed' })
  assert.deepEqual(failedProvisioningState({ registrationSubmitted: true, registrationConfirmed: true, error: new Error('database finalization failure') }), { state: 'registration_confirmation_required', error: 'registration_outcome_unknown' })
  const knownMetaRejection = new Error('Meta rejected registration')
  knownMetaRejection.response = { status: 400 }
  assert.deepEqual(failedProvisioningState({ registrationSubmitted: true, registrationConfirmed: false, error: knownMetaRejection }), { state: 'failed', error: 'registration_failed' })
})
