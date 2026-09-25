const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { filterWorkspaceMarketingRecipients, isMarketingOptOutCommand } = require('../lib/marketingOptOut')

// Execute the real route functions against an in-memory query adapter. Every
// outbound transport is replaced; these tests cannot contact WhatsApp or a DB.
function database(seed) {
  const tables = structuredClone(seed)
  const calls = []
  let sequence = 0
  const db = { tables, calls, fail: null, from(table) {
    const filters = []
    let operation = 'select', payload, columns = '*', one = false, window, sort
    const q = {
      select(value = '*') { columns = value; return q },
      eq(key, value) { filters.push(row => row[key] === value); return q },
      in(key, values) { filters.push(row => values.includes(row[key])); return q },
      order(key) { sort = key; return q },
      range(start, end) { window = [start, end]; return q },
      limit(value) { window = [0, value - 1]; return q },
      insert(value) { operation = 'insert'; payload = value; return q },
      update(value) { operation = 'update'; payload = value; return q },
      maybeSingle() { one = true; return q },
      single() { one = true; return q },
      then(resolve, reject) {
        try {
          calls.push({ table, operation, payload: structuredClone(payload), columns })
          if (db.fail?.(table, operation, columns)) return Promise.resolve({ data: null, error: new Error('Test database failure') }).then(resolve, reject)
          const rows = tables[table] ||= []
          let selected
          if (operation === 'insert') {
            if (table === 'inbound_webhook_events' && rows.some(row => row.customer_id === payload.customer_id && row.whatsapp_number_id === payload.whatsapp_number_id && row.meta_message_id === payload.meta_message_id)) {
              return Promise.resolve({ data: null, error: { code: '23505' } }).then(resolve, reject)
            }
            const row = { id: `new-${++sequence}`, ...structuredClone(payload) }
            if (table === 'contacts') row.marketing_opted_out ??= false
            rows.push(row)
            selected = [row]
          } else {
            selected = rows.filter(row => filters.every(filter => filter(row)))
            if (sort) selected.sort((a, b) => String(a[sort]).localeCompare(String(b[sort])))
            if (window) selected = selected.slice(window[0], window[1] + 1)
            if (operation === 'update') selected.forEach(row => Object.assign(row, structuredClone(payload)))
          }
          selected = selected.map(row => columns === '*' ? structuredClone(row) : Object.fromEntries(columns.split(',').map(key => [key, row[key]])))
          return Promise.resolve({ data: one ? selected[0] || null : selected, error: null }).then(resolve, reject)
        } catch (error) { return Promise.reject(error).then(resolve, reject) }
      }
    }
    return q
  } }
  return db
}

function loadRoute(file, db) {
  const filename = path.join(__dirname, '..', 'routes', file + '.js')
  const localRequire = createRequire(filename)
  const routes = new Map(), sent = [], routed = []
  const router = { get(url, ...handlers) { routes.set(url, handlers.at(-1)) }, post(url, ...handlers) { routes.set(url, handlers.at(-1)) } }
  const catalog = { kind: 'ok', templates: [{ id: 'template-a', name: 'offer', status: 'APPROVED', category: 'MARKETING', language: 'en', components: [{ type: 'BODY', text: 'Hi {{1}}' }] }] }
  const stubs = {
    express: { Router: () => router },
    '../lib/supabase': db,
    '../middleware/auth': { requireAdmin() {} },
    '../lib/whatsapp': {
      async sendTextMessage(...args) { sent.push({ kind: 'text', args }); return { messages: [{ id: 'mock-outbound' }] } },
      async sendTemplateMessage(...args) { sent.push({ kind: 'template', args }); return { messages: [{ id: 'mock-outbound' }] } }
    },
    '../lib/workspaceTemplates': { async loadWorkspaceTemplates(workspace, number) { assert.equal(workspace, 'a'); assert.equal(number, 'number-a'); return catalog } },
    '../lib/conversationEvents': { async recordConversationEvent() {} },
    '../lib/automationExecution': { async recordAutomationEvent() {} },
    '../lib/chatbotExecution': { async continueFlow() { routed.push('flow'); return false } }
  }
  const real = new Set(['crypto', '../lib/marketingOptOut', '../lib/broadcastRecipients', '../lib/broadcastTemplates', '../lib/metaTemplates', '../lib/contactImport', '../lib/conversationState', '../lib/inboundWebhookEvents'])
  const context = {
    module: { exports: {} }, Buffer, process: { env: {} }, console,
    require(id) { if (id in stubs) return stubs[id]; if (real.has(id)) return localRequire(id); throw new Error(`Unexpected dependency ${id}`) },
    routed
  }
  // Unused Zoe imports are inert. Calls from processMessage are instrumented
  // below, preserving the real inbound persistence and opt-out interception.
  if (file === 'webhook') {
    for (const id of ['openai', 'aiRuntime', 'aiExecutionEvents', 'aiAgentSessions', 'automationRuntime', 'aiAgentSelection', 'zoeGrounding', 'aiDeploymentMode']) stubs['../lib/' + id] = {}
  }
  let source = fs.readFileSync(filename, 'utf8')
  if (file === 'webhook') source += `\ncheckAISession = async () => { routed.push('ai'); return false }; startLiveZoeSession = async () => { routed.push('zoe'); return false }; checkAutomations = async () => { routed.push('automation') }; module.exports.processMessage = processMessage;`
  vm.runInNewContext(source, context, { filename })
  return { routes, sent, routed, processMessage: context.module.exports.processMessage }
}

