// Inbox adapter MUST atomically persist the message/conversation and complete
// the queue row in one DB transaction. Automated sends run through an outbox,
// never inside that transaction. No production adapter is connected yet.
function createGupshupQueueWorker({ queue, inbox, delivery }) {
  return async function runOnce() {
    const event = await queue.claimNext()
    if (!event) return { kind: 'idle' }
    try {
      if (event.event_type === 'message') {
        await inbox.persistAndComplete(event)
      } else if (event.event_type === 'status') {
        await delivery.reconcileAndComplete(event)
      } else throw new Error('Unsupported queued event')
      return { kind: 'complete', eventId: event.id }
    } catch {
      await queue.failClaim(event.id)
      return { kind: 'failed', eventId: event.id }
    }
  }
}
module.exports = { createGupshupQueueWorker }
