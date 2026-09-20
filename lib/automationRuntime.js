const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const EXPLICIT_TYPES = new Set(['keyword', 'faq', 'lead_capture', 'human_handoff', 'custom'])

function compareAutomations(a, b) {
  const priority = Number(a?.priority ?? 100) - Number(b?.priority ?? 100)
  if (priority) return priority
  const created = String(a?.created_at || '').localeCompare(String(b?.created_at || ''))
  if (created) return created
  return String(a?.id || '').localeCompare(String(b?.id || ''))
}

function text(value) { return String(value || '').trim().toUpperCase() }

function typeOf(automation) {
  if (automation?.automation_type) return String(automation.automation_type).toLowerCase()
  return text(automation?.trigger_value) === 'DEFAULT' ? 'legacy_default' : 'keyword'
}

function phrasesFor(automation) {
  const phrases = automation?.trigger_config?.phrases
  if (Array.isArray(phrases) && phrases.length) return phrases.map(text).filter(Boolean)
  const legacy = text(automation?.trigger_value)
  return legacy && legacy !== 'DEFAULT' ? [legacy] : []
}

function active(automations) {
  return (Array.isArray(automations) ? automations : [])
    .filter((automation) => automation?.is_active && !automation?.archived_at)
    .sort(compareAutomations)
}

function selectExplicitAutomation(automations, body) {
  const incoming = text(body)
  return active(automations).find((automation) => EXPLICIT_TYPES.has(typeOf(automation)) && phrasesFor(automation).includes(incoming)) || null
}

function selectAwayAutomation(automations) {
  return active(automations).find((automation) => typeOf(automation) === 'away') || null
}

function selectWelcomeAutomation(automations) {
  return active(automations).find((automation) => typeOf(automation) === 'welcome') || null
}

function selectDefaultAutomation(automations) {
  return active(automations).find((automation) => text(automation.trigger_value) === 'DEFAULT') || null
}

function selectAutomation(automations, body) {
  const explicit = selectExplicitAutomation(automations, body)
  if (explicit) return { automation: explicit, kind: typeOf(explicit) === 'faq' ? 'faq' : 'keyword' }
  const fallback = selectDefaultAutomation(automations)
  return fallback ? { automation: fallback, kind: 'default' } : { automation: null, kind: null }
}

function validateTimezone(timezone) {
  if (typeof timezone !== 'string' || !timezone) throw new Error('A valid IANA timezone is required')
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format() } catch (_) { throw new Error('Timezone is invalid') }
  return timezone
}

function minute(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Business-hours times must use HH:MM')
  const [hour, min] = value.split(':').map(Number)
  return hour * 60 + min
}

function validateBusinessHours(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Business hours are invalid')
  const result = {}
  for (const day of DAYS) {
    const intervals = value[day] || []
    if (!Array.isArray(intervals) || intervals.length > 3) throw new Error('Each day may have up to three business-hour intervals')
    result[day] = intervals.map((interval) => {
      const start = minute(interval?.start)
      const end = minute(interval?.end)
      if (start === end) throw new Error('Business-hours start and end cannot be the same')
      return { start: interval.start, end: interval.end }
    })
  }
  if (Object.keys(value).some((key) => !DAYS.includes(key))) throw new Error('Business-hours day is invalid')
  return result
}

function localParts(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const take = (type) => parts.find((part) => part.type === type)?.value
  return { day: String(take('weekday')).toLowerCase().slice(0, 3), minute: Number(take('hour')) * 60 + Number(take('minute')) }
}

function previousDay(day) { return DAYS[(DAYS.indexOf(day) + 6) % 7] }

function isOutsideBusinessHours(settings, now = new Date()) {
  if (!settings?.timezone || !settings?.business_hours) return false
  const timezone = validateTimezone(settings.timezone)
  const hours = validateBusinessHours(settings.business_hours)
  const current = localParts(now, timezone)
  const withinToday = (hours[current.day] || []).some(({ start, end }) => {
    const from = minute(start); const to = minute(end)
    return from < to && current.minute >= from && current.minute < to
  })
  if (withinToday) return false
  const fromPreviousOvernight = (hours[previousDay(current.day)] || []).some(({ start, end }) => {
    const from = minute(start); const to = minute(end)
    return from > to && current.minute < to
  })
  if (fromPreviousOvernight) return false
  const withinOvernightToday = (hours[current.day] || []).some(({ start, end }) => {
    const from = minute(start); const to = minute(end)
    return from > to && current.minute >= from
  })
  return !withinOvernightToday
}

module.exports = { DAYS, compareAutomations, typeOf, phrasesFor, selectAutomation, selectExplicitAutomation, selectAwayAutomation, selectWelcomeAutomation, selectDefaultAutomation, validateTimezone, validateBusinessHours, isOutsideBusinessHours }

