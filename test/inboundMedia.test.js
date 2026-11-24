const test = require('node:test')
const assert = require('node:assert/strict')
const { parseInboundMedia, publicInboundMedia, storedInboundImage } = require('../lib/inboundMedia')

test('parses an inbound WhatsApp image without treating its Meta ID as a URL', () => {
  const parsed = parseInboundMedia({ type: 'image', image: { id: '1234567890', mime_type: 'image/jpeg', caption: 'Rear bar options' } })
  assert.deepEqual(parsed, {
    body: 'Rear bar options',
    media: { type: 'image', media_id: '1234567890', mime_type: 'image/jpeg', caption: 'Rear bar options' }
  })
  assert.equal(parsed.media.media_id.includes('http'), false)
})

test('preserves text handling and safely rejects malformed image metadata', () => {
  assert.deepEqual(parseInboundMedia({ type: 'text', text: { body: 'Hello' } }), { body: 'Hello', media: null })
  assert.deepEqual(parseInboundMedia({ type: 'image', image: { id: 'https://untrusted.invalid/a.jpg', mime_type: 'image/jpeg', caption: 'Caption' } }), { body: 'Caption', media: null })
  assert.equal(storedInboundImage({ type: 'image', media_id: 'not-an-id', mime_type: 'image/jpeg' }), null)
})

test('conversation responses omit stored Meta media IDs while retaining render metadata', () => {
  const stored = { type: 'image', media_id: '1234567890', mime_type: 'image/png', caption: 'A caption' }
  assert.deepEqual(publicInboundMedia(stored), { type: 'image', mime_type: 'image/png', caption: 'A caption' })
  assert.equal(JSON.stringify(publicInboundMedia(stored)).includes('1234567890'), false)
  assert.deepEqual(storedInboundImage(stored), { mediaId: '1234567890', mimeType: 'image/png' })
})

test('keeps Meta voice notes in the inbox and hides provider identifiers', () => {
  const parsed = parseInboundMedia({ type: 'audio', audio: { id: '1234567890', mime_type: 'audio/ogg; codecs=opus', voice: true } })
  assert.equal(parsed.unsupported, undefined)
  assert.equal(parsed.media.type, 'audio')
  assert.equal(parsed.media.media_id, '1234567890')
  assert.equal(publicInboundMedia(parsed.media).media_id, undefined)
})

test('accepts only Gupshup HTTPS audio download hosts and paths', () => {
  const options = { provider: 'gupshup' }
  const url = 'https://filemanager.gupshup.io/wa/app/wa/media/file?download=false'
  const parse = value => parseInboundMedia({ type: 'audio', audio: { url: value } }, options).media
  assert.equal(parse(url).provider_url, url)
  assert.equal(publicInboundMedia(parse(url)).provider_url, undefined)
  assert.equal(parse('https://filemanager.gupshup.io.evil.example/wa/app/wa/media/file').provider_url, undefined)
  assert.equal(parse('https://filemanager.gupshup.io:8443/wa/app/wa/media/file').provider_url, undefined)
})
