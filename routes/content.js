const express = require('express')
const multer = require('multer')
const router = express.Router()
const supabase = require('../lib/supabase')
const { requireAdmin } = require('../middleware/auth')
const { createMetaTemplateClient, MetaTemplateError } = require('../lib/metaTemplates')
const { CONTENT_BUCKET, TYPES, cleanText, safeUrl, assertFile, storagePath, itemForClient } = require('../lib/contentLibrary')

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } })
function parseUpload(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (error) return res.status(400).json({ error: 'Upload one file no larger than 10 MB' })
    next()
  })
}

async function activeNumber(customerId) {
  const { data, error } = await supabase.from('whatsapp_numbers')
    .select('id, customer_id, phone_number_id, whatsapp_business_account_id, access_token, display_name, status')
    .eq('customer_id', customerId).eq('status', 'connected')
  if (error) throw error
  if (!data?.length) return null
  if (data.length !== 1 || !data[0].whatsapp_business_account_id) throw new Error('The workspace WhatsApp connection is incomplete or needs a number selection')
  return data[0]
}

async function validatedTemplate(customerId, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Select a valid WhatsApp template')
  const number = await activeNumber(customerId)
  if (!number) throw new Error('No connected WhatsApp number is available for this workspace')
  const meta = createMetaTemplateClient()
  const templates = await meta.listTemplates({ wabaId: number.whatsapp_business_account_id, accessToken: number.access_token })
  const template = templates.find((entry) => String(entry.id) === id)
  if (!template) throw new Error('This WhatsApp template is not available in the active workspace')
  return template
}

function listQuery(customerId, archived) {
  let query = supabase.from('content_library_items').select('*').eq('customer_id', customerId).order('updated_at', { ascending: false })
  return archived ? query.not('archived_at', 'is', null) : query.is('archived_at', null)
}

async function ownedItem(customerId, id) {
  const { data, error } = await supabase.from('content_library_items').select('*').eq('id', id).eq('customer_id', customerId).maybeSingle()
  if (error) throw error
  if (!data) { const err = new Error('Content item not found'); err.status = 404; throw err }
  return data
}

router.get('/', async (req, res) => {
  try {
    const archived = req.query.archived === 'true'
    const { data, error } = await listQuery(req.workspace.customerId, archived)
    if (error) throw error
    res.json({ items: (data || []).map(itemForClient) })
  } catch (_) { res.status(500).json({ error: 'Unable to load Content Library' }) }
})

router.post('/', requireAdmin, parseUpload, async (req, res) => {
  const body = req.body || {}
  let type
  try {
    if (Object.keys(body).some((key) => !['name', 'content_type', 'text_content', 'link_url', 'description', 'template_id'].includes(key))) throw new Error('Invalid content request')
    type = String(body.content_type || '').toUpperCase()
    if (!TYPES.has(type)) throw new Error('Choose a supported content type')
    const name = cleanText(body.name, 160, 'Name', true)
    const description = cleanText(body.description, 500, 'Description')
    const record = { customer_id: req.workspace.customerId, name, content_type: type, description, created_by: req.workspace.userId }
    if (type === 'TEXT') record.text_content = cleanText(body.text_content, 20000, 'Content', true)
    if (type === 'LINK') record.link_url = safeUrl(body.link_url)
    if (type === 'DOCUMENT' || type === 'IMAGE') {
      assertFile(req.file, type)
      const filePath = storagePath(req.workspace.customerId, req.file.originalname)
      const { error: uploadError } = await supabase.storage.from(CONTENT_BUCKET).upload(filePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false })
      if (uploadError) throw new Error('File upload failed')
      record.storage_path = filePath
      record.original_file_name = req.file.originalname
      record.mime_type = req.file.mimetype
      record.file_size = req.file.size
      const { data, error } = await supabase.from('content_library_items').insert(record).select().single()
      if (error) { await supabase.storage.from(CONTENT_BUCKET).remove([filePath]); throw error }
      return res.status(201).json({ item: itemForClient(data) })
    }
    if (type === 'WHATSAPP_TEMPLATE_REFERENCE') {
      const template = await validatedTemplate(req.workspace.customerId, body.template_id)
      record.template_id = String(template.id)
      record.template_name = template.name
      record.template_language = template.language
      record.template_status = template.status
    }
    const { data, error } = await supabase.from('content_library_items').insert(record).select().single()
    if (error) throw error
    res.status(201).json({ item: itemForClient(data) })
  } catch (error) {
    const status = error instanceof MetaTemplateError ? 502 : 400
    res.status(status).json({ error: error.message || 'Unable to save content' })
  }
})

