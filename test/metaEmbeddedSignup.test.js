const test = require('node:test')
const assert = require('node:assert/strict')
const { createMetaEmbeddedSignupClient, MetaSignupError } = require('../lib/metaEmbeddedSignup')

const env = {
  META_APP_ID: '123456',
  META_APP_SECRET: 'app-secret',
  META_ACCESS_TOKEN: 'system-token',
  META_GRAPH_API_VERSION: 'v18.0'
}

function httpFor({ debug, numbers, subscribeSuccess = true }) {
  return {
    async get(url) {
      if (url.includes('debug_token')) return { data: { data: { granular_scopes: debug } } }
      const wabaId = url.match(/v18\.0\/([0-9]+)\/phone_numbers/)[1]
      return { data: { data: numbers[wabaId] || [] } }
    },
    async post() { return { data: { success: subscribeSuccess } } }
  }
}

test('validates a selected number only when it belongs to an authorized WABA', async () => {
  const client = createMetaEmbeddedSignupClient({
    env,
    http: httpFor({
      debug: [{ scope: 'whatsapp_business_management', target_ids: ['100'] }],
      numbers: { 100: [{ id: '200', display_phone_number: '+260 700 000 000', verified_name: 'Example' }] }
    })
  })
  const result = await client.validatePhoneOwnership({ accessToken: 'temporary-token', phoneNumberId: '200' })
  assert.deepEqual(result, {
    wabaId: '100',
    phoneNumberId: '200',
    displayPhoneNumber: '+260 700 000 000',
    displayName: 'Example',
    qualityRating: null,
    verificationStatus: null
  })
})

test('rejects a phone number that Meta cannot prove belongs to the authorized WABA', async () => {
  const client = createMetaEmbeddedSignupClient({
    env,
    http: httpFor({
      debug: [{ scope: 'whatsapp_business_management', target_ids: ['100'] }],
      numbers: { 100: [{ id: '999', display_phone_number: '+260 700 000 999' }] }
    })
  })
  await assert.rejects(() => client.validatePhoneOwnership({ accessToken: 'temporary-token', phoneNumberId: '200' }), MetaSignupError)
})

test('rejects an invalid Meta access grant with no WhatsApp Business Account scope', async () => {
  const client = createMetaEmbeddedSignupClient({ env, http: httpFor({ debug: [], numbers: {} }) })
  await assert.rejects(() => client.validatePhoneOwnership({ accessToken: 'temporary-token', phoneNumberId: '200' }), MetaSignupError)
})

test('requires Meta webhook subscription confirmation before a connection can succeed', async () => {
  const client = createMetaEmbeddedSignupClient({
    env,
    http: httpFor({ debug: [], numbers: {}, subscribeSuccess: false })
  })
  await assert.rejects(() => client.subscribeApp('100'), MetaSignupError)
})


test('emits stage diagnostics without access tokens or raw Meta responses', async () => {
  const diagnostics = []
  const client = createMetaEmbeddedSignupClient({
    env,
    diagnostic: (record) => diagnostics.push(record),
    http: {
      async get(url) {
        if (url.includes('oauth/access_token')) return { data: { access_token: 'temporary-token-not-for-logs' } }
        if (url.includes('debug_token')) {
          return { data: { data: { granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['100'] }] } } }
        }
        return { data: { data: [{ id: '200', display_phone_number: '+260 700 000 000' }] } }
      },
      async post() { return { data: { success: true } } }
    }
  })

  const token = await client.exchangeCode('authorization-code-not-for-logs')
  const connection = await client.validatePhoneOwnership({ accessToken: token, phoneNumberId: '200' })
  await client.subscribeApp(connection.wabaId)

  assert.deepEqual(diagnostics.map((record) => [record.stage, record.success]), [
    ['code_exchange', true],
    ['token_waba_authorization', true],
    ['phone_ownership_lookup', true],
    ['phone_metadata', true],
    ['waba_subscription', true]
  ])
  assert.equal(JSON.stringify(diagnostics).includes('temporary-token-not-for-logs'), false)
  assert.equal(JSON.stringify(diagnostics).includes('authorization-code-not-for-logs'), false)
})

