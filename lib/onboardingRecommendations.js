const BLUEPRINTS = [
  {
    id: 'school-starter-pack',
    name: 'School Starter Pack',
    description: 'Start with parent updates, fee reminders, frequently asked questions, and a clear route to a person.',
    industries: ['education'],
    goals: ['customer_updates', 'payments_collections', 'customer_support'],
    automations: ['Parent Welcome', 'Parent Announcement', 'Fee Reminder', 'Term Date Reminder', 'FAQ Response', 'Human Handoff']
  },
  {
    id: 'automotive-starter-pack',
    name: 'Automotive Starter Pack',
    description: 'Keep customers updated from vehicle drop-off to collection.',
    industries: ['automotive'],
    goals: ['customer_updates', 'orders', 'customer_support'],
    automations: ['Vehicle Received', 'Job Status Update', 'Vehicle Ready for Collection', 'Service Reminder', 'Human Handoff']
  },
  {
    id: 'beauty-wellness-starter-pack',
    name: 'Beauty & Wellness Starter Pack',
    description: 'Confirm appointments, send reminders, and help customers rebook.',
    industries: ['beauty & wellness', 'beauty', 'wellness', 'spa'],
    goals: ['appointments_reminders', 'marketing_promotions', 'customer_support'],
    automations: ['Appointment Confirmation', 'Appointment Reminder', 'Rebooking Reminder', 'Aftercare Follow-up', 'Human Handoff']
  },
  {
    id: 'food-hospitality-starter-pack',
    name: 'Food & Hospitality Starter Pack',
    description: 'Share order updates, promotions, and quick customer-support replies.',
    industries: ['food & hospitality', 'food', 'hospitality', 'food manufacturer'],
    goals: ['orders', 'marketing_promotions', 'customer_updates'],
    automations: ['Order Confirmation', 'Order Update', 'Promotion Reply', 'FAQ Response', 'Human Handoff']
  },
  {
    id: 'fitness-coaching-starter-pack',
    name: 'Fitness & Coaching Starter Pack',
    description: 'Support enquiries, reminders, and programme follow-up.',
    industries: ['health/fitness/coaching', 'fitness', 'weight-loss', 'coaching'],
    goals: ['lead_follow_up', 'appointments_reminders', 'customer_support'],
    automations: ['Lead Qualification', 'Session Reminder', 'Programme Follow-up', 'FAQ Response', 'Human Handoff']
  }
]

const GENERAL = [
  { id: 'welcome-message', name: 'Welcome Message', description: 'Greet new customers and set expectations.', goals: ['customer_support', 'lead_follow_up'] },
  { id: 'out-of-office', name: 'Out of Office', description: 'Let customers know when your team will reply.', goals: ['customer_support'] },
  { id: 'faq-response', name: 'FAQ Response', description: 'Answer common questions consistently.', goals: ['customer_support'] },
  { id: 'human-handoff', name: 'Human Handoff', description: 'Route requests that need a person into the Team Inbox.', goals: ['customer_support', 'orders', 'payments_collections'] },
  { id: 'promotion-reply', name: 'Promotion Reply', description: 'Respond to interest in a campaign or offer.', goals: ['marketing_promotions'] },
  { id: 'lead-follow-up', name: 'Lead Follow-up', description: 'Keep new enquiries moving without losing the human touch.', goals: ['lead_follow_up'] }
]

function normalize(value) {
  return String(value || '').trim().toLowerCase()
}

function recommendationsFor({ industry, goals = [] } = {}) {
  const normalizedIndustry = normalize(industry)
  const selectedGoals = new Set(Array.isArray(goals) ? goals : [])
  const packs = BLUEPRINTS.filter((pack) =>
    (normalizedIndustry && pack.industries.some((candidate) => normalizedIndustry.includes(candidate) || candidate.includes(normalizedIndustry))) ||
    pack.goals.some((goal) => selectedGoals.has(goal))
  )
  const general = GENERAL.filter((item) => item.goals.some((goal) => selectedGoals.has(goal)))
  return { packs: packs.slice(0, 3), automations: general.slice(0, 4) }
}

module.exports = { recommendationsFor }
