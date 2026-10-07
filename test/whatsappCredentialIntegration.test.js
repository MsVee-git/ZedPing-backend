const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const axios = require('axios')
const whatsapp = require('../lib/whatsapp')
const { createMetaTemplateClient } = require('../lib/metaTemplates')
const { resolveWhatsAppAccessToken } = require('../lib/whatsappCredentials')

const customer = '11111111-1111-4111-8111-111111111111'
const number = { id: 'number-row', customer_id: customer, phone_number_id: '123456789', whatsapp_business_account_id: '987654321', provisioning_state: 'operational', access_token: null, status: 'connected' }
function resolver(token = 'client-signup-token') {
  return (n, options = {}) => resolveWhatsAppAccessToken(n, { ...options, vault: { get: async () => token }, env: { META_ACCESS_TOKEN: 'shared-bot-token' } })
}
function database(row = number) {
  const writes = []
  return { writes, from(table) {
    const filters = {}
    const query = { select() { return query }, eq(k, v) { filters[k] = v; return query },
      insert(value) { writes.push({ table, value }); return query },
      async single() { return { data: { id: 'saved-message' }, error: null } },
      async maybeSingle() { return { data: Object.entries(filters).every(([k, v]) => row[k] === v) ? row : null, error: null } },
      then(resolve, reject) { return Promise.resolve({ data: [row], error: null }).then(resolve, reject) }
    }
    return query
  } }
}
function moduleWith(pathname, overrides) {
  const routes = {}
  const router = { get() {}, post(p, ...handlers) { routes[p] = handlers.at(-1) } }
  const sandbox = { module: { exports: {} }, require: name => {
    if (Object.hasOwn(overrides, name)) return overrides[name]
    if (name === 'express') return { Router: () => router }
    throw new Error(`Unexpected dependency ${name}`)
  } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', pathname), 'utf8'), sandbox, { filename: pathname })
  return { exported: sandbox.module.exports, routes }
}
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this }, json(body) { this.body = body; return this } }
}

// Execute the production outgoing function used by keyword, flow and AI replies.
function botOutgoing(db, tokenResolver) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhook.js'), 'utf8')
  const code = source.slice(source.indexOf('async function outgoing('), source.indexOf('async function workspaceAutomationSettings('))
  const sandbox = { supabase: db, sendTextMessage: whatsapp.sendTextMessage, resolveWhatsAppAccessToken: tokenResolver }
  vm.runInNewContext(code + '\nthis.outgoing = outgoing', sandbox)
  return sandbox.outgoing
}

test('bot replies send with the signup credential and record the accepted message', async () => {
  const original = axios.post
  const calls = []
  const db = database()
  axios.post = async (url, body, config) => { calls.push({ url, body, config }); return { data: { messages: [{ id: 'accepted-id' }] } } }
  try {
    await botOutgoing(db, resolver())({ number, customerId: customer, from: '260700000000' }, 'Hello')
    assert.equal(calls[0].config.headers.Authorization, 'Bearer client-signup-token')
    assert.match(calls[0].url, /123456789\/messages$/)
    assert.equal(db.writes[0].value.customer_id, customer)
    assert.equal(db.writes[0].value.meta_message_id, 'accepted-id')
  } finally { axios.post = original }
})

test('bot replies cannot send or persist when the signup credential is missing', async () => {
  const original = axios.post
  let calls = 0
  const db = database()
  axios.post = async () => { calls++ }
  try {
    await assert.rejects(botOutgoing(db, resolver(null))({ number, customerId: customer, from: '260700000000' }, 'Hello'))
    assert.equal(calls, 0)
    assert.equal(db.writes.length, 0)
  } finally { axios.post = original }
})

