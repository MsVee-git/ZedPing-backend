const path = require('node:path')

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const DOCUMENT_TYPES = new Set([
  'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/plain', 'text/csv'
])
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.csv'])
const MEDIA_ID = /^[0-9]{5,64}$/

function cleanText(value, limit = 4096) { return typeof value === 'string' ? value.trim().slice(0, limit) : '' }
function safeFilename(value) {
  const name = path.basename(cleanText(value, 180)).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
  return name || 'attachment'
}
function hasPng(buffer) { return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) }
function hasJpeg(buffer) { return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff }
function hasWebp(buffer) { return buffer.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP' }
function hasPdf(buffer) { return buffer.length >= 5 && buffer.subarray(0, 5).toString() === '%PDF-' }
function hasOle(buffer) { return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) }
function hasZip(buffer) { return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && [0x03, 0x05, 0x07].includes(buffer[2]) && [0x04, 0x06, 0x08].includes(buffer[3]) }
function looksLikeText(buffer) { return buffer.length > 0 && !buffer.subarray(0, Math.min(buffer.length, 4096)).some(byte => byte === 0 || (byte < 9) || (byte > 13 && byte < 32)) }

function detectImageType(buffer) {
  if (hasJpeg(buffer)) return 'image/jpeg'
  if (hasPng(buffer)) return 'image/png'
  if (hasWebp(buffer)) return 'image/webp'
  return null
}

function validateOutboundUpload(file, requestedType, caption) {
  if (!['image', 'document'].includes(requestedType)) throw new Error('Attachment type is invalid')
  if (!Buffer.isBuffer(file?.buffer) || file.buffer.length < 1 || file.buffer.length > MAX_ATTACHMENT_BYTES) throw new Error('Attachment must be one file up to 10 MB')
  const filename = safeFilename(file.originalname)
  const extension = path.extname(filename).toLowerCase()
  const claimedType = cleanText(file.mimetype, 128).toLowerCase()
  const safeCaption = cleanText(caption, 1024)
  if (requestedType === 'image') {
    const mimeType = detectImageType(file.buffer)
    if (!mimeType || !IMAGE_TYPES.has(claimedType) || claimedType !== mimeType) throw new Error('Use a valid JPEG, PNG, or WebP image')
    return { type: 'image', mime_type: mimeType, filename, caption: safeCaption || null, file }
  }
  if (!DOCUMENT_EXTENSIONS.has(extension) || !DOCUMENT_TYPES.has(claimedType)) throw new Error('Use a supported PDF, Office document, spreadsheet, TXT, or CSV file')
  const validContent = extension === '.pdf' ? hasPdf(file.buffer)
    : ['.doc', '.xls'].includes(extension) ? hasOle(file.buffer)
      : ['.docx', '.xlsx'].includes(extension) ? hasZip(file.buffer)
        : looksLikeText(file.buffer)
  if (!validContent) throw new Error('The document contents do not match its supported file type')
  return { type: 'document', mime_type: claimedType, filename, caption: safeCaption || null, file }
}

function parseLocation(value) {
  const latitude = Number(value?.latitude), longitude = Number(value?.longitude)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new Error('Enter a valid latitude and longitude')
  const name = cleanText(value?.name, 256), address = cleanText(value?.address, 512)
  return { type: 'location', latitude, longitude, name: name || null, address: address || null }
}

function storedAttachment(media) {
  if (!media || !['image', 'document'].includes(media.type) || !MEDIA_ID.test(String(media.media_id || ''))) return null
  return { mediaId: media.media_id, type: media.type, mimeType: cleanText(media.mime_type, 128).toLowerCase() || null, filename: safeFilename(media.filename) }
}

function publicMessageMedia(media) {
  if (!media || !['image', 'document', 'location'].includes(media.type)) return null
  if (media.type === 'location') return { type: 'location', latitude: Number(media.latitude), longitude: Number(media.longitude), name: cleanText(media.name, 256) || null, address: cleanText(media.address, 512) || null }
  return { type: media.type, mime_type: cleanText(media.mime_type, 128).toLowerCase() || null, filename: safeFilename(media.filename), caption: cleanText(media.caption, 1024) || null }
}

module.exports = { MAX_ATTACHMENT_BYTES, validateOutboundUpload, parseLocation, storedAttachment, publicMessageMedia }
