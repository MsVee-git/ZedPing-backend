const test = require('node:test')
const assert = require('node:assert/strict')
const { validateDiscovery } = require('../lib/onboardingDiscovery')
const { recommendationsFor } = require('../lib/onboardingRecommendations')

test('validates discovery selections and removes duplicates', () => {
  assert.deepEqual(validateDiscovery({
    goals: ['customer_support', 'customer_support', 'payments_collections'],
    team_size: '2-5',
    contact_sources: ['excel', 'crm', 'excel']
  }), {
    goals: ['customer_support', 'payments_collections'],
    team_size: '2-5',
    contact_sources: ['excel', 'crm']
  })
})

test('rejects browser fields and invalid choices', () => {
  assert.throws(() => validateDiscovery({ goals: ['customer_support'], team_size: 'big', contact_sources: [] }), /team size/)
  assert.throws(() => validateDiscovery({ goals: ['unknown'], team_size: '1', contact_sources: [] }), /goals/)
  assert.throws(() => validateDiscovery({ goals: ['customer_support'], team_size: '1', contact_sources: [], customer_id: 'forged' }), /Only discovery fields/)
})

test('returns education recommendations for relevant discovery data', () => {
  const result = recommendationsFor({ industry: 'Education', goals: ['customer_updates', 'payments_collections'] })
  assert.equal(result.packs[0].id, 'school-starter-pack')
  assert.ok(result.automations.some((item) => item.id === 'human-handoff'))
})

test('does not show every industry pack when no industry or goal was chosen', () => {
  const result = recommendationsFor({ industry: '', goals: [] })
  assert.deepEqual(result.packs, [])
  assert.deepEqual(result.automations, [])
})
