const test = require('node:test')
const assert = require('node:assert/strict')
const { editablePatch } = require('../lib/contentLibrary')

test('Text updates preserve item identity and validate title/body', () => {
  const item = { id: 'content-a', customer_id: 'workspace-a', content_type: 'TEXT' }
  const patch = editablePatch(item, { name: ' Updated offer ', description: 'Current', text_content: 'Roll bars start at K6,200.' })
  assert.equal(item.id, 'content-a')
  assert.equal(item.customer_id, 'workspace-a')
  assert.equal(patch.name, 'Updated offer')
  assert.equal(patch.text_content, 'Roll bars start at K6,200.')
  assert.equal(patch.description, 'Current')
  assert.ok(patch.updated_at)
})

test('Link updates accept only safe URL fields and preserve type', () => {
  const item = { id: 'content-link', content_type: 'LINK' }
  const patch = editablePatch(item, { name: 'Offers', link_url: 'https://example.com/offers' })
  assert.equal(item.content_type, 'LINK')
  assert.equal(patch.link_url, 'https://example.com/offers')
  assert.throws(() => editablePatch(item, { text_content: 'not allowed' }), /Link content cannot include a text update/)
  assert.throws(() => editablePatch(item, { link_url: 'ftp://example.com' }), /Only http and https links are allowed/)
})

test('content update rejects identity, type, file, and malformed payload mutation attempts', () => {
  const text = { id: 'content-a', content_type: 'TEXT' }
  assert.throws(() => editablePatch(text, {}), /Choose something to update/)
  assert.throws(() => editablePatch(text, { customer_id: 'workspace-b', name: 'x' }), /Invalid content update/)
  assert.throws(() => editablePatch(text, { content_type: 'LINK', name: 'x' }), /Invalid content update/)
  assert.throws(() => editablePatch(text, { storage_path: 'other-workspace/file', name: 'x' }), /Invalid content update/)
  assert.throws(() => editablePatch(text, { link_url: 'https://example.com' }), /Text content cannot include a link update/)
  assert.throws(() => editablePatch(text, { name: ' ', text_content: 'valid' }), /Name is required/)
})
