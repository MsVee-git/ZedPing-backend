const supabase = require('../lib/supabase')
const { resolveWorkspaceSelection } = require('./workspaceSelection')

async function requireWorkspace(req, res, next) {
  const header = req.get('authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Authentication required' })

  const { data: { user }, error: authError } = await supabase.auth.getUser(token)
  if (authError || !user) return res.status(401).json({ error: 'Invalid or expired session' })

  const [{ data: owned }, { data: memberships }] = await Promise.all([
    supabase.from('customers').select('id').eq('auth_user_id', user.id),
    supabase.from('workspace_members').select('customer_id, role').eq('user_id', user.id)
  ])
  const workspaces = new Map()
  for (const workspace of owned || []) workspaces.set(workspace.id, 'owner')
  for (const membership of memberships || []) {
    if (!workspaces.has(membership.customer_id) || membership.role === 'owner') {
      workspaces.set(membership.customer_id, membership.role)
    }
  }

  const selection = resolveWorkspaceSelection(workspaces, req.get('x-zedping-workspace-id'))
  if (selection.kind === 'selection_required') {
    return res.status(400).json({ error: 'Select a workspace with x-zedping-workspace-id' })
  }
  if (selection.kind === 'unauthorized') {
    return res.status(403).json({ error: 'You do not have access to this workspace' })
  }

  req.workspace = {
    customerId: selection.customerId,
    role: selection.role,
    userId: user.id,
    emailVerified: Boolean(user.email_confirmed_at)
  }
  next()
}

function requireAdmin(req, res, next) {
  if (!['owner', 'admin'].includes(req.workspace.role)) return res.status(403).json({ error: 'Administrator access required' })
  next()
}

module.exports = { requireWorkspace, requireAdmin }
