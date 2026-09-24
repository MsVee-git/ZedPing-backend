const express = require('express')
const multer = require('multer')
const router = express.Router()
const supabase = require('../lib/supabase')
const { requireAdmin } = require('../middleware/auth')
const { createMetaTemplateClient, MetaTemplateError } = require('../lib/metaTemplates')
const { CONTENT_BUCKET, TYPES, cleanText, safeUrl, assertFile, storagePath, itemForClient, editablePatch } = require('../lib/contentLibrary')
const { cleanReviewText, cleanReviewNotes, cleanDate, publicIngestion, extractForReview } = require('../lib/contentImageKnowledge')

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
  if (archived === 'all') return query
  return archived ? query.not('archived_at', 'is', null) : query.is('archived_at', null)
}

async function deletionDependencies(customerId, itemId) {
  const [agentKnowledge, automations, ingestions, flowDrafts, flowVersions, agentVersions] = await Promise.all([
    supabase.from('ai_agent_knowledge_items').select('id').eq('customer_id', customerId).eq('content_library_item_id', itemId).limit(1),
    supabase.from('automations').select('id').eq('customer_id', customerId).eq('content_library_item_id', itemId).limit(1),
    supabase.from('content_library_ingestions').select('id').eq('customer_id', customerId).eq('source_content_item_id', itemId).limit(1),
    supabase.from('chatbot_flows').select('id,draft_definition').eq('customer_id', customerId),
    supabase.from('chatbot_flow_versions').select('id,definition').eq('customer_id', customerId),
    supabase.from('ai_agent_configuration_versions').select('id,knowledge_snapshot').eq('customer_id', customerId)
  ])
  for (const result of [agentKnowledge, automations, ingestions, flowDrafts, flowVersions, agentVersions]) if (result.error) throw result.error
  const labels = []
  if (agentKnowledge.data?.length) labels.push('an AI Agent draft or configuration')
  if (automations.data?.length) labels.push('an automation')
  if (ingestions.data?.length) labels.push('image knowledge history')
  if ((flowDrafts.data || []).some(flow => JSON.stringify(flow.draft_definition || {}).includes(itemId))) labels.push('a chatbot flow draft')
  if ((flowVersions.data || []).some(version => JSON.stringify(version.definition || {}).includes(itemId))) labels.push('a chatbot flow version')
  if ((agentVersions.data || []).some(version => JSON.stringify(version.knowledge_snapshot || []).includes(itemId))) labels.push('an activated AI knowledge snapshot')
  return labels
}

async function ownedItem(customerId, id) {
  const { data, error } = await supabase.from('content_library_items').select('*').eq('id', id).eq('customer_id', customerId).maybeSingle()
  if (error) throw error
  if (!data) { const err = new Error('Content item not found'); err.status = 404; throw err }
  return data
}

async function ownedIngestion(customerId, id) {
  const { data, error } = await supabase.from('content_library_ingestions').select('*').eq('id', id).eq('customer_id', customerId).maybeSingle()
  if (error) throw error
  if (!data) { const err = new Error('Knowledge extraction not found'); err.status = 404; throw err }
  return data
}
async function latestRevision(customerId, ingestionId) {
  const { data, error } = await supabase.from('content_library_knowledge_revisions').select('*').eq('customer_id', customerId).eq('ingestion_id', ingestionId).order('approved_at', { ascending:false }).limit(1).maybeSingle()
  if (error) throw error
  return data || null
}
async function startExtraction(req, item) {
  if (item.archived_at || item.content_type !== 'IMAGE') throw new Error('Only an active Image item can be analyzed for Zoe')
  const { data: pending, error } = await supabase.from('content_library_ingestions').insert({
    customer_id:req.workspace.customerId, source_content_item_id:item.id, source_kind:'IMAGE', status:'pending', created_by:req.workspace.userId
  }).select().single()
  if (error) throw error
  const { data: run, error: processingError } = await supabase.from('content_library_ingestions').update({ status:'processing', updated_at:new Date().toISOString() }).eq('id',pending.id).eq('customer_id',req.workspace.customerId).select().single()
  if (processingError) throw processingError
  try {
    const extracted = await extractForReview(item)
    const { data, error:updateError } = await supabase.from('content_library_ingestions').update({ ...extracted, status:'ready_for_review', updated_at:new Date().toISOString() }).eq('id',run.id).eq('customer_id',req.workspace.customerId).select().single()
    if (updateError) throw updateError
    return publicIngestion(data)
  } catch (error) {
    await supabase.from('content_library_ingestions').update({ status:'failed', error_category:'extraction_unavailable', updated_at:new Date().toISOString() }).eq('id',run.id).eq('customer_id',req.workspace.customerId)
    throw new Error('We could not analyze this image. Please try Extract Again later.')
  }
}

router.get('/', async (req, res) => {
  try {
    const archived = req.query.archived === 'all' ? 'all' : req.query.archived === 'true'
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
    const patch = editablePatch(item, req.body)
    const { data, error } = await supabase.from('content_library_items').update(patch).eq('id', item.id).eq('customer_id', req.workspace.customerId).select().single()
    if (error) throw error
    res.json({ item: itemForClient(data) })
  } catch (error) {
    const safe = new Set(['Archived content cannot be edited', 'Invalid content update', 'Choose something to update', 'Name is required', 'Name is invalid', 'Name is too long', 'Description is invalid', 'Description is too long', 'Content is required', 'Content is invalid', 'Content is too long', 'Link URL is required', 'Link URL is invalid', 'Link URL is too long', 'Enter a valid http or https URL', 'Only http and https links are allowed', 'Text content cannot include a link update', 'Link content cannot include a text update', 'This content type cannot be edited that way'])
    res.status(error.status || 400).json({ error: safe.has(error.message) ? error.message : 'Unable to update content' })
  }
})

