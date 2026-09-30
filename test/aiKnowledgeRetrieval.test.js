const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { TEXT_CHUNK_CHARS, knowledgeSnapshot, draftDiffersFromActivated } = require('../lib/aiAgentKnowledge')
const { selectRelevantKnowledge, knowledgeContext, buildLiveSystem } = require('../lib/zoeGrounding')

function catalogue() {
  const prefix = 'Accessories and fabrication services. '.repeat(120)
  const pricing = 'SPRAY PAINTING\nSALOON VEHICLES\nFull Body Respray\nPrice: K20,000\nPICK-UP / 4X4 VEHICLES\nFull Body Respray\nPrice: K28,000\n'
  return {
    id: 'catalogue-a',
    name: 'Official price list and services catalogue',
    content_type: 'TEXT',
    text_content: prefix + pricing + 'Additional catalogue notes.'
  }
}

function versionFrom(items) {
  return {
    configuration: { name: 'Workshop assistant', configuration: { knowledge_limits: { max_context_chars: 10000 }, handoff: { unknown: true } } },
    knowledge_snapshot: knowledgeSnapshot(items)
  }
}

test('activation snapshots preserve all source text in deterministic provenance chunks', () => {
  const source = catalogue()
  const snapshot = knowledgeSnapshot([source])
  assert.ok(source.text_content.length > 3000)
  assert.equal(snapshot.map(chunk => chunk.text_content).join(''), source.text_content)
  assert.ok(snapshot.length >= 3)
  assert.equal(snapshot[0].chunk_id, 'catalogue-a:text:1')
  assert.equal(snapshot.at(-1).chunk_id, 'catalogue-a:text:' + snapshot.length)
  assert.ok(snapshot.every(chunk => chunk.source_content_item_id === 'catalogue-a' && chunk.text_content.length <= TEXT_CHUNK_CHARS))
})

test('late full-body-respray pricing is selected ahead of unrelated earlier chunks', () => {
  const version = versionFrom([catalogue()])
  const selected = selectRelevantKnowledge(version, 'How much is full body respray?')
  assert.ok(selected.length)
  assert.match(selected[0].text_content, /Full Body Respray[\s\S]*K20,000/)
  assert.ok(selected[0].chunk_index > 0)
})

test('deterministic selection does not prefer an irrelevant source over clear lexical support', () => {
  const version = versionFrom([
    { id: 'irrelevant', name: 'General services', content_type: 'TEXT', text_content: 'We offer accessories and routine services.' },
    catalogue()
  ])
  const selected = selectRelevantKnowledge(version, 'How much is full body respray?')
  assert.equal(selected[0].source_content_item_id, 'catalogue-a')
})

test('selected knowledge context stays within the configured ceiling', () => {
  const version = versionFrom(Array.from({ length: 5 }, (_, index) => ({
    id: 'source-' + index,
    name: 'Source ' + index,
    content_type: 'TEXT',
    text_content: ('respray price information ' + index + ' ').repeat(700)
  })))
  const selected = selectRelevantKnowledge(version, 'What is the respray price?', 10000)
  const context = knowledgeContext(selected, 10000)
  assert.ok(context.text.length <= 10000)
  assert.ok(context.knowledge.length < version.knowledge_snapshot.length)
})

test('Test and Live use the same immutable chunk-selection semantics', () => {
  const version = versionFrom([catalogue()])
  const agent = { name: 'Workshop assistant', zoe_configuration: version.configuration.configuration }
  const question = 'How much is full body respray?'
  const live = buildLiveSystem(agent, version, question)
  const testMode = buildLiveSystem(agent, { configuration: version.configuration, knowledge_snapshot: version.knowledge_snapshot }, question)
  assert.deepEqual(testMode.knowledge, live.knowledge)
  assert.equal(testMode.prompt, live.prompt)
  assert.match(live.prompt, /K20,000/)
})

test('draft changes do not alter an immutable activated version and expose divergence', () => {
  const activeSource = { id: 'active-source', name: 'Active', content_type: 'TEXT', text_content: 'Original price K20,000' }
  const draftSource = { id: 'draft-source', name: 'Draft', content_type: 'TEXT', text_content: 'Draft price K28,000' }
  const configuration = { name: 'Workshop assistant', configuration: { handoff: { unknown: true } }, whatsapp_number_id: 'number-a' }
  const activated = { configuration, knowledge_snapshot: knowledgeSnapshot([activeSource]) }
  const historical = JSON.parse(JSON.stringify(activated))
  assert.equal(draftDiffersFromActivated(activated, configuration, [activeSource]), false)
  assert.equal(draftDiffersFromActivated(activated, configuration, [draftSource]), true)
  assert.deepEqual(activated, historical)
})

test('knowledge resolution remains workspace-scoped and live retrieval uses inbound question', () => {
  const knowledgeSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'aiAgentKnowledge.js'), 'utf8')
  const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhook.js'), 'utf8')
  const agentsSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'aiAgents.js'), 'utf8')
  assert.match(knowledgeSource, /\.eq\('customer_id',customerId\)/)
  assert.match(runtimeSource, /buildLiveSystem\(agent, version, ctx\.body\)/)
  assert.match(agentsSource, /changes_not_live_yet/)
  assert.match(agentsSource, /draftDiffersFromActivated/)
})
