const test = require('node:test')
const assert = require('node:assert/strict')
const { selectSoleActiveAgent } = require('../lib/aiAgentSelection')

test('one active AI agent is selectable', () => {
  assert.deepEqual(selectSoleActiveAgent([{ id: 'agent' }]), { id: 'agent' })
})

test('multiple active AI agents are deliberately not selected', () => {
  assert.equal(selectSoleActiveAgent([{ id: 'one' }, { id: 'two' }]), null)
  assert.equal(selectSoleActiveAgent([]), null)
})
