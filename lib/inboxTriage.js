const VIEWS = ['needs_attention', 'zoe', 'assigned_to_me', 'unassigned_human', 'unread', 'resolved', 'all']
function applyView(query, view, userId) {
  if (!VIEWS.includes(view)) throw new Error('Conversation view is invalid')
  if (view === 'needs_attention') return query.eq('status', 'needs_attention').eq('control_mode', 'needs_attention')
  if (view === 'zoe') return query.eq('status', 'open').eq('control_mode', 'automation')
  if (view === 'assigned_to_me') return query.eq('assigned_user_id', userId).neq('status', 'resolved').in('control_mode', ['needs_attention', 'human'])
  if (view === 'unassigned_human') return query.is('assigned_user_id', null).eq('status', 'needs_attention').eq('control_mode', 'needs_attention')
  if (view === 'unread') return query.gt('unread_count', 0)
  if (view === 'resolved') return query.eq('status', 'resolved')
  return query
}
function planAction(action, row, workspace, assignee, now) {
  const admin = ['owner', 'admin'].includes(workspace.role)
  const attention = row.status === 'needs_attention' && row.control_mode === 'needs_attention'
  const human = row.status === 'open' && row.control_mode === 'human'
  const own = row.assigned_user_id === workspace.userId
  if (action === 'assign' || action === 'assign_me') {
    if (!attention && !human) return { error: 'Assignment here is limited to waiting or human-handled conversations; Zoe handling is unchanged.' }
    if (action === 'assign' && !admin) return { error: 'Only administrators can assign another team member.' }
    if (!admin && !own && !(attention && !row.assigned_user_id)) return { error: 'This conversation belongs to another team member.' }
    return { patch: { assigned_user_id: action === 'assign_me' ? workspace.userId : assignee, updated_at: now }, event: 'assignment_changed' }
  }
  if (action === 'resolve') {
    if (!attention && !human) return { error: 'Only waiting or human-handled conversations can be bulk resolved.' }
    if (!admin && !own) return { error: 'Only the assignee or an administrator can resolve this conversation.' }
    return { patch: { status: 'resolved', control_mode: 'human', resolved_at: now, resolved_by_user_id: workspace.userId, unread_count: 0, updated_at: now }, event: 'conversation_resolved' }
  }
  if (action === 'reopen') {
    if (row.status !== 'resolved') return { error: 'Only resolved conversations can be reopened.' }
    return { patch: { status: 'open', control_mode: 'human', assigned_user_id: workspace.userId, taken_over_at: now, resolved_at: null, resolved_by_user_id: null, updated_at: now }, event: 'conversation_reopened_by_human' }
  }
  return { error: 'Unsupported action.' }
}
function validateBulk(body) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!['assign','assign_me','resolve','reopen'].includes(body?.action)) throw new Error('Invalid bulk action')
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 200) throw new Error('Select 1–200 conversations')
  if (body.items.some(item => !uuid.test(item?.id || '') || !item.updated_at || !Number.isFinite(Date.parse(item.updated_at)))) throw new Error('Each selection needs its current conversation version')
  if (new Set(body.items.map(item => item.id)).size !== body.items.length) throw new Error('Duplicate selections are not allowed')
  if (body.action === 'assign' && !uuid.test(body.assigned_user_id || '')) throw new Error('Choose a team member')
}
async function runBulk({ db, fields, workspace, body, assertMember, recordEvent }) {
  validateBulk(body)
  if (body.action === 'assign' && !['owner','admin'].includes(workspace.role)) return { status: 403, error: 'Administrator access required' }
  if (body.action === 'assign') await assertMember(workspace.customerId, body.assigned_user_id)
  const { data, error } = await db.from('conversations').select(fields).eq('customer_id', workspace.customerId).in('id', body.items.map(item => item.id))
  if (error) throw error
  const rows = new Map((data || []).map(row => [row.id, row]))
  const applyItem = async item => {
    const row = rows.get(item.id)
    if (!row) return { id: item.id, outcome: 'skipped', reason: 'Conversation not found in this workspace.' }
    if (row.updated_at !== item.updated_at) return { id: item.id, outcome: 'skipped', reason: 'Conversation changed. Refresh before retrying.' }
    const plan = planAction(body.action, row, workspace, body.assigned_user_id, new Date(Math.max(Date.now(), Date.parse(row.updated_at) + 1)).toISOString())
    if (plan.error) return { id: item.id, outcome: 'skipped', reason: plan.error }
    try {
      let query = db.from('conversations').update(plan.patch).eq('id', row.id).eq('customer_id', workspace.customerId).eq('updated_at', row.updated_at).eq('status', row.status).eq('control_mode', row.control_mode)
      query = row.assigned_user_id ? query.eq('assigned_user_id', row.assigned_user_id) : query.is('assigned_user_id', null)
      const { data: changed, error: writeError } = await query.select(fields).maybeSingle()
      if (writeError) throw writeError
      if (!changed) return { id: row.id, outcome: 'skipped', reason: 'Conversation changed during this action. Refresh before retrying.' }
      let warning
      try { await recordEvent({ customerId: workspace.customerId, conversationId: row.id, actorUserId: workspace.userId, eventType: plan.event, metadata: { bulk: true, action: body.action } }) }
      catch { warning = 'Action applied, but the audit event could not be recorded.' }
      return { id: row.id, outcome: 'applied', conversation: changed, ...(warning ? { warning } : {}) }
    } catch { return { id: row.id, outcome: 'error', reason: 'Unable to update this conversation. Refresh before retrying.' } }
  }
  // Independent rows keep their conditional writes; four lanes avoid hundreds
  // of serial round trips without flooding the database. Preserve input order.
  const results = []
  for (let offset = 0; offset < body.items.length; offset += 4) {
    results.push(...await Promise.all(body.items.slice(offset, offset + 4).map(applyItem)))
  }
  return { status: 200, results }
}
module.exports = { VIEWS, applyView, planAction, validateBulk, runBulk }
