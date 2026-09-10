const axios = require('axios')

class MetaSignupError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MetaSignupError'
  }
}

function configuredValue(env, name) {
  const value = env[name]
  if (typeof value !== 'string' || !value.trim()) throw new MetaSignupError(`Missing required Meta configuration: ${name}`)
  return value.trim()
}

function graphUrl(version, path) {
  return `https://graph.facebook.com/${version}/${path}`
}

function createMetaEmbeddedSignupClient({ http = axios, env = process.env } = {}) {
  const version = String(env.META_GRAPH_API_VERSION || 'v18.0').trim()
  if (!/^v[0-9]+\.[0-9]+$/.test(version)) throw new MetaSignupError('Invalid Meta Graph API version')

  function appAccessToken() {
    return env.META_APP_ACCESS_TOKEN || `${configuredValue(env, 'META_APP_ID')}|${configuredValue(env, 'META_APP_SECRET')}`
  }

  async function exchangeCode(code) {
    const response = await http.get(graphUrl(version, 'oauth/access_token'), {
      params: {
        client_id: configuredValue(env, 'META_APP_ID'),
        client_secret: configuredValue(env, 'META_APP_SECRET'),
        code
      }
    })
    const token = response && response.data && response.data.access_token
    if (typeof token !== 'string' || token.length < 10) throw new MetaSignupError('Meta did not return a usable signup token')
    return token
  }

  async function authorizedWabaIds(accessToken) {
    const response = await http.get(graphUrl(version, 'debug_token'), {
      params: { input_token: accessToken, access_token: appAccessToken() }
    })
    const scopes = response && response.data && response.data.data && response.data.data.granular_scopes
    const ids = new Set()
    for (const scope of Array.isArray(scopes) ? scopes : []) {
      if (scope && scope.scope === 'whatsapp_business_management') {
        for (const id of Array.isArray(scope.target_ids) ? scope.target_ids : []) {
          if (/^[0-9]+$/.test(String(id))) ids.add(String(id))
        }
      }
    }
    if (!ids.size) throw new MetaSignupError('Meta did not prove WhatsApp Business Account access for this signup')
    return [...ids]
  }

  async function validatePhoneOwnership({ accessToken, phoneNumberId }) {
    const wabaIds = await authorizedWabaIds(accessToken)
    const matches = []
    for (const wabaId of wabaIds) {
      const response = await http.get(graphUrl(version, `${wabaId}/phone_numbers`), {
        params: { fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status' },
        headers: { Authorization: `Bearer ${accessToken}` }
      })
      const number = (response && response.data && Array.isArray(response.data.data) ? response.data.data : [])
        .find((candidate) => String(candidate.id) === String(phoneNumberId))
      if (number) matches.push({ wabaId, number })
    }
    if (matches.length !== 1) throw new MetaSignupError('Meta could not prove that the selected phone number belongs to one authorized WhatsApp Business Account')
    const { wabaId, number } = matches[0]
    if (typeof number.display_phone_number !== 'string' || !number.display_phone_number.trim()) {
      throw new MetaSignupError('Meta did not return a display phone number')
    }
    return {
      wabaId,
      phoneNumberId: String(number.id),
      displayPhoneNumber: number.display_phone_number.trim(),
      displayName: typeof number.verified_name === 'string' ? number.verified_name.trim() : null,
      qualityRating: typeof number.quality_rating === 'string' ? number.quality_rating : null,
      verificationStatus: typeof number.code_verification_status === 'string' ? number.code_verification_status : null
    }
  }

  async function subscribeApp(wabaId) {
    const systemToken = configuredValue(env, 'META_ACCESS_TOKEN')
    const response = await http.post(graphUrl(version, `${wabaId}/subscribed_apps`), {}, {
      headers: { Authorization: `Bearer ${systemToken}` }
    })
    if (!response || !response.data || response.data.success !== true) {
      throw new MetaSignupError('Meta did not confirm the webhook subscription for this WhatsApp Business Account')
    }
  }

  return { exchangeCode, validatePhoneOwnership, subscribeApp }
}

module.exports = { createMetaEmbeddedSignupClient, MetaSignupError }
