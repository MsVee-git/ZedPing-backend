const test = require('node:test')
const assert = require('node:assert/strict')

process.env.SUPABASE_URL ||= 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key'

const { signupAssetPatch, isOperationalConnection } = require('../routes/whatsappConnections')

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
