const test = require('node:test')
const assert = require('node:assert/strict')
const {
  BETA_MODEL, MAX_RECENT_MESSAGES, MAX_CONTEXT_CHARS, MAX_REPLY_CHARS,
  boundedHistory, boundedReply, sessionExpired, estimateCostUsd, isHandoffRequested
} = require('../lib/aiRuntime')

test('AI runtime uses one server-controlled beta model and bounds memory', () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'x'.repeat(1000) }))
  const history = boundedHistory(messages)
  assert.equal(BETA_MODEL, 'gpt-4o-mini')
  assert.ok(history.length <= MAX_RECENT_MESSAGES)
  assert.ok(history.reduce((total, item) => total + item.content.length, 0) <= MAX_CONTEXT_CHARS)
  assert.equal(boundedReply('x'.repeat(MAX_REPLY_CHARS + 1)).length, MAX_REPLY_CHARS)
})

test('AI session expiry and explicit handoff keyword are deterministic', () => {
  assert.equal(sessionExpired({ last_activity_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }), true)
  assert.equal(sessionExpired({ last_activity_at: new Date().toISOString() }), false)
  assert.equal(isHandoffRequested({ handoff_keyword: 'human' }, ' HUMAN '), true)
  assert.equal(isHandoffRequested({ handoff_keyword: 'human' }, 'help me'), false)
})

test('cost estimate uses bounded non-secret usage metadata', () => {
  assert.equal(estimateCostUsd('gpt-4o-mini', 1000000, 1000000), 0.75)
  assert.equal(estimateCostUsd('unknown', 1, 1), null)
})
