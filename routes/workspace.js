const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { requireAdmin } = require('../middleware/auth')

const PROFILE_FIELDS = ['business_name', 'contact_person', 'phone', 'country', 'industry', 'email']
const WORKSPACE_COLUMNS = 'id, business_name, contact_person, phone, country, industry, email, subscription_plan, subscription_status, profile_completed_at, whatsapp_connected_at, onboarding_completed_at, onboarding_status, onboarded'

function cleanText(value, label, { min = 1, max = 160, email = false } = {}) {
  if (typeof value !== 'string') throw new Error(`${label} is required`)
  const cleaned = value.trim()
  if (cleaned.length < min || cleaned.length > max) throw new Error(`${label} must be between ${min} and ${max} characters`)
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) throw new Error('Enter a valid business/support email address')
  return email ? cleaned.toLowerCase() : cleaned
}

function onboardingFor(workspace, emailVerified) {
  return {
    account_complete: true,
    email_verified: Boolean(emailVerified),
    business_profile_complete: Boolean(workspace.profile_completed_at),
    whatsapp_connected: Boolean(workspace.whatsapp_connected_at),
    onboarding_complete: workspace.onboarding_status === 'complete',
    status: workspace.onboarding_status
  }
}

async function loadWorkspace(customerId) {
  const { data, error } = await supabase
    .from('customers')
    .select(WORKSPACE_COLUMNS)
    .eq('id', customerId)
    .single()
  if (error) throw error
  return data
}

router.get('/', async (req, res) => {
  try {
    const workspace = await loadWorkspace(req.workspace.customerId)
    return res.json({
      workspace,
      role: req.workspace.role,
      onboarding: onboardingFor(workspace, req.workspace.emailVerified)
    })
  } catch (error) {
    return res.status(500).json({ error: 'Unable to load this workspace' })
  }
})

router.patch('/profile', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {}
    const unexpected = Object.keys(body).filter((key) => !PROFILE_FIELDS.includes(key))
    if (unexpected.length) return res.status(400).json({ error: 'Only business profile fields can be updated' })

    const profile = {
      business_name: cleanText(body.business_name, 'Business name', { min: 2, max: 160 }),
      contact_person: cleanText(body.contact_person, 'Contact person', { min: 2, max: 160 }),
      phone: cleanText(body.phone, 'Business phone', { min: 6, max: 40 }),
      country: cleanText(body.country, 'Country', { min: 2, max: 80 }),
      industry: cleanText(body.industry, 'Industry', { min: 2, max: 100 }),
      email: cleanText(body.email, 'Business/support email', { min: 5, max: 254, email: true })
    }

    const { data: workspace, error } = await supabase
      .from('customers')
      .update(profile)
      .eq('id', req.workspace.customerId)
      .select(WORKSPACE_COLUMNS)
      .single()
    if (error) return res.status(500).json({ error: 'Unable to save the business profile' })

    return res.json({
      workspace,
      role: req.workspace.role,
      onboarding: onboardingFor(workspace, req.workspace.emailVerified)
    })
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Invalid business profile' })
  }
})

module.exports = router