test('classifies Meta API failures separately from ZedPing validation failures', async () => {
  const diagnostics = []
  const client = createMetaEmbeddedSignupClient({
    env,
    diagnostic: (record) => diagnostics.push(record),
    http: {
      async get() {
        const error = new Error('request failed')
        error.response = { status: 400, data: { error: { code: 190, type: 'OAuthException', message: 'Invalid OAuth access token.' } } }
        throw error
      }
    }
  })

  await assert.rejects(() => client.exchangeCode('authorization-code-not-for-logs'))
  assert.deepEqual(diagnostics[0], {
    event: 'embedded_signup_diagnostic',
    stage: 'code_exchange',
    success: false,
    source: 'meta_api',
    http_status: 400,
    meta_error_code: 190,
    meta_error_type: 'OAuthException',
    meta_error_message: 'Invalid OAuth access token.'
  })
})


test('emits aggregate ownership diagnostics without identifiers, numbers, tokens, or payloads', async () => {
  const diagnostics = []
  const client = createMetaEmbeddedSignupClient({
    env,
    diagnostic: (record) => diagnostics.push(record),
    http: {
      async get(url) {
        if (url.includes('debug_token')) {
          return {
            data: {
              data: {
                granular_scopes: [{
                  scope: 'whatsapp_business_management',
                  target_ids: ['993311773355', '884422119977']
                }]
              }
            }
          }
        }
        if (url.includes('993311773355/phone_numbers')) {
          return {
            data: {
              data: [{ id: '771199335577', display_phone_number: '+260700111222', code_verification_status: 'VERIFIED' }]
            }
          }
        }
        return { data: { data: [{ id: '663388994411', display_phone_number: '+260700333444' }] } }
      }
    }
  })

  await assert.rejects(
    () => client.validatePhoneOwnership({ accessToken: 'temporary-access-token-should-never-appear', phoneNumberId: '555500001111' }),
    MetaSignupError
  )

  const record = diagnostics.at(-1)
  assert.equal(record.stage, 'phone_ownership_lookup')
  assert.equal(record.success, false)
  assert.equal(record.authorized_waba_count, 2)
  assert.equal(record.wabas_phone_listed_count, 2)
  assert.equal(record.total_phone_records_returned, 2)
  assert.equal(record.ownership_match_count, 0)
  assert.equal(record.selected_phone_found, false)
  assert.equal(record.selected_phone_found_in_multiple_wabas, false)
  assert.equal(record.phone_list_api_failures_count, 0)
  assert.equal(record.selected_phone_has_display_number, false)
  assert.equal(record.selected_phone_code_verification_status, null)

  const output = JSON.stringify(diagnostics)
  for (const sensitiveValue of [
    '993311773355',
    '884422119977',
    '771199335577',
    '663388994411',
    '+260700111222',
    '+260700333444',
    'temporary-access-token-should-never-appear',
    '555500001111'
  ]) assert.equal(output.includes(sensitiveValue), false)
})


test('ownership lookup redacts identifier-like Meta errors and records only aggregate failure metrics', async () => {
  const diagnostics = []
  const client = createMetaEmbeddedSignupClient({
    env,
    diagnostic: (record) => diagnostics.push(record),
    http: {
      async get(url) {
        if (url.includes('debug_token')) {
          return { data: { data: { granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['993311773355'] }] } } }
        }
        const error = new Error('request failed')
        error.response = {
          status: 400,
          data: { error: { code: 100, type: 'OAuthException', message: 'Phone 771199335577 and +260700111222 are unavailable' } }
        }
        throw error
      }
    }
  })

  await assert.rejects(
    () => client.validatePhoneOwnership({ accessToken: 'temporary-access-token-should-never-appear', phoneNumberId: '555500001111' })
  )

  const record = diagnostics.at(-1)
  assert.equal(record.stage, 'phone_ownership_lookup')
  assert.equal(record.success, false)
  assert.equal(record.source, 'meta_api')
  assert.equal(record.authorized_waba_count, 1)
  assert.equal(record.wabas_phone_listed_count, 0)
  assert.equal(record.total_phone_records_returned, 0)
  assert.equal(record.ownership_match_count, 0)
  assert.equal(record.phone_list_api_failures_count, 1)
  assert.equal(record.selected_phone_found, false)
  assert.equal(record.selected_phone_found_in_multiple_wabas, false)
  assert.equal(record.selected_phone_has_display_number, false)
  assert.equal(record.selected_phone_code_verification_status, null)

  const output = JSON.stringify(record)
  for (const sensitiveValue of ['993311773355', '771199335577', '+260700111222', 'temporary-access-token-should-never-appear', '555500001111']) {
    assert.equal(output.includes(sensitiveValue), false)
  }
})


