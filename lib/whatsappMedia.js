const axios = require('axios')
const { graphApiVersion } = require('./whatsapp')

const MEDIA_ID = /^[0-9]{5,64}$/
const META_MEDIA_HOSTS = new Set(['graph.facebook.com', 'lookaside.fbsbx.com'])

class WhatsAppMediaError extends Error {
  constructor(message, status = 502) {
    super(message)
    this.name = 'WhatsAppMediaError'
    this.status = status
  }
}

function safeMetaMediaUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'https:' && META_MEDIA_HOSTS.has(url.hostname) ? url : null
  } catch (_) {
    return null
  }
}

async function fetchWhatsAppMedia({ mediaId, accessToken, expectedType, http = axios }) {
  if (!MEDIA_ID.test(String(mediaId || '')) || typeof accessToken !== 'string' || !accessToken) {
    throw new WhatsAppMediaError('Attachment is unavailable', 404)
  }
  try {
    const metadata = await http.get(`https://graph.facebook.com/${graphApiVersion()}/${mediaId}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    })
    const url = safeMetaMediaUrl(metadata?.data?.url)
    const mimeType = String(metadata?.data?.mime_type || '').toLowerCase()
    const correctType = expectedType === 'image' ? mimeType.startsWith('image/') : expectedType === 'document' ? !mimeType.startsWith('image/') : false
    if (!url || !correctType) throw new WhatsAppMediaError('Attachment is unavailable', 404)
    const content = await http.get(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` }, responseType: 'arraybuffer'
    })
    return { buffer: Buffer.from(content.data), mimeType }
  } catch (error) {
    if (error instanceof WhatsAppMediaError) throw error
    const status = Number(error?.response?.status)
    if (status === 404 || status === 410) throw new WhatsAppMediaError('Attachment is unavailable', 404)
    throw new WhatsAppMediaError('Attachment could not be loaded', 502)
  }
}

async function fetchWhatsAppImage(options) { return fetchWhatsAppMedia({ ...options, expectedType: 'image' }) }

module.exports = { WhatsAppMediaError, safeMetaMediaUrl, fetchWhatsAppMedia, fetchWhatsAppImage }
