const test = require('node:test')
const assert = require('node:assert/strict')
const { createMetaTemplateClient, MetaTemplateError } = require('./metaTemplates')

const env = { META_GRAPH_API_VERSION: 'v25.0', META_ACCESS_TOKEN: 'server-only-token' }

test('lists templates through the configured Meta Graph API version without exposing a WABA input path', async () => {
  const calls = []
  const client = createMetaTemplateClient({
    env,
    http: { get: async (url, config) => { calls.push({ url, config }); return { data: { data: [{ id: '1', name: 'review_demo', status: 'APPROVED', category: 'UTILITY', language: 'en_US', components: [] }] } } } }
  })
  const templates = await client.listTemplates({ wabaId: '2076393569963045' })
  assert.equal(templates.length, 1)
  assert.match(calls[0].url, /\/v25\.0\/2076393569963045\/message_templates$/)
  assert.equal(calls[0].config.params.fields, 'id,name,status,category,language,components')
  assert.equal(calls[0].config.headers.Authorization, 'Bearer server-only-token')
})

test('allows only a fully Meta-returned approved template with no variables', () => {
  const client = createMetaTemplateClient({ env, http: {} })
  assert.equal(client.approvedNoVariableTemplate({ id: '1', name: 'review_demo', status: 'APPROVED', language: 'en_US', components: [{ type: 'BODY', text: 'Welcome' }] }).name, 'review_demo')
  assert.throws(() => client.approvedNoVariableTemplate({ id: '2', name: 'draft', status: 'PENDING', language: 'en_US', components: [] }), MetaTemplateError)
  assert.throws(() => client.approvedNoVariableTemplate({ id: '3', name: 'variable', status: 'APPROVED', language: 'en_US', components: [{ type: 'BODY', text: 'Hello {{1}}' }] }), MetaTemplateError)
})

test('rejects malformed server-side WABA identifiers before Meta is called', async () => {
  const client = createMetaTemplateClient({ env, http: { get: async () => { throw new Error('should not run') } } })
  await assert.rejects(() => client.listTemplates({ wabaId: 'not-a-waba' }), MetaTemplateError)
})

test('builds only safe body components and exact examples for a variable template', () => {
  const client = createMetaTemplateClient({ env, http: {} })
  assert.deepEqual(
    client.buildTemplateSubmission({ name: 'booking_reminder', category: 'UTILITY', language: 'en_US', body: 'Hello {{1}}, your booking is {{2}}.', variable_examples: ['Ada', 'tomorrow'] }),
    { name: 'booking_reminder', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Hello {{1}}, your booking is {{2}}.', example: { body_text: [['Ada', 'tomorrow']] } }] }
  )
  assert.equal(client.buildTemplateSubmission({ name: 'repeat_variable', category: 'UTILITY', language: 'en_US', body: 'Hello {{1}}, we will see {{1}} soon.', variable_examples: ['Ada'] }).components[0].example.body_text[0][0], 'Ada')
  assert.throws(() => client.buildTemplateSubmission({ name: 'Bad Name', category: 'UTILITY', language: 'en_US', body: 'Hello', variable_examples: [] }), MetaTemplateError)
  assert.throws(() => client.buildTemplateSubmission({ name: 'missing_examples', category: 'UTILITY', language: 'en_US', body: 'Hello {{1}}', variable_examples: [] }), MetaTemplateError)
  assert.throws(() => client.buildTemplateSubmission({ name: 'skipped_variable', category: 'MARKETING', language: 'en_US', body: 'Hello {{2}}', variable_examples: ['Ada'] }), MetaTemplateError)
})

test('posts a server-built template to the workspace-resolved WABA through the configured version', async () => {
  const calls = []
  const client = createMetaTemplateClient({
    env,
    http: { post: async (url, body, config) => { calls.push({ url, body, config }); return { data: { id: 'meta-template-1', status: 'PENDING', category: 'UTILITY' } } } }
  })
  const result = await client.createTemplate({ wabaId: '2076393569963045', template: { name: 'booking_reminder', category: 'UTILITY', language: 'en_US', body: 'Your booking is confirmed.', variable_examples: [] } })
  assert.deepEqual(result, { id: 'meta-template-1', status: 'PENDING', category: 'UTILITY' })
  assert.match(calls[0].url, /\/v25\.0\/2076393569963045\/message_templates$/)
  assert.equal(calls[0].config.headers.Authorization, 'Bearer server-only-token')
  assert.deepEqual(calls[0].body.components, [{ type: 'BODY', text: 'Your booking is confirmed.' }])
})

test('returns a safe Meta rejection without credentials', async () => {
  const client = createMetaTemplateClient({
    env,
    http: { post: async () => { const error = new Error('bad request'); error.response = { data: { error: { message: 'Name already exists. Bearer secret-must-not-leak' } } }; throw error } }
  })
  await assert.rejects(
    () => client.createTemplate({ wabaId: '2076393569963045', template: { name: 'booking_reminder', category: 'UTILITY', language: 'en_US', body: 'Hello', variable_examples: [] } }),
    (error) => error instanceof MetaTemplateError && error.kind === 'rejected' && !String(error.detail).includes('secret-must-not-leak')
  )
})

