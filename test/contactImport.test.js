const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizePhone, buildImportPlan } = require('../lib/contactImport')

const base = (rows, existingContacts = []) => buildImportPlan({
  headers: ['phone', 'name', 'email'],
  rows,
  mapping: { phone: 0, name: 1, email: 2 },
  existingContacts,
  country: 'ZM'
})

test('accepts a phone-only CSV row and Zambia local forms', () => {
  for (const phone of ['0978748066', '978748066', '260978748066', '+260978748066', '097 874 8066', '0978-748-066', '+260 978 748 066']) {
    assert.equal(normalizePhone(phone), '+260978748066')
  }
  const plan = buildImportPlan({ headers: ['phone'], rows: [['0977123456']], mapping: { phone: 0 }, existingContacts: [] })
  assert.equal(plan.summary.new_contacts, 1)
  assert.equal(plan.entries[0].name, '')
})

test('accepts safely represented numeric spreadsheet cells but rejects scientific or precision-damaged values', () => {
  assert.equal(normalizePhone(978748066), '+260978748066')
  assert.equal(normalizePhone(260978748066), '+260978748066')
  assert.throws(() => normalizePhone('2.60978748066E+11'), /safely interpret/)
  assert.throws(() => normalizePhone(Number.MAX_SAFE_INTEGER + 1), /safely interpret/)
})

test('preserves valid international E.164 and accepts blank names', () => {
  const plan = base([['+447700900123', '', '']])
  assert.equal(plan.entries[0].phone_e164, '+447700900123')
  assert.equal(plan.entries[0].name, '')
})

test('rejects invalid phones and invalid email without discarding a later valid correction', () => {
  const plan = base([['not-a-phone', '', ''], ['0977123456', '', 'bad-email'], ['0977123456', '', '']])
  assert.equal(plan.entries.length, 1)
  assert.equal(plan.summary.invalid_rows, 2)
  assert.equal(plan.summary.duplicate_rows, 0)
  assert.equal(plan.summary.skipped_rows, 2)
  assert.equal(plan.preview[2].status, 'ready')
})

test('review entries retain original and canonical values with distinct ready and existing states', () => {
  const plan = base([['0978748066', '', ''], ['978748066', '', '']], [{ id: 'existing', phone_e164: '+260978748066' }])
  assert.equal(plan.preview[0].original_phone, '0978748066')
  assert.equal(plan.preview[0].zedping_number, '+260978748066')
  assert.equal(plan.preview[0].status, 'existing')
  assert.equal(plan.preview[1].status, 'duplicate')
})

test('recognises same-workspace existing contacts and never overwrites non-empty data in plan', () => {
  const plan = base([['0977123456', 'Imported name', 'new@example.com']], [{
    id: '11111111-1111-1111-1111-111111111111',
    phone_number: '260977123456',
    name: 'Existing name',
    email: 'existing@example.com'
  }])
  assert.equal(plan.summary.existing_contacts, 1)
  assert.equal(plan.entries[0].existing_contact_id, '11111111-1111-1111-1111-111111111111')
})

test('requires exactly one non-overlapping phone mapping', () => {
  assert.throws(() => buildImportPlan({ headers: ['phone'], rows: [['0977123456']], mapping: {}, existingContacts: [] }), /Choose one column/)
  assert.throws(() => buildImportPlan({ headers: ['phone'], rows: [['0977123456']], mapping: { phone: 0, name: 0 }, existingContacts: [] }), /only be used once/)
})

test('import route is manager-only and derives workspace server-side', () => {
  const route = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'routes', 'contactImports.js'), 'utf8')
  assert.match(route, /router\.post\('\/preview', requireAdmin/)
  assert.match(route, /router\.post\('\/confirm', requireAdmin/)
  assert.match(route, /req\.workspace\.customerId/)
  assert.match(route, /eq\('customer_id', req\.workspace\.customerId\)/)
  assert.match(route, /execute_contact_import/)
})


test('webhook lookup recognises imported canonical contacts before creating a new one', () => {
  const webhook = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'routes', 'webhook.js'), 'utf8')
  assert.match(webhook, /eq\('phone_e164', canonical\)/)
  assert.match(webhook, /source: 'whatsapp'/)
})
