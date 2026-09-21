const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('AI management is workspace-protected and owner/admin-only', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'aiAgents.js'), 'utf8')
  assert.ok(source.includes('router.post(\'/\', requireAdmin'))
  assert.ok(source.includes('router.patch(\'/:id\', requireAdmin'))
  assert.ok(source.includes(".eq('customer_id', req.workspace.customerId)"))
  assert.equal(source.includes('req.body.customer_id'), false)
  assert.equal(source.includes('req.body.model'), false)
})

test('AI runtime is evaluated after Team Inbox suppression and before Flow execution', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhook.js'), 'utf8')
  assert.ok(source.indexOf('shouldSuppressAutomation(conversation)') < source.indexOf('checkAISession(ctx)'))
  assert.ok(source.indexOf('checkAISession(ctx)') < source.indexOf('continueFlow(ctx, outgoing)'))
  assert.ok(source.includes('recordAiExecutionEvent'))
  assert.ok(source.includes('sessionExpired(session)'))
})

test('manual team control terminates active AI sessions', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'conversations.js'), 'utf8')
  assert.ok(source.includes('closeActiveAiSessionsForConversation'))
  assert.ok(source.includes("reason: 'manual_takeover'"))
  assert.ok(source.includes("reason: 'manual_handoff'"))
})
