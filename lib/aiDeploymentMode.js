const VALID_MODES = new Set(['test', 'live'])

function deploymentMode(agent) {
  const mode = String(agent?.deployment_mode || 'test')
  return VALID_MODES.has(mode) ? mode : 'test'
}

function isActiveAgent(agent) {
  return agent?.lifecycle_status === 'active' && agent?.is_active === true
}

function mayExecute(agent, approvedTestContact) {
  if (!isActiveAgent(agent)) return false
  return deploymentMode(agent) === 'live' || approvedTestContact === true
}

function mayGoLive(agent) {
  return isActiveAgent(agent) && deploymentMode(agent) === 'test'
}

function mayReturnToTest(agent) {
  return isActiveAgent(agent) && deploymentMode(agent) === 'live'
}

module.exports = { deploymentMode, isActiveAgent, mayExecute, mayGoLive, mayReturnToTest }
