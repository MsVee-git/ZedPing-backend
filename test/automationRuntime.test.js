const test = require('node:test')
const assert = require('node:assert/strict')
const { selectAutomation, selectExplicitAutomation, selectAwayAutomation, selectWelcomeAutomation, selectDefaultAutomation, isOutsideBusinessHours } = require('../lib/automationRuntime')

const base = { is_active: true, priority: 100, created_at: '2026-01-01T00:00:00Z' }

test('legacy keyword remains executable and DEFAULT remains fallback', () => {
  const rules = [{ ...base, id: 'default', trigger_value: 'DEFAULT' }, { ...base, id: 'help', trigger_value: 'HELP' }]
  assert.equal(selectAutomation(rules, 'help').automation.id, 'help')
  assert.equal(selectAutomation(rules, 'unknown').automation.id, 'default')
})

test('FAQ aliases use the explicit-rule runtime', () => {
  const rule = { ...base, id: 'faq', automation_type: 'faq', trigger_config: { phrases: ['fees', 'price list'] } }
  assert.equal(selectExplicitAutomation([rule], 'PRICE LIST').id, 'faq')
})

test('explicit, away, welcome and DEFAULT can be selected separately for deterministic precedence', () => {
  const rules = [
    { ...base, id: 'default', trigger_value: 'DEFAULT' },
    { ...base, id: 'welcome', automation_type: 'welcome' },
    { ...base, id: 'away', automation_type: 'away' },
    { ...base, id: 'keyword', automation_type: 'keyword', trigger_config: { phrases: ['hello'] } }
  ]
  assert.equal(selectExplicitAutomation(rules, 'hello').id, 'keyword')
  assert.equal(selectAwayAutomation(rules).id, 'away')
  assert.equal(selectWelcomeAutomation(rules).id, 'welcome')
  assert.equal(selectDefaultAutomation(rules).id, 'default')
})

test('business hours respect timezone, overnight intervals, and disabled weekends', () => {
  const settings = { timezone: 'Africa/Lusaka', business_hours: { mon: [{ start: '09:00', end: '17:00' }], tue: [{ start: '18:00', end: '08:00' }], wed: [], thu: [], fri: [], sat: [], sun: [] } }
  assert.equal(isOutsideBusinessHours(settings, new Date('2026-09-21T08:00:00Z')), false)
  assert.equal(isOutsideBusinessHours(settings, new Date('2026-09-21T16:00:00Z')), true)
  assert.equal(isOutsideBusinessHours(settings, new Date('2026-09-22T20:00:00Z')), false)
  assert.equal(isOutsideBusinessHours(settings, new Date('2026-09-23T04:00:00Z')), false)
  assert.equal(isOutsideBusinessHours(settings, new Date('2026-09-26T10:00:00Z')), true)
})

