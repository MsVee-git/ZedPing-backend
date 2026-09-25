const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function inbox() {
  const routes = new Map(), queries = []
  const rows = [
    { id: 'out', customer_id: 'a', control_mode: 'automation', status: 'open', contacts: { id: 'contact-a', marketing_opted_out: true } },
    { id: 'in', customer_id: 'a', control_mode: 'human', status: 'open', contacts: { id: 'contact-b', marketing_opted_out: false } },
    { id: 'foreign', customer_id: 'b', contacts: { id: 'contact-c', marketing_opted_out: true } }
  ]
  const supabase = { from(table) {
    const filters = []; let single = false
    const query = { table, fields: null, filters }
    queries.push(query)
    const q = {
      select(fields) { query.fields = fields; return q },
      eq(field, value) { filters.push([field, value]); return q },
      in() { return q }, order() { return q }, limit() { return q },
      maybeSingle() { single = true; return q },
      then(resolve, reject) {
        const data = table === 'messages' ? [] : rows.filter(row => filters.every(([field, value]) => row[field] === value))
        return Promise.resolve({ data: single ? data[0] || null : structuredClone(data), error: null }).then(resolve, reject)
      }
    }
    return q
  } }
  const router = { get(url, ...handlers) { assert.equal(handlers.length, 1, 'member read must not require admin'); routes.set(url, handlers[0]) }, post() {}, patch() {} }
  const context = { module: { exports: {} }, require(name) {
    if (name === 'express') return { Router: () => router }
    if (name === '../lib/supabase') return supabase
    return {}
  } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../routes/conversations.js'), 'utf8'), context)
  return { queries, async read(url, id, workspace = 'a') {
    const result = { status: 200 }
    const res = { status(code) { result.status = code; return res }, json(body) { result.body = JSON.parse(JSON.stringify(body)); return res } }
    await routes.get(url)({ workspace: { customerId: workspace, role: 'member', userId: 'member-a' }, params: { id }, query: {} }, res)
    return result
  } }
}

test('member Inbox reads expose consent alongside unchanged automation/human state', async () => {
  const api = inbox(), list = await api.read('/')
  assert.equal(list.status, 200)
  assert.equal(list.body.length, 2)
  assert.equal(list.body[0].contacts.marketing_opted_out, true)
  assert.equal(list.body[0].control_mode, 'automation')
  assert.equal(list.body[1].contacts.marketing_opted_out, false)
  assert.equal(list.body[1].control_mode, 'human')
  const detail = await api.read('/:id', 'out')
  assert.equal(detail.body.conversation.contacts.marketing_opted_out, true)
  assert.equal(detail.body.conversation.control_mode, 'automation')
  assert.ok(api.queries.filter(q => q.table === 'conversations').every(q => q.fields.includes('contacts(id,name,phone_number,tag,marketing_opted_out)') && q.filters.some(([field, value]) => field === 'customer_id' && value === 'a')))
})

test('Inbox details refuse another workspace and routes retain membership authorization', async () => {
  assert.equal((await inbox().read('/:id', 'foreign')).status, 404)
  const index = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8')
  assert.match(index, /app.use\('\/conversations', requireWorkspace, conversationRoutes\)/)
  assert.match(index, /app.use\('\/broadcasts', requireWorkspace, broadcastRoutes\)/)
})
