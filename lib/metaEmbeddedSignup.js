const axios = require('axios')

function compactSafeText(value) {
  if (typeof value !== 'string') return null
  return value
    .replace(/[\r\n]+/g, ' ')
    // Meta errors can echo a supplied credential. Remove labelled values
    // before applying the more general token and phone redaction below.
    .replace(/\b(?:authorization[ _-]?code|access[ _-]?token|token)\s*(?:=|:)?\s*[A-Za-z0-9_~.+\\/-]{4,}/gi, '[redacted]')
    .replace(/\bpin\s*(?:=|:)?\s*\d{4,}\b/gi, '[redacted]')
    .replace(/(?:Bearer\s+)?[A-Za-z0-9_~.+\\/-]{40,}/g, '[redacted]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[redacted]')
    .replace(/\b\d{5,32}\b/g, '[redacted]')
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
  // PostgREST/Postgres SQLSTATE values are useful for diagnosing a failed
  // persistence boundary, but are safe to expose only in the server log.
  // Do not treat transport errors such as ECONNRESET as database failures.
  if (typeof error?.code === 'string' && (/^[0-9A-Z]{5}$/.test(error.code) || /^PGRST[0-9A-Z]+$/.test(error.code))) {
    return {
      source: 'database',
      database_error_code: error.code,
      database_error_message: compactSafeText(error.message)
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

const COMPLETION_STAGES = new Set([
  'signup_asset_capture',
  'oauth_code_exchange',
  'ownership_validation',
  'whatsapp_number_persistence',
  'credential_storage',
  'waba_subscription',
  'phone_registration'
])

function safeUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null
}

function completionFailureDiagnostic({ stage, sessionId, workspaceId, error }) {
  return {
    event: 'embedded_signup_completion_failure',
    stage: COMPLETION_STAGES.has(stage) ? stage : 'unknown',
    success: false,
    session_id: safeUuid(sessionId),
    workspace_id: safeUuid(workspaceId),
    ...diagnosticFailure(error)
  }
}

function emitEmbeddedSignupDiagnostic(diagnostic, event) {
  const record = {
    event: 'embedded_signup_diagnostic',
    stage: diagnostic.stage,
    success: diagnostic.success === true,
    ...(diagnostic.success === true ? {} : diagnosticFailure(diagnostic.error)),
    ...(diagnostic.resource_ids || {}),
    ...(diagnostic.safe_fields || {})
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

const PHONE_NUMBER_FIELDS = 'id,display_phone_number,verified_name,quality_rating,code_verification_status'
const MAX_PHONE_NUMBER_PAGES_PER_WABA = 20
const EMPTY_PHONE_LIST_RETRY_COUNT = 2
const EMPTY_PHONE_LIST_RETRY_DELAY_MS = 250

function validMetaId(value) {
  return /^[0-9]{5,32}$/.test(String(value || ''))
}

function defaultDelay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function createMetaEmbeddedSignupClient({ http = axios, env = process.env, diagnostic = (record) => console.info(JSON.stringify(record)), delay = defaultDelay } = {}) {
  const version = String(env.META_GRAPH_API_VERSION || 'v18.0').trim()
  if (!/^v[0-9]+\.[0-9]+$/.test(version)) throw new MetaSignupError('Invalid Meta Graph API version')

  async function runStage(stage, operation, resourceIds, safeFields) {
    const fields = () => (typeof safeFields === 'function' ? safeFields() : safeFields)
    try {
      const result = await operation()
      emitEmbeddedSignupDiagnostic({ stage, success: true, resource_ids: resourceIds, safe_fields: fields() }, diagnostic)
      return result
    } catch (error) {
      emitEmbeddedSignupDiagnostic({ stage, success: false, error, resource_ids: resourceIds, safe_fields: fields() }, diagnostic)
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
    return runStage('token_waba_authorization', async () => {
      const response = await http.get(graphUrl(version, 'debug_token'), {
        params: { input_token: accessToken, access_token: appAccessToken() }
      })
      const tokenData = response && response.data && response.data.data
      if (!tokenData || tokenData.is_valid === false) throw new MetaSignupError('Meta did not validate the signup token')
      const scopes = tokenData.granular_scopes
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

  async function listPhoneNumbers(wabaId, accessToken, ownershipMetrics) {
    const records = []
    let after = null
    const seenCursors = new Set()
    for (let page = 0; page < MAX_PHONE_NUMBER_PAGES_PER_WABA; page += 1) {
      let response
      try {
        response = await http.get(graphUrl(version, `${wabaId}/phone_numbers`), {
          params: { fields: PHONE_NUMBER_FIELDS, ...(after ? { after } : {}) },
          headers: { Authorization: `Bearer ${accessToken}` }
        })
      } catch (error) {
        ownershipMetrics.phone_list_api_failures_count += 1
        throw error
      }
      const pageRecords = response?.data && Array.isArray(response.data.data) ? response.data.data : []
      records.push(...pageRecords)
      ownershipMetrics.phone_pages_fetched += 1
      const nextAfter = response?.data?.paging?.cursors?.after
      if (typeof nextAfter !== 'string' || !nextAfter || seenCursors.has(nextAfter)) return records
      seenCursors.add(nextAfter)
      after = nextAfter
    }
    throw new MetaSignupError('Meta returned too many phone-number pages for one WhatsApp Business Account')
  }

  async function validatePhoneOwnership({ accessToken, phoneNumberId, finishWabaId = null }) {
    const wabaIds = await authorizedWabaIds(accessToken)
    const claimedFinishWabaId = validMetaId(finishWabaId) ? String(finishWabaId) : null
    if (claimedFinishWabaId && !wabaIds.includes(claimedFinishWabaId)) {
      throw new MetaSignupError('Meta did not authorize the signup WhatsApp Business Account')
    }
    const candidateWabaIds = claimedFinishWabaId ? [claimedFinishWabaId] : wabaIds
    const ownershipMetrics = {
      authorized_waba_count: wabaIds.length,
      wabas_phone_listed_count: 0,
      total_phone_records_returned: 0,
      phone_pages_fetched: 0,
      empty_phone_list_retries: 0,
      ownership_match_count: 0,
      selected_phone_found: false,
      selected_phone_found_in_multiple_wabas: false,
      phone_list_api_failures_count: 0,
      selected_phone_has_display_number: false,
      selected_phone_code_verification_status: null,
      finish_waba_present: Boolean(claimedFinishWabaId),
      finish_waba_is_authorized_candidate: Boolean(claimedFinishWabaId && wabaIds.includes(claimedFinishWabaId)),
      finish_waba_lists_selected_phone: false,
      selected_phone_authorized_waba_match_count: 0,
      finish_waba_disambiguates_multiple_matches: false
    }
    const matches = await runStage('phone_ownership_lookup', async () => {
      const found = []
      for (let attempt = 0; attempt <= EMPTY_PHONE_LIST_RETRY_COUNT; attempt += 1) {
        const pages = await Promise.all(candidateWabaIds.map(async wabaId => ({ wabaId, records: await listPhoneNumbers(wabaId, accessToken, ownershipMetrics) })))
        const totalRecords = pages.reduce((total, page) => total + page.records.length, 0)
        if (totalRecords || attempt === EMPTY_PHONE_LIST_RETRY_COUNT) {
          for (const { wabaId, records } of pages) {
            ownershipMetrics.wabas_phone_listed_count += 1
            ownershipMetrics.total_phone_records_returned += records.length
            const number = records.find((candidate) => String(candidate.id) === String(phoneNumberId))
            if (number) found.push({ wabaId, number })
          }
          break
        }
        ownershipMetrics.empty_phone_list_retries += 1
        await delay(EMPTY_PHONE_LIST_RETRY_DELAY_MS)
      }
      ownershipMetrics.ownership_match_count = found.length
      ownershipMetrics.selected_phone_authorized_waba_match_count = found.length
      ownershipMetrics.selected_phone_found = found.length > 0
      ownershipMetrics.selected_phone_found_in_multiple_wabas = found.length > 1
      ownershipMetrics.finish_waba_lists_selected_phone = Boolean(claimedFinishWabaId && found.some(({ wabaId }) => wabaId === claimedFinishWabaId))
      ownershipMetrics.finish_waba_disambiguates_multiple_matches = false
      ownershipMetrics.selected_phone_has_display_number = found.some(({ number }) => typeof number.display_phone_number === 'string' && number.display_phone_number.trim())
      const verificationStatuses = new Set(found.map(({ number }) => number.code_verification_status).filter((value) => typeof value === 'string' && /^[A-Z_]{1,64}$/.test(value)))
      ownershipMetrics.selected_phone_code_verification_status = verificationStatuses.size === 1 ? [...verificationStatuses][0] : null
      if (found.length !== 1) throw new MetaSignupError('Meta could not prove that the selected phone number belongs to one authorized WhatsApp Business Account')
      return found
    }, undefined, () => ownershipMetrics)

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

  async function subscribeApp(wabaId, accessToken) {
    return runStage('waba_subscription', async () => {
      const token = typeof accessToken === 'string' && accessToken.trim() ? accessToken : configuredValue(env, 'META_ACCESS_TOKEN')
      const response = await http.post(graphUrl(version, `${wabaId}/subscribed_apps`), {}, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!response || !response.data || response.data.success !== true) {
        throw new MetaSignupError('Meta did not confirm the webhook subscription for this WhatsApp Business Account')
      }
    })
  }

  async function registerPhone(phoneNumberId, accessToken, pin) {
    if (!/^[0-9]{5,32}$/.test(String(phoneNumberId || ''))) throw new MetaSignupError('Phone number identifier is invalid')
    if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) throw new MetaSignupError('Registration PIN is invalid')
    return runStage('phone_registration', async () => {
      const response = await http.post(graphUrl(version, `${phoneNumberId}/register`), { messaging_product: 'whatsapp', pin }, { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } })
      if (!response?.data || response.data.success !== true) throw new MetaSignupError('Meta did not confirm phone registration')
      return true
    })
  }

  return { exchangeCode, validatePhoneOwnership, subscribeApp, registerPhone }
}

module.exports = { createMetaEmbeddedSignupClient, MetaSignupError, emitEmbeddedSignupDiagnostic, completionFailureDiagnostic }
