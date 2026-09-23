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
  assert.match(source, /findWorkspaceGroup\(req\.params\.groupId, req\.workspace\.customerId\)/)
})

test('bulk membership routes are manager-only, workspace-scoped, and use one server batch', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'contactGroups.js'), 'utf8')
  assert.match(source, /router\.post\('\/:groupId\/members\/batch', requireAdmin/)
  assert.match(source, /router\.delete\('\/:groupId\/members\/batch', requireAdmin/)
  assert.match(source, /p_customer_id: customerId/)
  assert.match(source, /add_contact_group_members_batch/)
  assert.match(source, /remove_contact_group_members_batch/)
  assert.match(source, /MAX_BATCH_CONTACTS = 1000/)
  assert.ok(source.indexOf("router.delete('/:groupId/members/batch'") < source.indexOf("router.delete('/:groupId/members/:memberId'"))
})

test('batch migration preserves group/contact workspace checks and duplicate protection', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260923113000_add_batched_contact_group_memberships.sql'), 'utf8')
  assert.match(migration, /g\.id = p_group_id and g\.customer_id = p_customer_id/)
  assert.match(migration, /c\.customer_id = p_customer_id/)
  assert.match(migration, /on conflict \(group_id, contact_id\) do nothing/)
  assert.match(migration, /revoke all on function public\.add_contact_group_members_batch[\s\S]*from public, anon, authenticated/)
  assert.match(migration, /grant execute on function public\.remove_contact_group_members_batch[\s\S]*to service_role/)
})

