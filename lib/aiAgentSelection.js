function selectSoleActiveAgent(agents) {
  return Array.isArray(agents) && agents.length === 1 ? agents[0] : null
}

module.exports = { selectSoleActiveAgent }