router.get('/:id/knowledge-ingestions', async (req,res) => {
  try {
    const item = await ownedItem(req.workspace.customerId, req.params.id)
    if (item.content_type !== 'IMAGE') return res.status(400).json({ error:'This is not an Image item' })
    const { data, error } = await supabase.from('content_library_ingestions').select('*').eq('customer_id',req.workspace.customerId).eq('source_content_item_id',item.id).order('created_at',{ascending:false}).limit(12)
    if (error) throw error
    const revisions = await Promise.all((data || []).map(run => latestRevision(req.workspace.customerId, run.id)))
    res.json({ ingestions:(data || []).map((run,index) => publicIngestion(run,revisions[index])) })
  } catch(error) { res.status(error.status || 500).json({error:error.message || 'Unable to load image knowledge'}) }
})

router.post('/:id/extract-knowledge', requireAdmin, async (req,res) => {
  try { res.status(201).json({ ingestion: await startExtraction(req, await ownedItem(req.workspace.customerId, req.params.id)) }) }
  catch(error) { res.status(error.status || 400).json({ error:error.message || 'Unable to analyze this image' }) }
})

router.patch('/knowledge-ingestions/:ingestionId/review', requireAdmin, async (req,res) => {
  try {
    const run = await ownedIngestion(req.workspace.customerId, req.params.ingestionId)
    if (run.status !== 'ready_for_review') throw new Error('Only information ready for review can be edited')
    const { data,error } = await supabase.from('content_library_ingestions').update({
      extracted_text:cleanReviewText(req.body?.extracted_text), review_notes:cleanReviewNotes(req.body?.review_notes), updated_at:new Date().toISOString()
    }).eq('id',run.id).eq('customer_id',req.workspace.customerId).select().single()
    if(error) throw error
    res.json({ingestion:publicIngestion(data)})
  } catch(error) { res.status(error.status || 400).json({error:error.message || 'Unable to save the reviewed information'}) }
})

router.post('/knowledge-ingestions/:ingestionId/approve', requireAdmin, async (req,res) => {
  try {
    const run = await ownedIngestion(req.workspace.customerId, req.params.ingestionId)
    if (run.status !== 'ready_for_review') throw new Error('This extraction is not ready for approval')
    const text = cleanReviewText(req.body?.extracted_text ?? run.extracted_text)
    const validFrom=cleanDate(req.body?.valid_from,'Valid from'), validUntil=cleanDate(req.body?.valid_until,'Valid until')
    if(validFrom && validUntil && validFrom > validUntil) throw new Error('Valid until cannot be before valid from')
    const { data,error } = await supabase.rpc('approve_content_image_knowledge', { p_customer_id:req.workspace.customerId, p_ingestion_id:run.id, p_text_content:text, p_valid_from:validFrom, p_valid_until:validUntil, p_actor_user_id:req.workspace.userId })
    if(error) throw error
    const approved=Array.isArray(data)?data[0]:data
    const refreshed=await ownedIngestion(req.workspace.customerId,run.id)
    res.json({ingestion:publicIngestion(refreshed,approved)})
  } catch(error) { res.status(error.status || 400).json({error:error.message || 'Unable to approve this information for Zoe'}) }
})

router.post('/knowledge-ingestions/:ingestionId/reject', requireAdmin, async (req,res) => {
  try {
    const run=await ownedIngestion(req.workspace.customerId,req.params.ingestionId)
    if(!['ready_for_review','failed'].includes(run.status)) throw new Error('This extraction cannot be rejected')
    const {data,error}=await supabase.from('content_library_ingestions').update({status:'rejected',reviewed_by:req.workspace.userId,reviewed_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',run.id).eq('customer_id',req.workspace.customerId).select().single()
    if(error) throw error
    res.json({ingestion:publicIngestion(data)})
  } catch(error){res.status(error.status||400).json({error:error.message||'Unable to reject this information'})}
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

router.post('/:id/restore', requireAdmin, async (req, res) => {
  try {
    const item = await ownedItem(req.workspace.customerId, req.params.id)
    if (!item.archived_at) return res.json({ item: itemForClient(item) })
    const { data, error } = await supabase.from('content_library_items').update({ archived_at: null, updated_at: new Date().toISOString() }).eq('id', item.id).eq('customer_id', req.workspace.customerId).select().single()
    if (error) throw error
    res.json({ item: itemForClient(data) })
  } catch (error) { res.status(error.status || 500).json({ error: error.message || 'Unable to restore content' }) }
})

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const item = await ownedItem(req.workspace.customerId, req.params.id)
    const dependencies = await deletionDependencies(req.workspace.customerId, item.id)
    if (dependencies.length) return res.status(409).json({ error: `This content is retained because it is used by ${dependencies.join(' and ')}. Archive it instead.`, dependencies })
    const { error } = await supabase.from('content_library_items').delete().eq('id', item.id).eq('customer_id', req.workspace.customerId)
    if (error) throw error
    if (item.storage_path) {
      const { error: storageError } = await supabase.storage.from(CONTENT_BUCKET).remove([item.storage_path])
      if (storageError) return res.json({ deleted: true, storage_cleanup: 'failed', warning: 'Content was deleted, but its private file needs cleanup. Contact support.' })
    }
    res.json({ deleted: true, storage_cleanup: 'complete' })
  } catch (error) { res.status(error.status || 500).json({ error: error.message || 'Unable to permanently delete content' }) }
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

