function gupshupConfigForCustomer(customerId, env = process.env, purpose = "onboarding") {
  const allowed = (env.GUPSHUP_TEST_CUSTOMER_IDS || '').split(',').map(value => value.trim()).filter(Boolean)
  if (env[purpose === 'messaging' ? 'GUPSHUP_ROUTING_ENABLED' : 'GUPSHUP_ONBOARDING_ENABLED'] !== 'true' || (env.GUPSHUP_PRODUCTION_ONBOARDING !== 'true' && !allowed.includes(customerId))) return null
  const config = {
    solutionId: env.GUPSHUP_SOLUTION_ID,
    walletId: env.GUPSHUP_WALLET_ID,
    callbackUrl: env.GUPSHUP_CALLBACK_URL
  }
  if (Object.values(config).some(value => typeof value !== 'string' || !value.trim())) throw new Error('Gupshup configuration is incomplete')
  if (!/^[0-9]+$/.test(config.solutionId)) throw new Error('Gupshup solution ID is invalid')
  const callback = new URL(config.callbackUrl)
  if (callback.protocol !== 'https:' || callback.username || callback.password || callback.hash) throw new Error('Gupshup callback is invalid')
  if (typeof env.GUPSHUP_UNIVERSAL_TOKEN === 'string' && env.GUPSHUP_UNIVERSAL_TOKEN.trim()) {
    config.universalToken = env.GUPSHUP_UNIVERSAL_TOKEN.trim()
  } else {
    if (!env.GUPSHUP_PARTNER_EMAIL?.trim() || !env.GUPSHUP_PARTNER_SECRET?.trim()) throw new Error('Gupshup configuration is incomplete')
    config.email = env.GUPSHUP_PARTNER_EMAIL
    config.secret = env.GUPSHUP_PARTNER_SECRET
  }
  return config
}

module.exports = { gupshupConfigForCustomer }
