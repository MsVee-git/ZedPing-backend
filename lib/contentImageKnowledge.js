const { reviewableExtraction } = require('./knowledgeExtraction')
const { CONTENT_BUCKET } = require('./contentLibrary')

const MAX_REVIEW_TEXT = 20000
const MAX_NOTES = 12

function cleanReviewText(value) {
  if (typeof value !== 'string') throw new Error('Information found is invalid')
  const text = value.trim()
  if (!text) throw new Error('Information found is required')
  if (text.length > MAX_REVIEW_TEXT) throw new Error('Information found is too long')
  return text
}

function cleanReviewNotes(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('Review notes are invalid')
  return value.map(note => String(note || '').trim()).filter(Boolean).slice(0, MAX_NOTES).map(note => note.slice(0, 500))
}

function cleanDate(value, label) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(label + ' is invalid')
  const date = new Date(value + 'T00:00:00Z')
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(label + ' is invalid')
  return value
}

function publicIngestion(run, revision = null) {
  if (!run) return null
  return {
    id: run.id, status: run.status, extracted_text: reviewableExtraction(revision?.text_content ?? run.extracted_text),
    review_notes: Array.isArray(run.review_notes) ? run.review_notes : [], error_category: run.error_category || null,
    created_at: run.created_at, updated_at: run.updated_at, reviewed_at: run.reviewed_at || null,
    revision: revision ? { id: revision.id, revision: revision.revision, valid_from: revision.valid_from, valid_until: revision.valid_until, approved_at: revision.approved_at } : null
  }
}

async function downloadKnowledgeFile(item) {
  if (!item?.storage_path || (item.content_type === 'IMAGE' && !String(item.mime_type || '').startsWith('image/'))) throw new Error('This file cannot be analyzed')
  // Require the configured service client only when an extraction is actually
  // requested. Pure review/eligibility tests never need credentials.
  const supabase = require('./supabase')
  const { data, error } = await supabase.storage.from(CONTENT_BUCKET).download(item.storage_path)
  if (error || !data) throw new Error('Unable to retrieve this private file')
  const buffer = Buffer.from(await data.arrayBuffer())
  if (!buffer.length) throw new Error('This file is empty')
  return { buffer, mimeType: item.mime_type }
}

async function extractForReview(item) {
  const { buffer, mimeType } = await downloadKnowledgeFile(item)
  const { extractDocumentKnowledge, extractImageKnowledge } = require('./openai')
  const result = item.content_type === 'DOCUMENT'
    ? await extractDocumentKnowledge({ buffer, mimeType, filename: item.original_file_name || 'document.pdf' })
    : await extractImageKnowledge({ buffer, mimeType })
  return { extracted_text: cleanReviewText(result.text), review_notes: cleanReviewNotes(result.notes) }
}

module.exports = { MAX_REVIEW_TEXT, cleanReviewText, cleanReviewNotes, cleanDate, publicIngestion, extractForReview }
