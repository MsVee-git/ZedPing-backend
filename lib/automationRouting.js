function compareAutomations(a, b) {
  const priority = Number(a?.priority ?? 100) - Number(b?.priority ?? 100)
  if (priority) return priority
  const created = String(a?.created_at || '').localeCompare(String(b?.created_at || ''))
  if (created) return created
  return String(a?.id || '').localeCompare(String(b?.id || ''))
}

function selectAutomation(automations, body) {
  const text = String(body || '').trim().toUpperCase()
  const active = (Array.isArray(automations) ? automations : [])
    .filter((automation) => automation?.is_active)
    .sort(compareAutomations)

  const explicit = active.find((automation) => String(automation.trigger_value || '').trim().toUpperCase() === text)
  if (explicit) return { automation: explicit, kind: 'keyword' }

  const fallback = active.find((automation) => String(automation.trigger_value || '').trim().toUpperCase() === 'DEFAULT')
  return fallback ? { automation: fallback, kind: 'default' } : { automation: null, kind: null }
}

module.exports = { compareAutomations, selectAutomation }
