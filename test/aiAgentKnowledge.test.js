const test = require('node:test')
const assert = require('node:assert/strict')
const { activeTextKnowledge } = require('../lib/aiAgentKnowledge')

test('editable draft knowledge excludes archived and non-Text items', () => {
  const rows = [
    { content_library_items:{ id:'old',name:'Offers',content_type:'TEXT',archived_at:'2026-09-21T00:00:00Z' } },
    { content_library_items:{ id:'image',name:'Promo image',content_type:'IMAGE',archived_at:null } },
    { content_library_items:{ id:'new',name:'Promo text',content_type:'TEXT',archived_at:null } }
  ]
  assert.deepEqual(activeTextKnowledge(rows).map(item => item.id), ['new'])
})


test('activated knowledge snapshots keep complete chunked source text after shared content is edited', () => {
  const { knowledgeSnapshot } = require('../lib/aiAgentKnowledge')
  const source = [{ id: 'content-a', name: 'Offers', text_content: 'Roll bar K6,500', content_type: 'TEXT', archived_at: null }]
  const frozen = knowledgeSnapshot(source)
  source[0].text_content = 'Roll bar K6,200'
  assert.equal(frozen.length, 1)
  assert.equal(frozen[0].id, 'content-a')
  assert.equal(frozen[0].source_content_item_id, 'content-a')
  assert.equal(frozen[0].chunk_id, 'content-a:text:1')
  assert.equal(frozen[0].text_content, 'Roll bar K6,500')
})

test('approved documents ground replies independently of attachment permission', async () => {
  const { resolveEligibleKnowledge, knowledgeSnapshot } = require('../lib/aiAgentKnowledge')
  const { buildLiveSystem } = require('../lib/zoeGrounding')
  const items = [
    { id: 'guide', name: 'Business guide', content_type: 'DOCUMENT' },
    { id: 'pending', content_type: 'DOCUMENT' },
    { id: 'expired', content_type: 'DOCUMENT' },
    { id: 'archived', content_type: 'DOCUMENT', archived_at: '2000-01-01' },
    { id: 'foreign', content_type: 'DOCUMENT', customer_id: 'other' }
  ]
  const approved = { customer_id: 'workspace', status: 'approved', valid_from: '2000-01-01', approved_at: '2000-01-01' }
  const revisions = [
    { ...approved, source_content_item_id: 'guide', id: 'revision-1', revision: 1, text_content: 'General information. '.repeat(220) + '\nOur weekday catering capacity is 80 guests.' },
    { ...approved, source_content_item_id: 'pending', status: 'ready_for_review' },
    { ...approved, source_content_item_id: 'expired', valid_until: '2001-01-01' },
    { ...approved, source_content_item_id: 'archived' },
    { ...approved, source_content_item_id: 'foreign', customer_id: 'other' }
  ]
  const supabase = {
    from(table) {
      let rows = table === 'content_library_items'
        ? items.map(item => ({ customer_id: 'workspace', archived_at: null, ...item }))
        : revisions
      return {
        select() { return this },
        eq(key, value) { rows = rows.filter(row => row[key] === value); return this },
        is(key, value) { return this.eq(key, value) },
        async in(key, values) { return { data: rows.filter(row => values.includes(row[key])) } }
      }
    }
  }
  const sources = await resolveEligibleKnowledge(supabase, 'workspace', items.map(item => item.id))
  assert.deepEqual(sources.map(item => item.id), ['guide'])
  const snapshot = knowledgeSnapshot(sources)
  assert.equal(snapshot.map(chunk => chunk.text_content).join(''), revisions[0].text_content)
  assert.ok(snapshot.every(chunk => chunk.source_type === 'document' && chunk.knowledge_revision_id === 'revision-1'))
  const version = { knowledge_snapshot: snapshot, configuration: { configuration: { shareable_content_item_ids: [] } } }
  assert.match(buildLiveSystem({}, version, 'What is your weekday catering capacity?').prompt, /80 guests/)
})
