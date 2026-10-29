const test = require('node:test')
const assert = require('node:assert/strict')
const { supported, snapshot, attachmentDecision, resolveAttachments, fileForAttachment } = require('../lib/contentLibraryAttachments')
const { storedAttachment } = require('../lib/conversationMedia')

const idA = '11111111-1111-4111-8111-111111111111'
const idB = '22222222-2222-4222-8222-222222222222'
function image(id = idA, overrides = {}) { return { id, name:'Dinner menu', description:'Current restaurant menu', content_type:'IMAGE', storage_path:`workspace/${id}/menu.png`, original_file_name:'menu.png', mime_type:'image/png', file_size:1234, archived_at:null, ...overrides } }
function pdf(id = idB, overrides = {}) { return { id, name:'Catering menu', description:'Catering options', content_type:'DOCUMENT', storage_path:`workspace/${id}/catering.pdf`, original_file_name:'catering.pdf', mime_type:'application/pdf', file_size:4321, archived_at:null, ...overrides } }

test('only active supported Content Library images and PDFs can be shared', () => {
  assert.equal(supported(image()), true)
  assert.equal(supported(pdf()), true)
  assert.equal(supported(pdf(idB, { mime_type:'application/msword' })), false)
  assert.equal(supported(image(idA, { archived_at:'2026-01-01T00:00:00Z' })), false)
  assert.equal(snapshot(pdf()).storage_path.endsWith('catering.pdf'), true)
})

test('AI attachment matching only auto-selects one explicit file and asks when multiple match', () => {
  const menu = snapshot(image())
  const catering = snapshot(pdf())
  assert.deepEqual(attachmentDecision([menu, catering], 'Can I see your dinner menu?'), { kind:'selected', item:menu })
  assert.equal(attachmentDecision([menu, catering], 'What are your opening hours?').kind, 'none')
  const first = { ...menu, name:'Menu A', description:'menu' }
  const second = { ...catering, name:'Menu B', description:'menu' }
  assert.equal(attachmentDecision([first, second], 'Please send the menu').kind, 'ambiguous')
})

test('attachment resolution is workspace-scoped and rejects an unavailable selected file', async () => {
  const calls=[]
  const supabase={from(){return {select(){return this},eq(){return this},is(){return this},in(_, ids){calls.push(ids);return Promise.resolve({data:[image()],error:null})}}}}
  await assert.rejects(() => resolveAttachments(supabase, 'workspace', [idA,idB]), /active Image or PDF/)
  assert.deepEqual(calls[0], [idA,idB])
})

test('file resolution refuses archived or changed attachment snapshots before a provider call', async () => {
  const item = image()
  const supabase={
    from(){return {select(){return this},eq(){return this},is(){return this},maybeSingle(){return Promise.resolve({data:{...item, archived_at:'2026-01-01T00:00:00Z'},error:null})}}},
    storage:{from(){return {download(){throw new Error('must not download')}}}}
  }
  await assert.rejects(() => fileForAttachment(supabase, 'workspace', snapshot(item)), /no longer available/)
})

test('a Content Library outgoing preview supports an opaque Gupshup media ID through its private storage path', () => {
  const attachment = storedAttachment({ type:'document', media_id:'gupshup-opaque-media-id', mime_type:'application/pdf', filename:'menu.pdf', content_library_storage_path:'workspace/menu.pdf' })
  assert.equal(attachment.storagePath, 'workspace/menu.pdf')
  assert.equal(attachment.mediaId, 'gupshup-opaque-media-id')
})
