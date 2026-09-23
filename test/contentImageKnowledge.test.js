const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { cleanReviewText, cleanReviewNotes, cleanDate, publicIngestion } = require('../lib/contentImageKnowledge')
const { eligibleRevision, knowledgeSnapshot } = require('../lib/aiAgentKnowledge')

test('image extraction remains reviewable until explicit approval', () => {
  const run = publicIngestion({ id:'run', status:'ready_for_review', extracted_text:'Roll Bar â K6,500', review_notes:['Confirm promotion end date'] })
  assert.equal(run.status, 'ready_for_review')
  assert.equal(run.revision, null)
  assert.equal(cleanReviewText(run.extracted_text), 'Roll Bar â K6,500')
})

test('review input is bounded and validity dates are explicit', () => {
  assert.deepEqual(cleanReviewNotes(['confirm price', '', '  readable date? ']), ['confirm price','readable date?'])
  assert.equal(cleanDate('2026-09-23','Valid from'), '2026-09-23')
  assert.equal(cleanDate('', 'Valid until'), null)
  assert.throws(() => cleanDate('2026-2-3','Valid from'), /invalid/)
  assert.throws(() => cleanReviewText('   '), /required/)
})

test('future and expired image knowledge is not eligible for new draft resolution', () => {
  assert.equal(eligibleRevision({ status:'approved', valid_from:'2999-01-01', valid_until:null }, '2026-09-23'), false)
  assert.equal(eligibleRevision({ status:'approved', valid_from:null, valid_until:'2020-01-01' }, '2026-09-23'), false)
  assert.equal(eligibleRevision({ status:'approved', valid_from:null, valid_until:null }, '2026-09-23'), true)
})

test('activated snapshot retains approved image provenance and immutable text', () => {
  const snapshot = knowledgeSnapshot([{ id:'source', name:'Accessories promo', text_content:'Roll Bar â K6,500', source_type:'image', knowledge_revision_id:'revision-a', provenance:{ source_type:'image', revision:1 } }])
  assert.deepEqual(snapshot[0], { id:'source', name:'Accessories promo', text_content:'Roll Bar â K6,500', source_type:'image', source_content_item_id:'source', knowledge_revision_id:'revision-a', provenance:{ source_type:'image', revision:1 } })
})

test('database contract prevents raw images, enforces workspace integrity, and restricts approval RPC', () => {
  const sql = fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260923130000_content_image_knowledge_ingestion.sql'),'utf8')
  assert.match(sql, /content_library_ingestions/)
  assert.match(sql, /ready_for_review/)
  assert.match(sql, /approve_content_image_knowledge/)
  assert.match(sql, /grant execute on function public\.approve_content_image_knowledge[\s\S]*to service_role/)
  assert.match(sql, /i\.content_type = 'IMAGE'/)
  assert.match(sql, /i\.content_type = 'TEXT'/)
  assert.match(sql, /r\.valid_until is null or r\.valid_until >= current_date/)
})

test('routes never attach raw image bytes as draft knowledge', () => {
  const routes = fs.readFileSync(path.join(__dirname,'../routes/aiAgents.js'),'utf8')
  assert.match(routes, /resolveEligibleKnowledge/)
  assert.match(routes, /approved knowledge item/)
  assert.doesNotMatch(routes, /storage_path/)
})
