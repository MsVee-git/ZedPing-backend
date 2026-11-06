const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('all-contact broadcasts derive, deduplicate, filter, and revalidate recipients server-side', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/broadcasts.js'), 'utf8')
  assert.match(source, /body\?\.audience_type === 'all_contacts'/)
  assert.match(source, /loadAllWorkspaceContacts\(supabase, workspace/)
  assert.match(source, /dedupeRecipients\(contacts \|\| \[\]\)/)
  assert.match(source, /filterWorkspaceMarketingRecipients\(supabase, workspace, audience\.recipients\)/)
  const sendTemplate = source.slice(source.indexOf("async function sendTemplateBroadcast"), source.indexOf("router.post('/send'"))
  assert.match(sendTemplate, /templateReview\(req\.workspace\.customerId, req\.body \|\| \{\}, req\.scheduledRecipients\)/)
})
