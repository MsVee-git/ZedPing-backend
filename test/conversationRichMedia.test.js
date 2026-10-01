const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { parseInboundMedia, publicInboundMedia } = require('../lib/inboundMedia')
const { validateOutboundUpload, parseLocation, publicMessageMedia, storedAttachment } = require('../lib/conversationMedia')
const { sendImageMessage, sendDocumentMessage, sendLocationMessage } = require('../lib/whatsapp')
const axios = require('axios')

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const pdf = Buffer.from('%PDF-1.7\nexample')

test('parses inbound document and location metadata without exposing opaque Meta IDs', () => {
  const document = parseInboundMedia({ type: 'document', document: { id: '1234567890', mime_type: 'application/pdf', filename: 'price-list.pdf', caption: 'Latest prices' } })
  assert.equal(document.media.type, 'document')
  assert.equal(document.media.media_id, '1234567890')
  assert.deepEqual(publicInboundMedia(document.media), { type: 'document', mime_type: 'application/pdf', caption: 'Latest prices', filename: 'price-list.pdf' })
  assert.equal(JSON.stringify(publicInboundMedia(document.media)).includes('1234567890'), false)
  const location = parseInboundMedia({ type: 'location', location: { latitude: -15.4167, longitude: 28.2833, name: 'Workshop', address: 'Lusaka' } })
  assert.deepEqual(location.media, { type: 'location', latitude: -15.4167, longitude: 28.2833, name: 'Workshop', address: 'Lusaka' })
})

test('validates outbound files from content signatures, not a browser MIME claim alone', () => {
  const image = validateOutboundUpload({ buffer: png, mimetype: 'image/png', originalname: 'photo.png' }, 'image', 'Caption')
  assert.equal(image.mime_type, 'image/png')
  assert.throws(() => validateOutboundUpload({ buffer: png, mimetype: 'image/jpeg', originalname: 'photo.jpg' }, 'image'), /valid JPEG, PNG, or WebP/)
  const document = validateOutboundUpload({ buffer: pdf, mimetype: 'application/pdf', originalname: 'quote.pdf' }, 'document')
  assert.equal(document.filename, 'quote.pdf')
  assert.throws(() => validateOutboundUpload({ buffer: Buffer.from('not a pdf'), mimetype: 'application/pdf', originalname: 'quote.pdf' }, 'document'), /contents do not match/)
})

test('location values are bounded and public metadata omits stored attachment identifiers', () => {
  assert.deepEqual(parseLocation({ latitude: '-15.4', longitude: '28.2', name: 'Main office' }), { type: 'location', latitude: -15.4, longitude: 28.2, name: 'Main office', address: null })
  assert.throws(() => parseLocation({ latitude: 99, longitude: 28 }), /valid latitude/)
  const stored = { type: 'document', media_id: '1234567890', mime_type: 'application/pdf', filename: 'quote.pdf', caption: 'Quote' }
  assert.deepEqual(storedAttachment(stored), { mediaId: '1234567890', type: 'document', mimeType: 'application/pdf', filename: 'quote.pdf' })
  assert.equal(JSON.stringify(publicMessageMedia(stored)).includes('1234567890'), false)
})

test('conversation routes retain human-control and workspace-scoped rich-media sends', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'conversations.js'), 'utf8')
  assert.match(source, /router\.post\('\/:id\/media', parseConversationUpload/)
  assert.match(source, /router\.post\('\/:id\/location'/)
  assert.match(source, /humanReplyTarget\(req\)/)
  assert.match(source, /\.eq\('customer_id', req\.workspace\.customerId\)/)
  assert.match(source, /sendImageMessage/)
  assert.match(source, /sendDocumentMessage/)
  assert.match(source, /sendLocationMessage/)
  assert.match(source, /outbound_media/)
})

test('outbound image, document and location sends use typed Meta payloads', async () => {
  const calls = []
  const originalPost = axios.post
  axios.post = async (url, body, config) => { calls.push({ url, body, config }); return { data: { messages: [{ id: 'meta-message' }] } } }
  try {
    await sendImageMessage('1234567890', '260970000000', { id: '998877', caption: 'Photo' }, 'server-token')
    await sendDocumentMessage('1234567890', '260970000000', { id: '887766', filename: 'quote.pdf', caption: 'Quote' }, 'server-token')
    await sendLocationMessage('1234567890', '260970000000', { latitude: -15.4, longitude: 28.2, name: 'Workshop' }, 'server-token')
    assert.deepEqual(calls.map(call => call.body.type), ['image', 'document', 'location'])
    assert.equal(calls[0].body.image.id, '998877')
    assert.equal(calls[1].body.document.filename, 'quote.pdf')
    assert.deepEqual(calls[2].body.location, { latitude: -15.4, longitude: 28.2, name: 'Workshop' })
    assert.equal(calls.every(call => call.config.headers.Authorization === 'Bearer server-token'), true)
  } finally { axios.post = originalPost }
})
