const CONTROL_MODES = ['automation', 'needs_attention', 'human']
const STATUSES = ['open', 'needs_attention', 'resolved']

function shouldSuppressAutomation(conversation) {
  return ['needs_attention', 'human'].includes(conversation?.control_mode)
}

function stateForInbound(conversation) {
  if (!conversation || conversation.status === 'resolved') {
    return { status: 'open', control_mode: 'automation', assigned_user_id: null, reopened: Boolean(conversation) }
  }
  return {
    status: conversation.status || 'open',
    control_mode: conversation.control_mode || 'automation',
    assigned_user_id: conversation.assigned_user_id || null,
    reopened: false
  }
}

function mayResolve({ role, userId, conversation }) {
  return ['owner', 'admin'].includes(role) || conversation?.assigned_user_id === userId
}

module.exports = { CONTROL_MODES, STATUSES, shouldSuppressAutomation, stateForInbound, mayResolve }
