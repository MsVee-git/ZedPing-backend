const { templateKnowledge } = require('./templateKnowledge')
const TEXT_CHUNK_CHARS = 2000

function today() { return new Date().toISOString().slice(0, 10) }
function eligibleRevision(revision, date = today()) {
  return revision && revision.status === 'approved' && (!revision.valid_from || revision.valid_from <= date) && (!revision.valid_until || revision.valid_until >= date)
}
function activeTextKnowledge(rows) {
  return (rows || []).map(row => row?.content_library_items || row).filter(item => item && item.content_type === 'TEXT' && !item.archived_at)
}

function textChunks(item) {
  const text = String(item?.text_content || '')
  const sourceType = item.source_type || String(item.content_type || 'text').toLowerCase()
  const sourceId = item?.source_content_item_id || item?.id
  const count = Math.ceil(text.length / TEXT_CHUNK_CHARS)
  return Array.from({ length: count }, (_, index) => ({
    id: sourceId,
    source_content_item_id: sourceId,
    chunk_id: String(sourceId) + ':' + sourceType + ':' + (index + 1),
    chunk_index: index,
    chunk_count: count,
    name: item.name,
    text_content: text.slice(index * TEXT_CHUNK_CHARS, (index + 1) * TEXT_CHUNK_CHARS),
    source_type: sourceType,
    ...(item.knowledge_revision_id ? { knowledge_revision_id: item.knowledge_revision_id } : {}),
    provenance: { ...(item.provenance || {}), source_type: sourceType, source_content_item_id: sourceId, chunk_index: index, chunk_count: count }
  })).filter(chunk => chunk.text_content)
}

function knowledgeSnapshot(items) {
  return (items || []).flatMap(item => {
    const sourceType = item.source_type || String(item.content_type || '').toLowerCase()
    if (['text', 'template', 'document'].includes(sourceType)) return textChunks(item)
    const snapshot={ id:item.id, name:item.name, text_content:String(item.text_content || '').slice(0,3000) }
    if (sourceType === 'image') {
      snapshot.source_type='image'
      snapshot.source_content_item_id=item.source_content_item_id || item.id
      snapshot.knowledge_revision_id=item.knowledge_revision_id || null
      snapshot.provenance=item.provenance || null
    }
    return [snapshot]
  })
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}'
  return JSON.stringify(value)
}

function draftDiffersFromActivated(version, configuration, knowledge) {
  if (!version) return true
  return stableJson(version.configuration || {}) !== stableJson(configuration || {}) ||
    stableJson(version.knowledge_snapshot || []) !== stableJson(knowledgeSnapshot(knowledge))
}

async function resolveEligibleKnowledge(supabase, customerId, itemIds, options = {}) {
  const ids=[...new Set((itemIds || []).filter(Boolean))]
  if(!ids.length) return []
  const {data:items,error}=await supabase.from('content_library_items').select('id,name,text_content,content_type,archived_at,updated_at,description,template_id').eq('customer_id',customerId).is('archived_at',null).in('id',ids)
  if(error) throw error
  let templates=[];
  if((items||[]).some(item=>item.content_type==='WHATSAPP_TEMPLATE_REFERENCE')) {
    const loadTemplates=options.loadTemplates || require('./workspaceTemplates').loadWorkspaceTemplates;
    const catalog=await loadTemplates(customerId);
    templates=catalog.kind==='ok'?catalog.templates||[]:[];
  }
  const fileIds = (items || []).filter(item => ['IMAGE', 'DOCUMENT'].includes(item.content_type)).map(item => item.id)
  let revisions=[]
  if(fileIds.length){
    const {data,error:revisionError}=await supabase.from('content_library_knowledge_revisions').select('id,source_content_item_id,text_content,valid_from,valid_until,status,approved_at,revision').eq('customer_id',customerId).eq('status','approved').in('source_content_item_id',fileIds)
    if(revisionError) throw revisionError
    revisions=(data||[]).filter(revision => eligibleRevision(revision))
  }
  return ids.map(id=>{
    const item=(items||[]).find(entry=>entry.id===id)
    if(!item) return null
    if(item.content_type==='TEXT' && String(item.text_content||'').trim()) return {...item,source_type:'text',source_content_item_id:item.id,provenance:{source_type:'text'}}
    if(item.content_type==='WHATSAPP_TEMPLATE_REFERENCE')return templateKnowledge(item,templates.find(template=>String(template.id)===String(item.template_id)))
    if (['IMAGE', 'DOCUMENT'].includes(item.content_type)) {
      const sourceType = item.content_type.toLowerCase()
      const revision=revisions.filter(entry=>entry.source_content_item_id===item.id).sort((a,b)=>String(b.approved_at).localeCompare(String(a.approved_at)))[0]
      if(revision) return {...item,text_content:revision.text_content,source_type:sourceType,source_content_item_id:item.id,knowledge_revision_id:revision.id,valid_from:revision.valid_from,valid_until:revision.valid_until,provenance:{source_type:sourceType,revision:revision.revision}}
    }
    return null
  }).filter(Boolean)
}

module.exports = { TEXT_CHUNK_CHARS, activeTextKnowledge, textChunks, knowledgeSnapshot, stableJson, draftDiffersFromActivated, eligibleRevision, resolveEligibleKnowledge }
