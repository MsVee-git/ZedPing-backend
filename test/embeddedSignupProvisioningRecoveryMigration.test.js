const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('provisioning recovery migration preserves safe non-duplicate registration states', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261003103000_add_provisioning_recovery_state.sql'), 'utf8')
  assert.match(sql, /add column if not exists provisioning_claimed_at timestamptz/i)
  assert.match(sql, /add column if not exists provisioning_registration_attempted_at timestamptz/i)
  assert.match(sql, /registration_confirmation_required/i)
  assert.match(sql, /begin;/i)
  assert.match(sql, /commit;/i)
})
