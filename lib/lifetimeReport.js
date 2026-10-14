const PAGE_SIZE = 500
const MAX_ROWS = 250000

function checked(result) {
  if (result.error) throw result.error
  return result
}
async function scan(db, table, columns, customerId, cutoff, visit, pageSize = PAGE_SIZE) {
  let cursor = null, seen = 0
  while (true) {
    let query = db.from(table).select(columns).eq('customer_id', customerId)
      .lte('created_at', cutoff).order('id', { ascending: true }).limit(pageSize)
    if (cursor !== null) query = query.gt('id', cursor)
    const rows = checked(await query).data || []
    if (!rows.length) return
    seen += rows.length
    if (seen > MAX_ROWS) throw new Error('This workspace needs a background export. No partial report was returned.')
    for (const row of rows) visit(row)
    const next = rows[rows.length - 1].id
    if (next == null || next === cursor) throw new Error('Report pagination did not advance')
    cursor = next
  }
}
async function exactCount(db, table, customerId) {
  const result = checked(await db.from(table).select('id', { count: 'exact', head: true }).eq('customer_id', customerId))
  if (!Number.isSafeInteger(result.count) || result.count < 0) throw new Error('Report count unavailable')
  return result.count
}
function initialMessages() {
  return { total: 0, inbound: 0, outbound: 0, other_direction: 0, outbound_statuses: Object.create(null), first_recorded_at: null, last_recorded_at: null }
}
function addMessage(summary, row, contacts) {
  summary.total++
  if (row.direction === 'inbound' || row.direction === 'outbound') summary[row.direction]++
  else summary.other_direction++
  if (row.direction === 'outbound') {
    const status = typeof row.status === 'string' && row.status.trim() ? row.status.trim() : 'not_recorded'
    summary.outbound_statuses[status] = (summary.outbound_statuses[status] || 0) + 1
  }
  // Prefer the external phone: one person may have more than one stored contact.
  const phone = row.direction === 'inbound' ? row.from_number : row.direction === 'outbound' ? row.to_number : null
  const normalized = typeof phone === 'string' ? phone.replace(/\D/g, '') : ''
  if (normalized) contacts.add('phone:' + normalized)
  else if (row.contact_id) contacts.add('contact:' + row.contact_id)
  if (row.created_at) {
    if (!summary.first_recorded_at || row.created_at < summary.first_recorded_at) summary.first_recorded_at = row.created_at
    if (!summary.last_recorded_at || row.created_at > summary.last_recorded_at) summary.last_recorded_at = row.created_at
  }
}
function nonnegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}
async function loadLifetimeReport(db, customerId, { now = new Date(), pageSize = PAGE_SIZE } = {}) {
  if (!customerId) throw new Error('Workspace required')
  const generatedAt = now.toISOString()
  const messages = initialMessages(), correspondents = new Set(), campaigns = []
  const [contacts, conversations, automations] = await Promise.all([
    exactCount(db, 'contacts', customerId), exactCount(db, 'conversations', customerId), exactCount(db, 'automations', customerId)
  ])
  await scan(db, 'messages', 'id,direction,status,created_at,from_number,to_number,contact_id', customerId, generatedAt,
    row => addMessage(messages, row, correspondents), pageSize)
  await scan(db, 'scheduled_broadcasts', 'id,broadcast_name,status,created_at,scheduled_at,completed_at,sent_count,failed_count,contacts', customerId, generatedAt,
    row => campaigns.push({
      id: row.id, name: row.broadcast_name || 'Untitled', status: row.status || 'not_recorded',
      created_at: row.created_at, scheduled_at: row.scheduled_at, completed_at: row.completed_at,
      accepted: nonnegative(row.sent_count), failed: nonnegative(row.failed_count),
      recorded_recipients: Array.isArray(row.contacts) ? row.contacts.length : null
    }), pageSize)
  campaigns.sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)) || String(a.id).localeCompare(String(b.id)))
  const broadcastStatuses = Object.create(null)
  for (const row of campaigns) broadcastStatuses[row.status] = (broadcastStatuses[row.status] || 0) + 1
  return {
    schema_version: 1, scope: 'lifetime', workspace_id: customerId, generated_at: generatedAt, cutoff_inclusive: generatedAt,
    messages: { ...messages, recorded_correspondents: correspondents.size },
    current: { contacts, conversations, automations },
    broadcasts: { total: campaigns.length, statuses: broadcastStatuses, campaigns },
    unavailable: ['Verified delivery/read rates', 'Campaign reply attribution', 'Sales and revenue attribution', 'Messaging charges'],
    definitions: [
      'Lifetime means all retained message and broadcast records created on or before this report was generated; it is not WhatsApp history before ZedPing recorded it.',
      'Outbound statuses are stored latest statuses. Accepted or sent does not prove delivery. No delivery, read, reply or sales rate is inferred.',
      'Recorded correspondents use normalized phone numbers with contact IDs as a fallback; missing identifiers and duplicate contact records may affect this count.',
      'Contacts, conversations and automations are current record counts, not historical unique acquisitions or lifetime resolutions.',
      'Broadcast recipient counts are per-campaign audience entries, not deduplicated people. Blank sent/failed counters mean unavailable.',
      'Messages already include stored broadcast messages; campaign accepted counts must not be added to message totals.',
      'This read-only report uses a fixed creation cutoff. Stored statuses can change during generation; it is not a transactional historical snapshot.'
    ]
  }
}
module.exports = { loadLifetimeReport, scan, exactCount, initialMessages, addMessage }
