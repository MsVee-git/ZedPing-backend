const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'content.js'), 'utf8')

test('permanent deletion is manager-only and audits every current content consumer', () => {
  assert.match(source, /router\.delete\('\/:id', requireAdmin/)
  for (const table of [
    'ai_agent_knowledge_items',
    'automations',
    'content_library_ingestions',
    'chatbot_flows',
    'chatbot_flow_versions',
    'ai_agent_configuration_versions'
  ]) assert.match(source, new RegExp(`from\\('${table}'\\)`))
  assert.match(source, /Archive it instead\./)
})

test('delete preserves provenance and reports storage cleanup truthfully', () => {
  const deleteHandler = source.slice(source.indexOf("router.delete('/:id'"), source.indexOf("router.post('/:id/refresh-template'"))
  const databaseDelete = deleteHandler.indexOf("supabase.from('content_library_items').delete()")
  const storageDelete = deleteHandler.indexOf('storage.from(CONTENT_BUCKET).remove')
  assert.ok(databaseDelete >= 0 && storageDelete > databaseDelete, 'storage cleanup runs only after the authorized database delete')
  assert.match(source, /storage_cleanup: 'failed'/)
  assert.match(source, /storage_cleanup: 'complete'/)
  assert.match(source, /an activated AI knowledge snapshot/)
  assert.match(source, /image knowledge history/)
  assert.match(source, /a chatbot flow draft/)
  assert.match(source, /a chatbot flow version/)
})

test('archive lifecycle exposes workspace-scoped restore', () => {
  assert.match(source, /router\.post\('\/:id\/restore', requireAdmin/)
  assert.match(source, /eq\('customer_id', req\.workspace\.customerId\)/)
  assert.match(source, /archived_at: null/)
  assert.match(source, /archived === 'all'/)
})
