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
  assert.equal(isOperationalConnection({ status: 'disconnected', provisioning_state: 'operational' }), false)
})

test('disconnect is manager-only, workspace-scoped, and keeps the row on retry', async t => {
  const db = require('../lib/supabase')
  const router = require('../routes/whatsappConnections')
  const route = router.stack.find(layer => layer.route?.path === '/:id/disconnect').route
  const id = '22222222-2222-4222-8222-222222222222'
  const number = { id, customer_id:'workspace', status:'connected', provisioning_state:'operational' }
  const original = db.from
  let writes = 0
  t.after(() => { db.from = original })
  db.from = table => {
    assert.equal(table, 'whatsapp_numbers')
    const filters = {}
    let patch
    const query = {
      select: () => query,
      eq(key, value) { filters[key] = value; return query },
      update(value) { patch = value; return query },
      async maybeSingle() {
        if (!Object.entries(filters).every(([key, value]) => number[key] === value)) return { data:null }
        if (patch) { writes++; Object.assign(number, patch) }
        return { data:number }
      }
    }
    return query
  }
  async function request(role, customerId = 'workspace') {
    const req = { params:{ id }, workspace:{ customerId, role } }
    const res = { statusCode:200, set() {}, status(code) { this.statusCode = code; return this }, json(body) { this.body = body; return this } }
    await route.stack[0].handle(req, res, () => route.stack[1].handle(req, res))
    return res
  }
  assert.equal((await request('member')).statusCode, 403)
  assert.equal((await request('owner', 'other-workspace')).statusCode, 404)
  assert.equal(writes, 0)
  assert.deepEqual((await request('admin')).body, { status:'disconnected' })
  assert.equal(number.provisioning_state, 'operational')
  assert.ok(Number.isFinite(Date.parse(number.disconnected_at)))
  assert.equal((await request('owner')).statusCode, 200)
  assert.equal(writes, 1)
})

test('only a signup started after disconnect can reactivate the verified connection', async () => {
  const source = require('node:fs').readFileSync(require.resolve('../routes/whatsappConnections'), 'utf8')
  const route = source.slice(source.indexOf("router.post('/embedded-signup/complete'"), source.indexOf('const reconciliationInFlight'))
  const number = { id:'number', customer_id:'workspace', status:'disconnected', disconnected_at:'2026-11-10T10:00:00Z' }
  const session = { id:'session', customer_id:'workspace', created_by:'admin', expires_at:new Date(Date.now() + 60_000).toISOString() }
  let handler, ownershipChecks = 0, readinessChecks = 0
  const vm = require('node:vm')
  vm.runInNewContext(route, {
    router:{ post(_path, _admin, callback) { handler = callback } }, requireAdmin() {},
    invalidCompletionBody: () => null, safeEqual: () => true, stateHash: () => '',
    signupAssetPatch: () => ({}), loadOrExchangeSignupToken: async () => ({ token:'temporary' }),
    createCredentialVault: () => ({ put:async () => {} }),
    createMetaEmbeddedSignupClient: () => ({
      validatePhoneOwnership:async () => { ownershipChecks++; return { phoneNumberId:'123456', wabaId:'654321' } },
      getRegistrationStatus:async () => { readinessChecks++; return { connected:true } }
    }),
    findConflict: async () => ({ kind:'same', record:number }),
    createGupshupConnectionStore: () => ({ load:async () => null }),
    markSessionCompleted: async () => {}, provisioningView: row => row,
    supabase:{ from(table) {
      const filters = {}
      let patch
      const query = { select:() => query, is:() => query, eq(key, value) { filters[key] = value; return query },
        update(value) { patch = value; return query },
        async maybeSingle() {
          if (table === 'whatsapp_connection_sessions') return { data:session }
          assert.equal(filters.customer_id, 'workspace')
          assert.equal(filters.status, 'disconnected')
          assert.equal(filters.disconnected_at, number.disconnected_at)
          Object.assign(number, patch)
          return { data:number }
        }
      }
      return query
    } }
  })
  async function complete(createdAt) {
    session.created_at = createdAt
    const req = { body:{}, workspace:{ customerId:'workspace', userId:'admin', emailVerified:true } }
    const res = { statusCode:200, status(code) { this.statusCode = code; return this }, json(body) { this.body = body; return this } }
    await handler(req, res)
    return res
  }
  assert.equal((await complete('2026-11-10T09:59:00Z')).statusCode, 409)
  assert.equal(number.status, 'disconnected')
  assert.equal(readinessChecks, 0)
  assert.equal((await complete('2026-11-10T10:01:00Z')).body.connection.status, 'connected')
  assert.equal(ownershipChecks, 2)
  assert.equal(readinessChecks, 1)
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

test('registration reconciliation requires the exact phone and explicit CONNECTED status',async()=>{
 let status='PENDING',returnedId='123456',gets=0;
 const meta=createMetaEmbeddedSignupClient({env:{META_GRAPH_API_VERSION:'v26.0'},http:{get:async(url,options)=>{gets++;assert.ok(url.endsWith('/123456'));assert.equal(options.params.fields,'id,status');assert.equal(options.timeout,10000);return {data:{id:returnedId,status}}}}});
 assert.equal((await meta.getRegistrationStatus('123456','vault-only')).connected,false);
 status='CONNECTED';assert.equal((await meta.getRegistrationStatus('123456','vault-only')).connected,true);
 returnedId='987654';assert.equal((await meta.getRegistrationStatus('123456','vault-only')).connected,false);
 await assert.rejects(meta.getRegistrationStatus('../other','token'),/Invalid phone/);assert.equal(gets,3);
})
