const test = require('node:test')
const assert = require('node:assert/strict')
const { deploymentMode, mayExecute, mayGoLive, mayReturnToTest } = require('../lib/aiDeploymentMode')

const agent = (lifecycle_status, deployment_mode, is_active = lifecycle_status === 'active') => ({ lifecycle_status, deployment_mode, is_active })

test('draft and paused agents cannot execute in either deployment mode', () => {
  for (const status of ['draft', 'paused', 'archived']) for (const mode of ['test', 'live']) {
    assert.equal(mayExecute(agent(status, mode), true), false)
    assert.equal(mayExecute(agent(status, mode), false), false)
  }
})

test('Test Mode requires an approved test contact while Live permits eligible ordinary contacts', () => {
  assert.equal(mayExecute(agent('active', 'test'), true), true)
  assert.equal(mayExecute(agent('active', 'test'), false), false)
  assert.equal(mayExecute(agent('active', 'live'), true), true)
  assert.equal(mayExecute(agent('active', 'live'), false), true)
})

test('lifecycle transitions have deterministic, idempotency-safe eligibility predicates', () => {
  assert.equal(mayGoLive(agent('active', 'test')), true)
  assert.equal(mayGoLive(agent('active', 'live')), false)
  assert.equal(mayReturnToTest(agent('active', 'live')), true)
  assert.equal(mayReturnToTest(agent('active', 'test')), false)
  assert.equal(deploymentMode(agent('active', 'unexpected')), 'test')
})
