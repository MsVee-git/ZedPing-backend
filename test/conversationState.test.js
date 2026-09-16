const test = require('node:test')
const assert = require('node:assert/strict')
const { shouldSuppressAutomation, stateForInbound, mayResolve } = require('../lib/conversationState')

test('automation-controlled conversations permit automation', () => {
  assert.equal(shouldSuppressAutomation({ status: 'open', control_mode: 'automation' }), false)
})

test('needs-attention and human control suppress automation', () => {
  assert.equal(shouldSuppressAutomation({ status: 'needs_attention', control_mode: 'needs_attention' }), true)
  assert.equal(shouldSuppressAutomation({ status: 'open', control_mode: 'human' }), true)
})

test('next inbound after resolution reopens automation safely', () => {
  assert.deepEqual(stateForInbound({ status: 'resolved', control_mode: 'human', assigned_user_id: 'member-a' }), {
    status: 'open', control_mode: 'automation', assigned_user_id: null, reopened: true
  })
})

test('only the assignee or an administrator may resolve', () => {
  const conversation = { assigned_user_id: 'member-a' }
  assert.equal(mayResolve({ role: 'member', userId: 'member-a', conversation }), true)
  assert.equal(mayResolve({ role: 'member', userId: 'member-b', conversation }), false)
  assert.equal(mayResolve({ role: 'admin', userId: 'member-b', conversation }), true)
})
