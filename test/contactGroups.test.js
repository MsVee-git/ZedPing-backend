const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { normalizeGroupName, validateGroupName, isUniqueViolation } = require('../lib/contactGroups')

test('normalizes contact group names deterministically', () => {
  assert.equal(normalizeGroupName('  Facebook   Leads  '), 'Facebook Leads')
  assert.equal(validateGroupName('  Facebook   Leads  '), 'Facebook Leads')
  assert.throws(() => validateGroupName('   '), /Enter a contact group name/)
  assert.throws(() => validateGroupName('x'.repeat(101)), /100 characters/)
})

test('unique constraint errors remain distinguishable for safe retry UX', () => {
  assert.equal(isUniqueViolation({ code: '23505' }), true)
  assert.equal(isUniqueViolation({ code: '42501' }), false)
})

test('contact group routes enforce manager-only mutations and workspace-scoped lookups', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'contactGroups.js'), 'utf8')
  assert.match(source, /router\.post\('\/', requireAdmin/)
  assert.match(source, /router\.post\('\/:groupId\/members', requireAdmin/)
  assert.match(source, /router\.delete\('\/:groupId\/members\/:memberId', requireAdmin/)
  assert.match(source, /router\.delete\('\/:groupId', requireAdmin/)
  assert.match(source, /eq\('customer_id', req\.workspace\.customerId\)/)
  assert.match(source, /eq\('customer_id', req\.workspace\.customerId\)/)
})

test('dashboard sends group mutations through the authenticated backend API', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'ZedPing-Dashboard', 'src', 'App.tsx'), 'utf8')
  assert.match(source, /\$\{API\}\/contact-groups/)
  assert.doesNotMatch(source, /function createGroup\(\)[\s\S]{0,500}supabase\.from\("contact_groups"\)\.insert/)
})