const contact = (id, phone, out = false, workspace = 'a', name = 'Customer') => ({ id, customer_id: workspace, phone_number: phone, phone_e164: phone, name, marketing_opted_out: out })
function fixture(contacts = [contact('eligible', '+260971000001'), contact('out', '+260971000002', true)]) {
  return database({
    contacts,
    whatsapp_numbers: [{ id: 'number-a', customer_id: 'a', phone_number_id: 'meta-a', phone_number: '+260971999999', display_name: 'Test business', status: 'connected', access_token: 'fake' }],
    contact_groups: [{ id: 'group-a', customer_id: 'a', name: 'Customers' }, { id: 'group-b', customer_id: 'b', name: 'Other workspace' }],
    contact_group_members: contacts.map(row => ({ group_id: 'group-a', contact_id: row.id })),
    conversations: []
  })
}
const selection = { whatsapp_number_id: 'number-a', contact_group_id: 'group-a', template_id: 'template-a', variable_mappings: { 1: { source: 'contact_name' } } }
async function request(route, url, body = selection, workspace = 'a') {
  const result = { status: 200 }
  const response = { status(code) { result.status = code; return response }, json(value) { result.body = JSON.parse(JSON.stringify(value)); return response } }
  await route.routes.get(url)({ workspace: { customerId: workspace }, body }, response)
  return result
}
const inbound = (text, id = 'inbound-1', workspace = 'a') => ({ customerId: workspace, number: { id: 'number-a', phone_number_id: 'meta-a', phone_number: '+260971999999', display_name: 'Test business', access_token: 'fake' }, from: '+260971000001', body: text, metaId: id })

test('all six commands are standalone, case-insensitive, and reject sentences and punctuation', () => {
  for (const command of ['STOP', 'STOP ALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']) {
    assert.equal(isMarketingOptOutCommand('  ' + command.toLowerCase() + '  '), true)
    assert.equal(isMarketingOptOutCommand(command + ' please'), false)
    assert.equal(isMarketingOptOutCommand(command + '!'), false)
  }
  assert.equal(isMarketingOptOutCommand('stop\t all'), true)
  for (const value of ['', null, 'stopping', 'Please stop sending', 'Do not unsubscribe me']) assert.equal(isMarketingOptOutCommand(value), false)
})

test('STOP persists inbound, retains contact/group membership, and intercepts every runtime', async () => {
  const db = fixture(), route = loadRoute('webhook', db)
  const membership = structuredClone(db.tables.contact_group_members)
  await route.processMessage(inbound('STOP'))
  assert.equal(db.tables.contacts.length, 2)
  assert.equal(db.tables.contacts[0].marketing_opted_out, true)
  assert.equal(db.tables.contacts[0].marketing_opt_out_source, 'whatsapp_stop')
  assert.ok(Date.parse(db.tables.contacts[0].marketing_opted_out_at))
  assert.deepEqual(db.tables.contact_group_members, membership)
  assert.deepEqual(route.routed, [])
  assert.equal(route.sent.length, 1)
  assert.match(route.sent[0].args[2], /unsubscribed.*Test business/)
  const persistence = db.calls.findIndex(call => call.table === 'messages' && call.payload?.direction === 'inbound')
  const optout = db.calls.findIndex(call => call.table === 'contacts' && call.operation === 'update')
  assert.ok(persistence >= 0 && persistence < optout)
})

test('duplicate webhook identity and repeated STOP commands produce one confirmation', async () => {
  const db = fixture(), route = loadRoute('webhook', db)
  await route.processMessage(inbound('STOP'))
  const timestamp = db.tables.contacts[0].marketing_opted_out_at
  await route.processMessage(inbound('STOP'))
  await route.processMessage(inbound('STOP ALL', 'inbound-2'))
  assert.equal(route.sent.length, 1)
  assert.equal(db.tables.messages.filter(row => row.direction === 'inbound').length, 2)
  assert.equal(db.tables.contacts[0].marketing_opted_out_at, timestamp)
  assert.deepEqual(route.routed, [])
})