function transactionDiagnosticClient({ finishWabaId, phoneLists }) {
  const diagnostics = []
  const client = createMetaEmbeddedSignupClient({
    env,
    diagnostic: (record) => diagnostics.push(record),
    http: {
      async get(url) {
        if (url.includes('debug_token')) {
          return {
            data: {
              data: {
                granular_scopes: [{
                  scope: 'whatsapp_business_management',
                  target_ids: ['993311773355', '884422119977']
                }]
              }
            }
          }
        }
        const wabaId = url.match(/v18\\.0\\/([0-9]+)\\/phone_numbers/)[1]
        return { data: { data: phoneLists[wabaId] || [] } }
      }
    }
  })
  return { client, diagnostics, finishWabaId }
}

async function ownershipDiagnostic({ finishWabaId, phoneLists }) {
  const { client, diagnostics } = transactionDiagnosticClient({ finishWabaId, phoneLists })
  try {
    await client.validatePhoneOwnership({
      accessToken: 'temporary-access-token-should-never-appear',
      phoneNumberId: '555500001111',
      finishWabaId
    })
  } catch {}
  return diagnostics.find((record) => record.stage === 'phone_ownership_lookup')
}

test('records an absent FINISH WABA claim without identifiers', async () => {
  const record = await ownershipDiagnostic({
    phoneLists: {
      993311773355: [{ id: '555500001111', display_phone_number: '+260700111222' }],
      884422119977: [{ id: '555500001111', display_phone_number: '+260700111222' }]
    }
  })
  assert.equal(record.finish_waba_present, false)
  assert.equal(record.finish_waba_is_authorized_candidate, false)
  assert.equal(record.finish_waba_lists_selected_phone, false)
  assert.equal(record.selected_phone_authorized_waba_match_count, 2)
  assert.equal(record.finish_waba_disambiguates_multiple_matches, false)
})

test('records an unauthorized FINISH WABA claim without trusting it', async () => {
  const record = await ownershipDiagnostic({
    finishWabaId: '667788990011',
    phoneLists: {
      993311773355: [{ id: '555500001111', display_phone_number: '+260700111222' }],
      884422119977: [{ id: '555500001111', display_phone_number: '+260700111222' }]
    }
  })
  assert.equal(record.finish_waba_present, true)
  assert.equal(record.finish_waba_is_authorized_candidate, false)
  assert.equal(record.finish_waba_lists_selected_phone, false)
  assert.equal(record.finish_waba_disambiguates_multiple_matches, false)
})

test('records an authorized FINISH WABA that does not list the selected phone', async () => {
  const record = await ownershipDiagnostic({
    finishWabaId: '993311773355',
    phoneLists: {
      993311773355: [{ id: '111122223333', display_phone_number: '+260700333444' }],
      884422119977: [{ id: '555500001111', display_phone_number: '+260700111222' }]
    }
  })
  assert.equal(record.finish_waba_present, true)
  assert.equal(record.finish_waba_is_authorized_candidate, true)
  assert.equal(record.finish_waba_lists_selected_phone, false)
  assert.equal(record.selected_phone_authorized_waba_match_count, 1)
  assert.equal(record.finish_waba_disambiguates_multiple_matches, false)
})

test('records a FINISH WABA that selects one of multiple authorized phone matches without bypassing validation', async () => {
  const record = await ownershipDiagnostic({
    finishWabaId: '993311773355',
    phoneLists: {
      993311773355: [{ id: '555500001111', display_phone_number: '+260700111222' }],
      884422119977: [{ id: '555500001111', display_phone_number: '+260700111222' }]
    }
  })
  assert.equal(record.finish_waba_present, true)
  assert.equal(record.finish_waba_is_authorized_candidate, true)
  assert.equal(record.finish_waba_lists_selected_phone, true)
  assert.equal(record.selected_phone_authorized_waba_match_count, 2)
  assert.equal(record.finish_waba_disambiguates_multiple_matches, true)
  const output = JSON.stringify(record)
  for (const sensitiveValue of ['993311773355', '884422119977', '555500001111', '+260700111222', 'temporary-access-token-should-never-appear']) {
    assert.equal(output.includes(sensitiveValue), false)
  }
})
