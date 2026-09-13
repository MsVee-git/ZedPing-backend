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