router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const item = await ownedItem(req.workspace.customerId, req.params.id)
    if (item.archived_at) return res.status(409).json({ error: 'Archived content cannot be edited' })
    const body = req.body || {}
    if (Object.keys(body).some((key) => !['name', 'description', 'text_content', 'link_url'].includes(key))) return res.status(400).json({ error: 'Invalid content update' })
    const patch = { updated_at: new Date().toISOString() }
    if (Object.hasOwn(body, 'name')) patch.name = cleanText(body.name, 160, 'Name', true)
    if (Object.hasOwn(body, 'description')) patch.description = cleanText(body.description, 500, 'Description')
    if (item.content_type === 'TEXT' && Object.hasOwn(body, 'text_content')) patch.text_content = cleanText(body.text_content, 20000, 'Content', true)
    if (item.content_type === 'LINK' && Object.hasOwn(body, 'link_url')) patch.link_url = safeUrl(body.link_url)
    if (['DOCUMENT','IMAGE','WHATSAPP_TEMPLATE_REFERENCE'].includes(item.content_type) && (Object.hasOwn(body, 'text_content') || Object.hasOwn(body, 'link_url'))) return res.status(400).json({ error: 'This content type cannot be edited that way' })
    const { data, error } = await supabase.from('content_library_items').update(patch).eq('id', item.id).eq('customer_id', req.workspace.customerId).select().single()
    if (error) throw error
    res.json({ item: itemForClient(data) })
  } catch (error) { res.status(error.status || 400).json({ error: error.message || 'Unable to update content' }) }
})

router.post('/:id/archive', requireAdmin, async (req, res) => {
  try {
    const item = await ownedItem(req.workspace.customerId, req.params.id)
    if (item.archived_at) return res.json({ item: itemForClient(item) })
    const { data, error } = await supabase.from('content_library_items').update({ archived_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', item.id).eq('customer_id', req.workspace.customerId).select().single()
    if (error) throw error
    res.json({ item: itemForClient(data) })
  } catch (error) { res.status(error.status || 500).json({ error: error.message || 'Unable to archive content' }) }
})

router.post('/:id/refresh-template', requireAdmin, async (req, res) => {
  try {
    const item = await ownedItem(req.workspace.customerId, req.params.id)
    if (item.content_type !== 'WHATSAPP_TEMPLATE_REFERENCE') return res.status(400).json({ error: 'This is not a WhatsApp template reference' })
    const template = await validatedTemplate(req.workspace.customerId, item.template_id)
    const { data, error } = await supabase.from('content_library_items').update({ template_name: template.name, template_language: template.language, template_status: template.status, updated_at: new Date().toISOString() }).eq('id', item.id).eq('customer_id', req.workspace.customerId).select().single()
    if (error) throw error
    res.json({ item: itemForClient(data) })
  } catch (error) { res.status(error.status || (error instanceof MetaTemplateError ? 502 : 400)).json({ error: error.message || 'Unable to refresh template reference' }) }
})

router.get('/:id/download', async (req, res) => {
  try {
    const item = await ownedItem(req.workspace.customerId, req.params.id)
    if (!['DOCUMENT','IMAGE'].includes(item.content_type) || !item.storage_path) return res.status(400).json({ error: 'This content does not have a file' })
    const { data, error } = await supabase.storage.from(CONTENT_BUCKET).createSignedUrl(item.storage_path, 300)
    if (error || !data?.signedUrl) throw new Error('Unable to prepare secure file access')
    res.json({ url: data.signedUrl, expires_in: 300 })
  } catch (error) { res.status(error.status || 500).json({ error: error.message || 'Unable to retrieve file' }) }
})

module.exports = router

