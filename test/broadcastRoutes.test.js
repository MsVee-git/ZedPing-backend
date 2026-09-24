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
  assert.match(source, /resolveTemplateRecipients\(template, audience\.recipients, body\?\.variable_mappings\)/)
})

test('template send repeats review validation and does not accept a browser recipient list', () => {
  const sendSection = source.slice(source.indexOf("router.post('/send-template'"), source.indexOf("router.post('/send',"))
  assert.match(sendSection, /await templateReview\(req\.workspace\.customerId, req\.body \|\| \{\}\)/)
  assert.doesNotMatch(sendSection, /req\.body\?\.contacts/)
  assert.match(sendSection, /review\.skipped_recipients/)
})

