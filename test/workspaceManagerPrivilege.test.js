const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('workspace manager helper migration never grants anonymous execution', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'migrations', '20260920090000_restrict_workspace_manager_execution.sql'),
    'utf8'
  )

  assert.match(migration, /revoke all on function public\.is_workspace_manager\(uuid\) from public;/i)
  assert.match(migration, /revoke execute on function public\.is_workspace_manager\(uuid\) from anon;/i)
  assert.match(migration, /grant execute on function public\.is_workspace_manager\(uuid\) to authenticated;/i)
  assert.match(migration, /grant execute on function public\.is_workspace_manager\(uuid\) to service_role;/i)
  assert.doesNotMatch(migration, /grant execute on function public\.is_workspace_manager\(uuid\) to anon;/i)
})
