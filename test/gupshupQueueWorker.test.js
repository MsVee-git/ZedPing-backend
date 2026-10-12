const test = require('node:test')
const assert = require('node:assert/strict')
const { createGupshupQueueWorker } = require('../lib/gupshupQueueWorker')
test('messages use transactional inbox adapter; statuses use reconciliation', async () => {
 for (const type of ['message','status']) {
  let handled = ''
  const worker = createGupshupQueueWorker({ queue: { claimNext: async () => ({ id: 'event1', event_type: type }) }, inbox: { persistAndComplete: async () => { handled = 'message' } }, delivery: { reconcileAndComplete: async () => { handled = 'status' } } })
  assert.equal((await worker()).kind, 'complete'); assert.equal(handled, type)
 }
})
test('storage failure retains failure state rather than acknowledging completion', async () => {
 let failed = null
 const worker = createGupshupQueueWorker({ queue: { claimNext: async () => ({ id: 'event1', event_type: 'message' }), failClaim: async id => { failed = id } }, inbox: { persistAndComplete: async () => { throw Error('db') } } })
 assert.equal((await worker()).kind, 'failed'); assert.equal(failed, 'event1')
})
