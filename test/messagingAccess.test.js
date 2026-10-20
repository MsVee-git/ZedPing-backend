const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const source = fs.readFileSync(require.resolve('../routes/workspace'), 'utf8')
async function run({ mapped = true, rows = [], error = null } = {}) {
  const routes = {}, filters = []
  const router = { get(path, fn) { routes[path] = fn }, patch() {} }
  const db = { from(table) {
    const result = table === 'gupshup_connection_mappings' ? { data: mapped ? [{ id: 'mapping' }] : [], error } : { data: rows, error }
    const chain = { select() { return this }, eq(key, value) { filters.push([table, key, value]); return this }, lte() { return this }, order() { return Promise.resolve(result) }, limit() { return Promise.resolve(result) } }
    return chain
  } }
  vm.runInNewContext(source, { require(name) {
    if (name === 'express') return { Router: () => router }
    if (name === '../lib/supabase') return db
    return { requireAdmin() {} }
  }, module: { exports: {} }, Date })
  let body, status = 200
  const res = { set() {}, status(code) { status = code; return this }, json(value) { body = value } }
  await routes['/messaging-access']({ workspace: { customerId: 'authorized-workspace' } }, res)
  assert.ok(filters.filter(([,key]) => key === 'customer_id').every(([, ,value]) => value === 'authorized-workspace'))
  return { body, status }
}
const active = { period_start: '2026-01-01T00:00:00.000Z', period_end: '2099-01-01T00:00:00.000Z', allowance: 5000, reserved: 5 }
test('active entitlement returns the server balance', async () => { const { body } = await run({ rows: [active] }); assert.equal(body.state, 'active'); assert.equal(body.remaining, 4995) })
test('expired period requires renewal', async () => { assert.equal((await run({ rows: [{ ...active, period_end: '2020-01-01T00:00:00.000Z' }] })).body.state, 'renewal_required') })
test('exhaustion is distinct from renewal', async () => { assert.equal((await run({ rows: [{ ...active, reserved: 5000 }] })).body.state, 'allowance_exhausted') })
test('no entitlement requires activation', async () => { assert.equal((await run()).body.state, 'activation_required') })
test('direct Meta accounts do not receive Gupshup renewal notice', async () => { assert.equal((await run({ mapped: false })).body.state, 'not_managed') })
test('overlapping active periods fail closed', async () => { assert.equal((await run({ rows: [active, active] })).body.state, 'unavailable') })
test('database failure never reports expiry', async () => { const result = await run({ error: new Error('offline') }); assert.equal(result.status, 503); assert.equal(result.body.state, 'unavailable') })
