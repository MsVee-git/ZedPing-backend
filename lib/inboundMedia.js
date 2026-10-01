const MEDIA_ID = /^[0-9]{5,64}$/

function cleanText(value, limit = 4096) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, limit)
}

// Meta sends a media ID, not a durable public URL. Keep only the minimum
// message metadata required to authorize a later server-side retrieval.
function parseInboundMedia(message) {
  const type = cleanText(message?.type, 32).toLowerCase()
  if (type === 'location') {
    const location = message?.location || {}
    const latitude = Number(location.latitude), longitude = Number(location.longitude)
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return { body: '', media: null }
    return { body: '', media: { type: 'location', latitude, longitude, name: cleanText(location.name, 256) || null, address: cleanText(location.address, 512) || null } }
  }
  if (!['image', 'document'].includes(type)) return { body: cleanText(message?.text?.body), media: null }

  const attachment = message?.[type] || {}
  const mediaId = cleanText(attachment.id, 64)
  const mimeType = cleanText(attachment.mime_type, 128).toLowerCase()
  const caption = cleanText(attachment.caption)
  const filename = type === 'document' ? cleanText(attachment.filename, 180) : ''
  const expectedPrefix = type === 'image' ? 'image/' : ''
  if (!MEDIA_ID.test(mediaId) || (expectedPrefix && mimeType && !mimeType.startsWith(expectedPrefix))) return { body: caption, media: null }

  return {
    body: caption,
    media: {
      type,
      media_id: mediaId,
      mime_type: mimeType || null,
      caption: caption || null,
      ...(type === 'document' ? { filename: filename || null } : {})
    }
  }
}

function publicInboundMedia(media) {
  if (!media || !['image', 'document', 'location'].includes(media.type)) return null
  if (media.type === 'location') return {
    type: 'location', latitude: Number(media.latitude), longitude: Number(media.longitude),
    name: typeof media.name === 'string' ? media.name : null, address: typeof media.address === 'string' ? media.address : null
  }
  return {
    type: media.type,
    mime_type: typeof media.mime_type === 'string' ? media.mime_type : null,
    caption: typeof media.caption === 'string' ? media.caption : null,
    ...(media.type === 'document' ? { filename: typeof media.filename === 'string' ? media.filename : null } : {})
  }
}

function storedInboundImage(media) {
  if (!media || media.type !== 'image') return null
  if (!MEDIA_ID.test(String(media.media_id || ''))) return null
  const mimeType = typeof media.mime_type === 'string' ? media.mime_type : ''
  if (mimeType && !mimeType.startsWith('image/')) return null
  return { mediaId: media.media_id, mimeType: mimeType || null }
}

function storedInboundAttachment(media) {
  if (!media || !['image', 'document'].includes(media.type)) return null
  if (!MEDIA_ID.test(String(media.media_id || ''))) return null
  const mimeType = typeof media.mime_type === 'string' ? media.mime_type : ''
  if (media.type === 'image' && mimeType && !mimeType.startsWith('image/')) return null
  return { mediaId: media.media_id, type: media.type, mimeType: mimeType || null, filename: typeof media.filename === 'string' ? media.filename : null }
}

module.exports = { parseInboundMedia, publicInboundMedia, storedInboundImage, storedInboundAttachment }
