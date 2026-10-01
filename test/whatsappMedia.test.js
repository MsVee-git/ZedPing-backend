const test = require('node:test')
const assert = require('node:assert/strict')
const { fetchWhatsAppImage, fetchWhatsAppMedia, safeMetaMediaUrl, WhatsAppMediaError } = require('../lib/whatsappMedia')

test('retrieves an image only through a Meta-approved URL with server credentials', async () => {
  const calls = []
  const http = { get: async (url, options) => {
    calls.push({ url, options })
    if (calls.length === 1) return { data: { url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=123', mime_type: 'image/jpeg' } }
    return { data: Buffer.from('image-bytes') }
  } }
  const media = await fetchWhatsAppImage({ mediaId: '1234567890', accessToken: 'server-only-token', http })
  assert.equal(media.mimeType, 'image/jpeg')
  assert.deepEqual(media.buffer, Buffer.from('image-bytes'))
  assert.equal(calls.length, 2)
  assert.equal(calls.every(call => call.options.headers.Authorization === 'Bearer server-only-token'), true)
  assert.equal(JSON.stringify({ media, calls: calls.map(({ url, options }) => ({ url, responseType: options.responseType })) }).includes('server-only-token'), false)
})

test('rejects non-Meta media redirects and expired media without fetching arbitrary URLs', async () => {
  assert.equal(safeMetaMediaUrl('https://example.invalid/private'), null)
  let calls = 0
  const http = { get: async () => { calls++; return { data: { url: 'https://example.invalid/file', mime_type: 'image/jpeg' } } } }
  await assert.rejects(() => fetchWhatsAppImage({ mediaId: '1234567890', accessToken: 'server-only-token', http }), WhatsAppMediaError)
  assert.equal(calls, 1)
})

test('retrieves a document only through the same authenticated proxy boundary', async () => {
  const http = { get: async (url) => url.includes('graph.facebook.com')
    ? { data: { url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=456', mime_type: 'application/pdf' } }
    : { data: Buffer.from('%PDF-1.7') } }
  const media = await fetchWhatsAppMedia({ mediaId: '1234567890', accessToken: 'server-only-token', expectedType: 'document', http })
  assert.equal(media.mimeType, 'application/pdf')
  await assert.rejects(() => fetchWhatsAppMedia({ mediaId: '1234567890', accessToken: 'server-only-token', expectedType: 'image', http }), WhatsAppMediaError)
})