test('direct messaging route uses client credentials and returns no token', async () => {
  const db = database()
  const sends = []
  const { routes } = moduleWith('routes/messages.js', {
    '../lib/supabase': db,
    '../lib/whatsappCredentials': { resolveWhatsAppAccessToken: resolver() },
    '../lib/whatsapp': { sendTextMessage: async (...args) => { sends.push(args); return { messages: [{ id: 'accepted-id' }] } } }
  })
  const res = response()
  await routes['/send']({ workspace: { customerId: customer }, body: { to: '260700000000', message: 'Hello', phoneNumberId: number.id } }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(sends[0][3], 'client-signup-token')
  assert.ok(!JSON.stringify(res.body).includes('client-signup-token'))
  const wrongWorkspace = response()
  await routes['/send']({ workspace: { customerId: 'other-workspace' }, body: { to: '260700000000', message: 'Hello', phoneNumberId: number.id } }, wrongWorkspace)
  assert.equal(wrongWorkspace.statusCode, 404)
  assert.equal(sends.length, 1)
})

test('template catalog uses the client token in its Graph request, not the shared bot', async () => {
  const calls = []
  const client = createMetaTemplateClient({ env: { META_GRAPH_API_VERSION: 'v25.0', META_ACCESS_TOKEN: 'shared-bot-token' }, http: { get: async (url, config) => { calls.push({ url, config }); return { data: { data: [] } } } } })
  const { exported } = moduleWith('lib/workspaceTemplates.js', {
    './supabase': database(), './whatsappCredentials': { resolveWhatsAppAccessToken: resolver() },
    './metaTemplates': { createMetaTemplateClient: () => client }
  })
  const result = await exported.loadWorkspaceTemplates(customer, number.id)
  assert.equal(result.kind, 'ok')
  assert.equal(calls[0].config.headers.Authorization, 'Bearer client-signup-token')
  assert.match(calls[0].url, /987654321\/message_templates$/)
})

test('template catalog stops before Meta when a signup credential is missing', async () => {
  let calls = 0
  const { exported } = moduleWith('lib/workspaceTemplates.js', {
    './supabase': database(), './whatsappCredentials': { resolveWhatsAppAccessToken: resolver(null) },
    './metaTemplates': { createMetaTemplateClient: () => ({ listTemplates: async () => { calls++ } }) }
  })
  await assert.rejects(exported.loadWorkspaceTemplates(customer, number.id))
  assert.equal(calls, 0)
})

for (const mode of ['plain', 'template']) {
  for (const missing of [false, true]) {
    test(`${mode} broadcast ${missing ? 'blocks missing credentials before creating an activity' : 'resolves the client credential once for all recipients'}`, async () => {
      const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'broadcasts.js'), 'utf8')
      const marker = mode === 'plain' ? "router.post('/send'," : "router.post('/send-template',"
      const end = mode === 'plain' ? "router.get('/scheduled'" : "router.post('/send',"
      const writes = [], sends = []
      let lookups = 0, handler
      const recipients = [{ phone_number: '260700000000' }, { phone_number: '260700000001' }]
      const db = { from(table) {
        const q = { insert(value) { writes.push({ table, value }); return q }, select() { return q }, single: async () => ({ data: { id: 'activity' }, error: null }), update() { return q }, eq() { return q }, then(resolve, reject) { return Promise.resolve({ error: null }).then(resolve, reject) } }
        return q
      } }
      const sandbox = {
        router: { post(_p, _auth, fn) { handler = fn } }, requireAdmin: () => {}, supabase: db,
        numberFor: async () => number,
        recipientsForWorkspace: async () => ({ recipients }),
        filterWorkspaceMarketingRecipients: async () => ({ eligible: recipients, optedOut: [] }),
        templateReview: async () => ({ number, template: { name: 'welcome', language: 'en' }, eligible_recipients: 2, recipients, opted_out_recipients: 0 }),
        renderedTemplatePreview: () => 'Welcome',
        resolveWhatsAppAccessToken: async (...args) => { lookups++; return resolver(missing ? null : 'client-signup-token')(...args) },
        sendTextMessage: async (...args) => { sends.push(args); return {} },
        sendTemplateMessage: async (...args) => { sends.push(args); return {} },
        fail: (res) => res.status(502).json({ error: 'unavailable' })
      }
      vm.runInNewContext(source.slice(source.indexOf(marker), source.indexOf(end)), sandbox)
      const res = response()
      await handler({ workspace: { customerId: customer }, body: { contacts: recipients, message: 'Hello', phoneNumberId: number.id } }, res)
      assert.equal(lookups, 1)
      if (missing) {
        assert.equal(res.statusCode, 502)
        assert.equal(writes.length, 0)
        assert.equal(sends.length, 0)
      } else {
        assert.equal(res.statusCode, 200)
        assert.equal(sends.length, 2)
        assert.ok(sends.every(args => args[3] === 'client-signup-token'))
        assert.ok(!JSON.stringify({ response: res.body, writes }).includes('client-signup-token'))
      }
    })
  }
}
