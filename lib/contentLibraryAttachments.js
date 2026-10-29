const { CONTENT_BUCKET, MAX_FILE_SIZE, IMAGE_TYPES } = require('./contentLibrary')

const MAX_AGENT_ATTACHMENTS = 10

function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) }
function words(value) { return [...new Set(String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])] }

function supported(item) {
  if (!item || item.archived_at || !item.storage_path || !item.original_file_name) return false
  if (!Number.isFinite(Number(item.file_size)) || Number(item.file_size) < 1 || Number(item.file_size) > MAX_FILE_SIZE) return false
  return (item.content_type === 'IMAGE' && IMAGE_TYPES.has(item.mime_type)) ||
    (item.content_type === 'DOCUMENT' && item.mime_type === 'application/pdf')
}

function snapshot(item) {
  if (!supported(item)) return null
  return {
    id: item.id,
    name: String(item.name || '').slice(0, 160),
    description: String(item.description || '').slice(0, 500),
    type: item.content_type === 'IMAGE' ? 'image' : 'document',
    mime_type: item.mime_type,
    filename: String(item.original_file_name || '').slice(0, 120),
    file_size: Number(item.file_size),
    storage_path: item.storage_path
  }
}

function publicAttachment(item) {
  if (!item) return item
  const { storage_path, ...safe } = item
  return safe
}

async function resolveAttachments(supabase, customerId, ids) {
  const unique = [...new Set((Array.isArray(ids) ? ids : []).filter(uuid))]
  if (unique.length > MAX_AGENT_ATTACHMENTS) throw new Error(`Select no more than ${MAX_AGENT_ATTACHMENTS} approved files`)
  if (!unique.length) return []
  const { data, error } = await supabase.from('content_library_items')
    .select('id,name,description,content_type,storage_path,original_file_name,mime_type,file_size,archived_at')
    .eq('customer_id', customerId).is('archived_at', null).in('id', unique)
  if (error) throw error
  const byId = new Map((data || []).map(item => [item.id, item]))
  const items = unique.map(id => byId.get(id)).filter(Boolean)
  if (items.length !== unique.length || items.some(item => !supported(item))) {
    throw new Error('Every shared file must be an active Image or PDF from this workspace')
  }
  return items.map(snapshot)
}

function attachmentDecision(attachments, question) {
  const requested = /\b(send|share|show|see|view|give|menu|catalog(?:ue)?|brochure|price\s*list|pdf|image|photo)\b/i.test(String(question || ''))
  if (!requested) return { kind: 'none' }
  const terms = words(question)
  const ranked = (attachments || []).map((item, index) => {
    const haystack = `${item.name || ''} ${item.description || ''} ${item.filename || ''}`.toLowerCase()
    const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0)
    return { item, index, score }
  }).filter(candidate => candidate.score > 0).sort((a, b) => b.score - a.score || a.index - b.index)
  if (!ranked.length) return { kind: 'none' }
  const best = ranked[0]
  const tied = ranked.filter(candidate => candidate.score === best.score)
  if (tied.length > 1) return { kind: 'ambiguous', items: tied.map(candidate => candidate.item) }
  return { kind: 'selected', item: best.item }
}

async function fileForAttachment(supabase, customerId, attachment) {
  if (!attachment?.id || !attachment?.storage_path) throw new Error('Selected file is unavailable')
  const { data: item, error } = await supabase.from('content_library_items')
    .select('id,name,description,content_type,storage_path,original_file_name,mime_type,file_size,archived_at')
    .eq('id', attachment.id).eq('customer_id', customerId).is('archived_at', null).maybeSingle()
  if (error) throw error
  const current = snapshot(item)
  if (!current || current.storage_path !== attachment.storage_path || current.mime_type !== attachment.mime_type) {
    throw new Error('Selected file is no longer available')
  }
  const { data: blob, error: downloadError } = await supabase.storage.from(CONTENT_BUCKET).download(current.storage_path)
  if (downloadError || !blob) throw new Error('Selected file could not be read')
  const buffer = Buffer.from(await blob.arrayBuffer())
  if (!buffer.length || buffer.length > MAX_FILE_SIZE) throw new Error('Selected file is no longer available')
  return { attachment: current, file: { buffer, size: buffer.length, mimetype: current.mime_type, originalname: current.filename } }
}

module.exports = { MAX_AGENT_ATTACHMENTS, supported, snapshot, publicAttachment, resolveAttachments, attachmentDecision, fileForAttachment }
