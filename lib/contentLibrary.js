const crypto = require('crypto')
const path = require('path')

const CONTENT_BUCKET = 'content-library'
const MAX_FILE_SIZE = 10 * 1024 * 1024
const TYPES = new Set(['TEXT', 'DOCUMENT', 'IMAGE', 'LINK', 'WHATSAPP_TEMPLATE_REFERENCE'])
const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv'
])
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

function cleanText(value, max, label, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${label} is required`)
    return null
  }
  if (typeof value !== 'string') throw new Error(`${label} is invalid`)
  const text = value.trim()
  if (required && !text) throw new Error(`${label} is required`)
  if (text.length > max) throw new Error(`${label} is too long`)
  return text || null
}

function safeUrl(value) {
  const url = cleanText(value, 2048, 'Link URL', true)
  let parsed
  try { parsed = new URL(url) } catch (_) { throw new Error('Enter a valid http or https URL') }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http and https links are allowed')
  return parsed.toString()
}

function assertFile(file, type) {
  if (!file) throw new Error('Select a file to upload')
  if (!Number.isFinite(file.size) || file.size < 1 || file.size > MAX_FILE_SIZE) throw new Error('Files must be between 1 byte and 10 MB')
  const allowed = type === 'IMAGE' ? IMAGE_TYPES : DOCUMENT_TYPES
  if (!allowed.has(file.mimetype)) throw new Error(type === 'IMAGE' ? 'Only JPEG, PNG, and WebP images are allowed' : 'This document type is not allowed')
}

function safeOriginalName(value) {
  const base = path.basename(String(value || 'upload')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
  return base || 'upload'
}

function storagePath(customerId, fileName) {
  return `${customerId}/${crypto.randomUUID()}/${safeOriginalName(fileName)}`
}

function itemForClient(item) {
  if (!item) return item
  const { storage_path, ...safe } = item
  return safe
}

module.exports = { CONTENT_BUCKET, MAX_FILE_SIZE, TYPES, cleanText, safeUrl, assertFile, storagePath, itemForClient }

