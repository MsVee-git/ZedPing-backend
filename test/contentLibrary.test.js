const test = require('node:test')
const assert = require('node:assert/strict')
const { safeUrl, assertFile, storagePath, itemForClient } = require('../lib/contentLibrary')

test('accepts only safe http/https links', () => {
  assert.equal(safeUrl('https://zedping.app/pay'), 'https://zedping.app/pay')
  assert.throws(() => safeUrl('javascript:alert(1)'), /Only http and https/)
  assert.throws(() => safeUrl('data:text/plain,no'), /Only http and https/)
  assert.throws(() => safeUrl('file:///secret'), /Only http and https/)
})

test('accepts supported content files and rejects invalid type or size', () => {
  assert.doesNotThrow(() => assertFile({ size: 1024, mimetype: 'application/pdf' }, 'DOCUMENT'))
  assert.doesNotThrow(() => assertFile({ size: 1024, mimetype: 'image/png' }, 'IMAGE'))
  assert.throws(() => assertFile({ size: 1024, mimetype: 'image/svg+xml' }, 'IMAGE'))
  assert.throws(() => assertFile({ size: 11 * 1024 * 1024, mimetype: 'application/pdf' }, 'DOCUMENT'))
})

test('server generated paths are workspace-prefixed and client items omit paths', () => {
  const id = '6dbd1d72-a636-46a8-9af7-c0e4a0f9be72'
  assert.match(storagePath(id, '../../private name.pdf'), new RegExp('^' + id + '/[0-9a-f-]+/private_name\\.pdf$'))
  assert.deepEqual(itemForClient({ id: 'item-a', storage_path: id + '/x/a.pdf', name: 'A' }), { id: 'item-a', name: 'A' })
})

