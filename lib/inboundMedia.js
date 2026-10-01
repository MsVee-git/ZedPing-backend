const MEDIA_ID = /^[0-9]{5,64}$/

function cleanText(value, limit = 4096) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, limit)
}

// Meta sends a media ID, not a durable public URL. Keep only the minimum
// message metadata required to authorize a later server-side retrieval.
function parseInboundMedia(message) {
  const type = cleanText(message?.type, 32).toLowerCase()
  if (type !== 'image') return { body: cleanText(message?.text?.body), media: null }

  const image = message?.image || {}
  const mediaId = cleanText(image.id, 64)
  const mimeType = cleanText(image.mime_type, 128).toLowerCase()
  const caption = cleanText(image.caption)
  if (!MEDIA_ID.test(mediaId) || (mimeType && !mimeType.startsWith('image/'))) {
    return { body: caption, media: null }
  }

  return {
    body: caption,
    media: {
      type: 'image',
      media_id: mediaId,
      mime_type: mimeType || null,
      caption: caption || null
    }
  }
}

function publicInboundMedia(media) {
  if (!media || media.type !== 'image') return null
  return {
    type: 'image',
    mime_type: typeof media.mime_type === 'string' ? media.mime_type : null,
    caption: typeof media.caption === 'string' ? media.caption : null
  }
}

function storedInboundImage(media) {
  if (!media || media.type !== 'image') return null
  if (!MEDIA_ID.test(String(media.media_id || ''))) return null
  const mimeType = typeof media.mime_type === 'string' ? media.mime_type : ''
  if (mimeType && !mimeType.startsWith('image/')) return null
  return { mediaId: media.media_id, mimeType: mimeType || null }
}

module.exports = { parseInboundMedia, publicInboundMedia, storedInboundImage }
