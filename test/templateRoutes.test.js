const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'templates.js'), 'utf8')

test('template routes derive WABA and phone data only from the active workspace-owned connection', () => {
  assert.match(source, /\.eq\('customer_id', customerId\)/)
  assert.match(source, /\.eq\('status', 'connected'\)/)
  assert.match(source, /Object\.keys\(body\)\.some\(\(key\) => !\['template_id', 'to'\]\.includes\(key\)\)/)
  assert.match(source, /router\.post\('\/send', requireAdmin/)
  assert.doesNotMatch(source, /body\.waba/i)
  assert.doesNotMatch(source, /body\.phone_number_id/i)
})
