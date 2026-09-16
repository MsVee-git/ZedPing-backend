const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'conversations.js'), 'utf8')

test('Assigned to Me is derived from the authenticated workspace caller', () => {
  assert.ok(source.includes("view === 'assigned_to_me'"))
  assert.ok(source.includes(".eq('assigned_user_id', req.workspace.userId)"))
  assert.equal(source.includes('req.query.user_id'), false)
  assert.equal(source.includes('req.body.assigned_user_id') && source.includes("view === 'assigned_to_me'"), false)
})

test('Unassigned service inbox excludes normal automation conversations', () => {
  assert.ok(source.includes("view === 'unassigned_human'"))
  assert.ok(source.includes(".eq('status', 'needs_attention').eq('control_mode', 'needs_attention')"))
})

test('Take and Reopen assign only the authenticated caller in the active workspace', () => {
  assert.ok(source.includes("router.post('/:id/take'"))
  assert.ok(source.includes("router.post('/:id/reopen'"))
  assert.ok(source.includes("assigned_user_id: req.workspace.userId"))
  assert.ok(source.includes(".eq('customer_id', req.workspace.customerId)"))
  assert.ok(source.includes(".eq('status', 'resolved')"))
})
