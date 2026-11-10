const test = require('node:test')
const assert = require('node:assert/strict')
const { recipientReport, rejectionCode, retryCampaignMessage } = require('../lib/broadcastRetry')

const campaign = { id: 'campaign', status: 'completed', message: '[Template] notice (en)' }
function message(id, status, receipts = {}, extra = {}) {
  const phone = '26097000000' + id
  return {
    id, customer_id: 'workspace', whatsapp_number_id: 'connection', direction: 'outbound',
    to_number: phone, status, delivery_receipts: receipts,
    broadcast_send_spec: { to: phone, template: { name: 'notice', language: 'en' } }, ...extra
  }
}
function failure(code) { return { failed_at: '2026-11-10', errors: [{ code }] } }

test('a five-recipient broadcast retries only a confirmed temporary failure', () => {
  const rows = [
    message('1', 'delivered', { delivered_at: '2026-11-10' }),
    message('2', 'read', { read_at: '2026-11-10' }),
    message('3', 'accepted'),
    message('4', 'failed', failure(131049)),
    message('5', 'failed', failure(131016))
  ]
  const report = recipientReport(rows, campaign)
  assert.equal(report.delivery.delivered, 2)
  assert.deepEqual(report.failures.filter(row => row.can_retry).map(row => row.id), ['5'])
  assert.deepEqual(report.pending.map(row => row.id), ['3'])
  assert.equal(recipientReport(rows, { ...campaign, status: 'sending' }).failures.some(row => row.can_retry), false)
})

test('retry receipts replace the failure in the campaign totals and keep an uncertain retry out of the retry list', () => {
  const original = message('1', 'failed', failure(131016), { broadcast_retry_id: '2' })
  const duplicate = message('3', 'failed', failure(131016), { to_number: original.to_number, broadcast_send_spec: original.broadcast_send_spec })
  const waiting = recipientReport([original, duplicate], campaign)
  assert.equal(waiting.failures.some(row => row.can_retry), false)
  assert.equal(waiting.pending.length, 1)
  const delivered = recipientReport([original, message('2', 'delivered', { delivered_at: '2026-11-10' })], campaign)
  assert.equal(delivered.delivery.delivered, 1)
  assert.equal(delivered.delivery.failed, 0)
  assert.equal(delivered.failures.length, 0)
})

test('an ambiguous submission is never classified as a retryable provider rejection', () => {
  assert.equal(rejectionCode({ response: { status: 400, data: { error: { code: 131056 } } } }), 131056)
  assert.equal(rejectionCode({ response: { status: 503, data: { error: { code: 131016 } } } }), null)
  assert.equal(rejectionCode(new Error('network timeout')), null)
})

test('concurrent retry requests claim the original once and persist the new provider ID', async () => {
  const inserts = []
  let claimed = false
  const filters = []
  const db = { from() {
    return {
      update() {
        const query = {
          eq(field, value) { filters.push([field, value]); return query },
          is() { return query },
          select() { return query },
          async maybeSingle() {
            if (claimed) return { data: null }
            claimed = true
            return { data: { id: '1', status: 'failed' } }
          }
        }
        return query
      },
      async insert(row) { inserts.push(row); return { error: null } }
    }
  } }
  const original = message('1', 'failed', failure(131016))
  const send = async () => ({ messages: [{ id: 'retry-provider-id' }] })
  const outcomes = await Promise.all([
    retryCampaignMessage(db, campaign, original, send), retryCampaignMessage(db, campaign, original, send)
  ])
  assert.deepEqual(outcomes.sort(), ['accepted', 'skipped'])
  assert.deepEqual(filters.slice(0, 4), [['customer_id', 'workspace'], ['broadcast_id', 'campaign'], ['id', '1'], ['status', 'failed']])
  assert.equal(inserts.length, 1)
  assert.equal(inserts[0].meta_message_id, 'retry-provider-id')
})
