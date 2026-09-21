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


test('activated knowledge snapshots keep their original text after shared content is edited', () => {
  const { knowledgeSnapshot } = require('../lib/aiAgentKnowledge')
  const source = [{ id: 'content-a', name: 'Offers', text_content: 'Roll bar K6,500', content_type: 'TEXT', archived_at: null }]
  const frozen = knowledgeSnapshot(source)
  source[0].text_content = 'Roll bar K6,200'
  assert.deepEqual(frozen, [{ id: 'content-a', name: 'Offers', text_content: 'Roll bar K6,500' }])
})
