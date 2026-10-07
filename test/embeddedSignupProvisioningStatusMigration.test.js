const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const migrationPath = path.join(__dirname, '..', 'supabase', 'migrations', '20261002133000_allow_whatsapp_provisioning_status.sql')

test('Embedded Signup migration permits the transient provisioning connection state', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8')

  assert.match(sql, /drop constraint if exists whatsapp_numbers_status_check/i)
  assert.match(sql, /add constraint whatsapp_numbers_status_check/i)
  assert.match(sql, /status in \('connected', 'disconnected', 'provisioning'\)/i)
})
