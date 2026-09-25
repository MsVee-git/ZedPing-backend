const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'broadcasts.js'), 'utf8')

test('template broadcast review is manager-only and resolves every browser selector in its workspace', () => {
  assert.match(source, /router\.get\('\/setup', requireAdmin/)
  assert.match(source, /router\.get\('\/templates', requireAdmin/)
  assert.match(source, /router\.post\('\/review-template', requireAdmin/)
  assert.match(source, /router\.post\('\/send-template', requireAdmin/)
  assert.match(source, /eq\('customer_id', workspace\)/)
  assert.match(source, /loadWorkspaceTemplates\(workspace, number\.id\)/)
  assert.match(source, /resolveTemplateRecipients\(template, marketing\.eligible, body\?\.variable_mappings\)/)
})

test('template send repeats review validation and does not accept a browser recipient list', () => {
  const sendSection = source.slice(source.indexOf("router.post('/send-template'"), source.indexOf("router.post('/send',"))
  assert.match(sendSection, /await templateReview\(req\.workspace\.customerId, req\.body \|\| \{\}\)/)
  assert.doesNotMatch(sendSection, /req\.body\?\.contacts/)
  assert.match(sendSection, /review\.skipped_recipients/)
})



test('broadcast setup exposes a human telephone label while preserving Meta IDs for server-side sending only', () => {
  const setupSection = source.slice(source.indexOf("router.get('/setup'"), source.indexOf("router.get('/templates'"))
  assert.match(setupSection, /select\('id,phone_number,phone_number_id,display_name,status'\)/)
  assert.match(source, /function publicConnection\(number\)/)
  assert.match(source, /display_phone_number: displayPhoneNumber\(number\)/)
  assert.doesNotMatch(setupSection, /phone_number_id.*res\.json/)
  assert.match(source, /sendTemplateMessage\(review\.number\.phone_number_id/)
})
