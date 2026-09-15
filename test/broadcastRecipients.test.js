const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizePhone, transientRecipient, dedupeRecipients } = require('../lib/broadcastRecipients')

test('normalizes Zambian and international broadcast recipients', () => {
  assert.equal(normalizePhone('+260 971 234 567'), '+260971234567')
  assert.equal(normalizePhone('0971234567'), '+260971234567')
  assert.equal(normalizePhone('971234567'), '+260971234567')
  assert.equal(normalizePhone('not-a-number'), null)
})

test('accepts only valid transient recipients and de-duplicates them', () => {
  assert.deepEqual(transientRecipient({ name: ' Ada ', phone_number: '0971234567' }), { name: 'Ada', phone_number: '+260971234567' })
  assert.equal(transientRecipient({ name: 'Ada', phone_number: '123' }), null)
  assert.deepEqual(dedupeRecipients([
    { name: 'Ada', phone_number: '+260971234567' },
    { name: 'Duplicate', phone_number: '+260971234567' },
    { name: 'Bob', phone_number: '+260962345678' }
  ]), [
    { name: 'Ada', phone_number: '+260971234567' },
    { name: 'Bob', phone_number: '+260962345678' }
  ])
})