test('concurrent distinct STOP events claim the contact transition only once', async () => {
  const db = fixture(), route = loadRoute('webhook', db)
  await Promise.all([route.processMessage(inbound('STOP', 'one')), route.processMessage(inbound('QUIT', 'two'))])
  assert.equal(route.sent.length, 1)
  assert.deepEqual(route.routed, [])
})

test('later support from an opted-out contact still traverses current routing', async () => {
  const db = fixture(), route = loadRoute('webhook', db)
  await route.processMessage(inbound('STOP'))
  await route.processMessage(inbound('Can you help with my booking?', 'support'))
  assert.deepEqual(route.routed, ['ai', 'zoe', 'flow', 'automation'])
  assert.equal(db.tables.contacts[0].marketing_opted_out, true)
})

test('STOP remains workspace scoped even for the same phone in another workspace', async () => {
  const db = fixture([contact('a-contact', '+260971000001'), contact('b-contact', '+260971000001', false, 'b')])
  await loadRoute('webhook', db).processMessage(inbound('STOP'))
  assert.equal(db.tables.contacts[0].marketing_opted_out, true)
  assert.equal(db.tables.contacts[1].marketing_opted_out, false)
})

test('STOP is honored under human control while later support remains suppressed from automation', async () => {
  const db = fixture()
  db.tables.conversations.push({ id: 'conversation', customer_id: 'a', whatsapp_number_id: 'number-a', contact_id: 'eligible', status: 'open', control_mode: 'human', unread_count: 0 })
  const route = loadRoute('webhook', db)
  await route.processMessage(inbound('STOP'))
  await route.processMessage(inbound('Support please', 'support'))
  assert.equal(route.sent.length, 1)
  assert.deepEqual(route.routed, [])
  assert.equal(db.tables.conversations[0].control_mode, 'human')
})

test('failed opt-out persistence sends no confirmation and never falls into automation', async () => {
  const db = fixture(), route = loadRoute('webhook', db)
  db.fail = (table, operation) => table === 'contacts' && operation === 'update'
  await assert.rejects(route.processMessage(inbound('STOP')), /Test database failure/)
  assert.equal(route.sent.length, 0)
  assert.deepEqual(route.routed, [])
})

test('review reports suppressed and unresolved contacts separately without sending', async () => {
  const db = fixture([contact('eligible', '+260971000001'), contact('out', '+260971000002', true, 'a', ''), contact('invalid', '+260971000003', false, 'a', '')])
  const route = loadRoute('broadcasts', db)
  const result = await request(route, '/review-template')
  assert.equal(result.status, 200)
  assert.equal(result.body.total_selected, 3)
  assert.equal(result.body.eligible_recipients, 1)
  assert.equal(result.body.opted_out_recipients, 1)
  assert.equal(result.body.skipped_recipients, 1)
  assert.equal(route.sent.length, 0)
  assert.equal(result.body.sending_number.display_phone_number, '+260 971 999 999')
  assert.equal('phone_number_id' in result.body.sending_number, false)
})

test('send reloads suppression after review and ignores forged frontend recipients and counts', async () => {
  const db = fixture([contact('eligible', '+260971000001'), contact('later-out', '+260971000002')])
  const route = loadRoute('broadcasts', db)
  assert.equal((await request(route, '/review-template')).body.eligible_recipients, 2)
  db.tables.contacts[1].marketing_opted_out = true
  const result = await request(route, '/send-template', { ...selection, contacts: [db.tables.contacts[1]], eligible_recipients: 999, opted_out_recipients: 0 })
  assert.equal(result.status, 200)
  assert.equal(result.body.accepted, 1)
  assert.equal(result.body.opted_out_recipients, 1)
  assert.equal(route.sent.length, 1)
  assert.equal(route.sent[0].args[1], '+260971000001')
  assert.equal(db.tables.scheduled_broadcasts[0].contacts.length, 1)
})

test('all opted out fails final send without an activity or transport call', async () => {
  const db = fixture([contact('out', '+260971000001', true)]), route = loadRoute('broadcasts', db)
  const result = await request(route, '/send-template')
  assert.equal(result.status, 400)
  assert.equal(route.sent.length, 0)
  assert.equal(db.tables.scheduled_broadcasts, undefined)
})

test('group and connection selectors cannot cross workspace boundaries', async () => {
  const route = loadRoute('broadcasts', fixture())
  assert.equal((await request(route, '/review-template', { ...selection, contact_group_id: 'group-b' })).status, 403)
  assert.equal((await request(route, '/send-template', selection, 'b')).status, 404)
  assert.equal(route.sent.length, 0)
})

