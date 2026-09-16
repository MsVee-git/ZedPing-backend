const GOALS = [
  'customer_support',
  'marketing_promotions',
  'customer_updates',
  'lead_follow_up',
  'appointments_reminders',
  'payments_collections',
  'orders',
  'internal_notifications'
]

const TEAM_SIZES = ['1', '2-5', '6-10', '11-25', '25+']

const CONTACT_SOURCES = [
  'excel',
  'google_sheets',
  'airtable',
  'phone_contacts',
  'pos',
  'crm',
  'other'
]

function cleanSelection(value, allowed, label, { required = false } = {}) {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`)
  const values = [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
  if (required && !values.length) throw new Error(`Choose at least one ${label.toLowerCase()}`)
  if (values.some((item) => !allowed.includes(item))) throw new Error(`One or more ${label.toLowerCase()} are not supported`)
  return values
}

function validateDiscovery(input = {}) {
  const allowed = new Set(['goals', 'team_size', 'contact_sources'])
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error('Only discovery fields can be updated')
  }

  const goals = cleanSelection(input.goals, GOALS, 'Goals', { required: true })
  const contact_sources = cleanSelection(input.contact_sources, CONTACT_SOURCES, 'Contact sources')
  const team_size = input.team_size == null ? null : String(input.team_size).trim()

  if (!TEAM_SIZES.includes(team_size)) throw new Error('Choose a valid team size')

  return { goals, team_size, contact_sources }
}

module.exports = { GOALS, TEAM_SIZES, CONTACT_SOURCES, validateDiscovery }
