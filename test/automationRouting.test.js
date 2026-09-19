const test = require('node:test')
const assert = require('node:assert/strict')
const { selectAutomation } = require('../lib/automationRouting')

test('explicit keyword wins over DEFAULT regardless of priority', () => {
  const result = selectAutomation([
    { id: 'default', is_active: true, trigger_value: 'DEFAULT', priority: 1 },
    { id: 'pricing', is_active: true, trigger_value: 'PRICING', priority: 999 }
  ], 'pricing')
  assert.equal(result.kind, 'keyword')
  assert.equal(result.automation.id, 'pricing')
})

test('competing keyword rules use priority then created time then id', () => {
  const result = selectAutomation([
    { id: 'later', is_active: true, trigger_value: 'HELP', priority: 10, created_at: '2026-01-02T00:00:00Z' },
    { id: 'first', is_active: true, trigger_value: 'HELP', priority: 10, created_at: '2026-01-01T00:00:00Z' },
    { id: 'priority', is_active: true, trigger_value: 'HELP', priority: 5, created_at: '2026-01-03T00:00:00Z' }
  ], 'help')
  assert.equal(result.automation.id, 'priority')
})

test('DEFAULT is fallback only and inactive rules never run', () => {
  const fallback = selectAutomation([{ id: 'default', is_active: true, trigger_value: 'DEFAULT', priority: 100 }], 'unknown')
  assert.equal(fallback.kind, 'default')
  const none = selectAutomation([{ id: 'disabled', is_active: false, trigger_value: 'DEFAULT', priority: 1 }], 'unknown')
  assert.equal(none.automation, null)
})