test('manual endpoint suppresses saved IDs and equivalent phone-only recipients despite forged flags', async () => {
  for (const recipient of [{ id: 'out', marketing_opted_out: false }, { phone_number: '0971000002', marketing_opted_out: false }, { phone_number: '+260 971 000 002' }]) {
    const db = fixture(), route = loadRoute('broadcasts', db)
    const result = await request(route, '/send', { phoneNumberId: 'number-a', message: 'Promotion', contacts: [recipient, { id: 'eligible' }] })
    assert.equal(result.status, 200)
    assert.equal(result.body.opted_out_recipients, 1)
    assert.equal(route.sent.length, 1)
    assert.equal(route.sent[0].args[1], '+260971000001')
  }
})

test('manual endpoint rejects a foreign contact ID and does not inherit another workspace opt-out', async () => {
  const db = fixture([contact('foreign', '+260971000005', true, 'b')]), route = loadRoute('broadcasts', db)
  assert.equal((await request(route, '/send', { phoneNumberId: 'number-a', message: 'Promotion', contacts: [{ id: 'foreign' }] })).status, 403)
  const result = await request(route, '/send', { phoneNumberId: 'number-a', message: 'Promotion', contacts: [{ phone_number: '+260971000005' }] })
  assert.equal(result.body.accepted, 1)
  assert.equal(result.body.opted_out_recipients, 0)
})

test('suppression lookup errors fail closed at review and both send endpoints', async () => {
  const db = fixture(), route = loadRoute('broadcasts', db)
  db.fail = (table, operation, columns) => table === 'contacts' && columns === 'phone_number,phone_e164'
  for (const url of ['/review-template', '/send-template', '/send']) {
    const body = url === '/send' ? { phoneNumberId: 'number-a', message: 'Promotion', contacts: [{ phone_number: '0971000001' }] } : selection
    assert.equal((await request(route, url, body)).status, 502)
  }
  assert.equal(route.sent.length, 0)
})

test('suppression is paginated and matches duplicate saved contacts by canonical phone', async () => {
  const contacts = Array.from({ length: 501 }, (_, index) => contact(String(index).padStart(4, '0'), '+26097' + String(index).padStart(7, '0'), true))
  const db = fixture(contacts)
  const result = await filterWorkspaceMarketingRecipients(db, 'a', [{ id: 'duplicate', phone_number: contacts[500].phone_number, marketing_opted_out: false }])
  assert.equal(result.eligible.length, 0)
  assert.equal(result.optedOut.length, 1)
  assert.equal(db.calls.length, 2)
})

test('five selected with one opted out reviews as 5/4/1 and exposes only suppressed contact identity', async () => {
  const contacts = Array.from({ length: 5 }, (_, i) => contact('contact-' + i, '+26097100000' + i, i === 4))
  const db = fixture(contacts), route = loadRoute('broadcasts', db)
  const review = await request(route, '/review-template')
  assert.equal(review.body.total_selected, 5)
  assert.equal(review.body.eligible_recipients, 4)
  assert.equal(review.body.opted_out_recipients, 1)
  assert.equal(review.body.skipped_recipients, 0)
  assert.deepEqual(review.body.suppressed, [{ id: 'contact-4', name: 'Customer', phone_number: '+260971000004' }])
  assert.equal(route.sent.length, 0)
  const sent = await request(route, '/send-template')
  assert.equal(sent.body.accepted, 4)
  assert.ok(route.sent.every(call => call.args[1] !== '+260971000004'))
})

test('broadcast details report persisted history without consulting current consent or exposing Meta IDs', async () => {
  const db = fixture()
  db.tables.scheduled_broadcasts = [{ id: 'history', customer_id: 'a', broadcast_name: 'lead_followup', message: '[Template] lead_followup (en_US)', contacts: Array.from({ length: 5 }, (_, id) => ({ id })), status: 'completed', sent_count: 5, failed_count: 0, phone_number_id: 'internal-meta-id' }]
  const route = loadRoute('broadcasts', db)
  const read = async workspace => {
    const result = { status: 200 }
    const res = { status(code) { result.status = code; return res }, json(body) { result.body = JSON.parse(JSON.stringify(body)) } }
    await route.routes.get('/scheduled/:id')({ workspace: { customerId: workspace }, params: { id: 'history' } }, res)
    return result
  }
  const original = structuredClone(db.tables.scheduled_broadcasts)
  const result = await read('a')
  assert.equal(result.status, 200)
  assert.equal(result.body.recorded_recipients, 5)
  assert.equal(result.body.sent_count, 5)
  assert.equal(result.body.failed_count, 0)
  assert.equal('contacts' in result.body, false)
  assert.equal('phone_number_id' in result.body, false)
  assert.equal('opted_out_recipients' in result.body, false)
  db.tables.contacts.forEach(row => { row.marketing_opted_out = true })
  assert.deepEqual((await read('a')).body, result.body)
  assert.equal((await read('b')).status, 404)
  assert.deepEqual(db.tables.scheduled_broadcasts, original)
  assert.ok(db.calls.every(call => call.table === 'scheduled_broadcasts' && call.operation === 'select'))
})
