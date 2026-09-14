const test = require('node:test')
const assert = require('node:assert/strict')
const { validateTemplateHeaderMedia } = require('../lib/templateMedia')
const { MetaTemplateError } = require('./metaTemplates')

const file = (bytes, mimetype = 'application/octet-stream') => ({
  buffer: Buffer.from(bytes),
  size: bytes.length,
  mimetype,
  originalname: 'header'
})

test('accepts only JPEG or PNG samples for image template headers', () => {
  assert.doesNotThrow(() => validateTemplateHeaderMedia(file([0xff, 0xd8, 0xff, 0x00], 'image/jpeg'), 'image'))
  assert.doesNotThrow(() => validateTemplateHeaderMedia(file([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png'), 'image'))
  assert.throws(() => validateTemplateHeaderMedia(file([0x25, 0x50, 0x44, 0x46, 0x2d], 'application/pdf'), 'image'), MetaTemplateError)
})

test('accepts only PDF samples for document template headers', () => {
  assert.doesNotThrow(() => validateTemplateHeaderMedia(file([0x25, 0x50, 0x44, 0x46, 0x2d], 'application/pdf'), 'document'))
  assert.throws(() => validateTemplateHeaderMedia(file([0xff, 0xd8, 0xff], 'image/jpeg'), 'document'), MetaTemplateError)
  assert.throws(() => validateTemplateHeaderMedia(file([], 'application/pdf'), 'document'), MetaTemplateError)
})
