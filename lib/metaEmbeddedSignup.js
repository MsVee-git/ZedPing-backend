const axios = require('axios')

function compactSafeText(value) {
  if (typeof value !== 'string') return null
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/(?:Bearer\\s+)?[A-Za-z0-9_~.+\\/-]{40,}/g, '[redacted]')
    .slice(0, 240)
}

function diagnosticFailure(error) {
  const metaError = error && error.response && error.response.data && error.response.data.error
  if (error && error.response) {
    return {
      source: 'meta_api',
      http_status: Number.isInteger(error.response.status) ? error.response.status : null,
      meta_error_code: typeof metaError?.code === 'number' || typeof metaError?.code === 'string' ? metaError.code : null,
      meta_error_type: compactSafeText(metaError?.type),
      meta_error_message: compactSafeText(metaError?.message)
    }
  }
  if (error instanceof MetaSignupError) {
    return {
      source: 'zedping_validation',
      http_status: null,
      meta_error_code: null,
      meta_error_type: null,
      meta_error_message: compactSafeText(error.message)
    }
  }
  return {
    source: 'meta_transport',
    http_status: null,
    meta_error_code: null,
    meta_error_type: null,
    meta_error_message: compactSafeText(error?.message)
  }
}

function emitEmbeddedSignupDiagnostic(diagnostic, event) {
  const record = {
    event: 'embedded_signup_diagnostic',
    stage: diagnostic.stage,
    success: diagnostic.success === true,
    ...(diagnostic.success === true ? {} : diagnosticFailure(diagnostic.error)),
    ...(diagnostic.resource_ids || {})
  }
  event(record)
  return record
}

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

function createMetaEmbeddedSignupClient({ http = axios, env = process.env, diagnostic = (record) => console.info(JSON.stringify(record)) } = {}) {
  const version = String(env.META_GRAPH_API_VERSION || 'v18.0').trim()
  if (!/^v[0-9]+\\.[0-9]+$/.test(version)) throw new MetaSignupError('Invalid Meta Graph API version')

  async function runStage(stage, operation, resourceIds) {
    try {
      const result = await operation()
      emitEmbeddedSignupDiagnostic({ stage, success: true, resource_ids: resourceIds }, diagnostic)
      return result
    } catch (error) {
      emitEmbeddedSignupDiagnostic({ stage, success: false, error, resource_ids: resourceIds }, diagnostic)
      throw error
    }
  }

  function appAccessToken() {
    return env.META_APP_ACCESS_TOKEN || `${configuredValue(env, 'META_APP_ID')}|${configuredValue(env, 'META_APP_SECRET')}`
  }

  async function exchangeCode(code) {
    return runStage('code_exchange', async () => {
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
    })
  }

  async function authorizedWabaIds(accessToken) {
    return runStage('token_debug', async () => {
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
    })
  }

  async function validatePhoneOwnership({ accessToken, phoneNumberId }) {
    const wabaIds = await authorizedWabaIds(accessToken)
    const matches = await runStage('phone_ownership_validation', async () => {
      const found = []
      for (const wabaId of wabaIds) {
        const response = await http.get(graphUrl(version, `${wabaId}/phone_numbers`), {
          params: { fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status' },
          headers: { Authorization: `Bearer ${accessToken}` }
        })
        const number = (response && response.data && Array.isArray(response.data.data) ? response.data.data : [])
          .find((candidate) => String(candidate.id) === String(phoneNumberId))
        if (number) found.push({ wabaId, number })
      }
      if (found.length !== 1) throw new MetaSignupError('Meta could not prove that the selected phone number belongs to one authorized WhatsApp Business Account')
      return found
    })

    return runStage('phone_metadata', async () => {
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
    })
  }

  async function subscribeApp(wabaId) {
    return runStage('waba_subscription', async () => {
      const systemToken = configuredValue(env, 'META_ACCESS_TOKEN')
      const response = await http.post(graphUrl(version, `${wabaId}/subscribed_apps`), {}, {
        headers: { Authorization: `Bearer ${systemToken}` }
      })
      if (!response || !response.data || response.data.success !== true) {
        throw new MetaSignupError('Meta did not confirm the webhook subscription for this WhatsApp Business Account')
      }
    })
  }

  return { exchangeCode, validatePhoneOwnership, subscribeApp }
}

module.exports = { createMetaEmbeddedSignupClient, MetaSignupError, emitEmbeddedSignupDiagnostic }
