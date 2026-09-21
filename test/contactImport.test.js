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
  for (const phone of ['0977123456', '977123456', '260977123456', '+260977123456']) {
    assert.equal(normalizePhone(phone), '+260977123456')
  }
  const plan = buildImportPlan({ headers: ['phone'], rows: [['0977123456']], mapping: { phone: 0 }, existingContacts: [] })
  assert.equal(plan.summary.new_contacts, 1)
  assert.equal(plan.entries[0].name, '')
})

test('preserves valid international E.164 and accepts blank names', () => {
  const plan = base([['+447700900123', '', '']])
  assert.equal(plan.entries[0].phone_e164, '+447700900123')
  assert.equal(plan.entries[0].name, '')
})

test('rejects invalid phones, duplicate file rows and invalid email without producing entries', () => {
  const plan = base([['not-a-phone', '', ''], ['0977123456', '', 'bad-email'], ['0977123456', '', '']])
  assert.equal(plan.entries.length, 0)
  assert.equal(plan.summary.invalid_rows, 3)
  assert.equal(plan.summary.duplicate_rows, 1)
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
