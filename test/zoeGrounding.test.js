const test = require('node:test')
const assert = require('node:assert/strict')
const { buildLiveSystem, configuredHandoff, handoffReply, isCustomerSafeReply, hasNaturalTeamTransition, lacksLexicalSupport, removeHandoffMarker, requestsModelHandoff } = require('../lib/zoeGrounding')

const agent = { name:'AutoGuard Assistant', zoe_configuration:{ communication_style:'warm', handoff:{ person:true, unknown:true, quote_or_buy:true, phrases:['complaint'] } } }
const version = { configuration:{ name:'AutoGuard Assistant', configuration:agent.zoe_configuration }, knowledge_snapshot:[{id:'safe-id',name:'Services',text_content:'We provide vehicle servicing and resprays.'}] }

test('explicit human and commercial requests are deterministic handoffs', () => {
  assert.equal(configuredHandoff(agent.zoe_configuration, 'Can I speak to someone?'), 'customer_requested_handoff')
  assert.equal(configuredHandoff(agent.zoe_configuration, 'Can I get a quotation?'), 'commercial_request')
  assert.equal(configuredHandoff(agent.zoe_configuration, 'This is a complaint'), 'configured_handoff_phrase')
})

test('unknown query is recognized without treating injected knowledge as proof', () => {
  const live = buildLiveSystem(agent, version)
  assert.equal(lacksLexicalSupport('How much are tonneau covers?', live.knowledge), true)
  assert.equal(lacksLexicalSupport('Tell me about vehicle servicing', live.knowledge), false)
  assert.match(live.prompt, /Only use the approved information/)
  assert.doesNotMatch(live.prompt, /safe-id/)
})

test('handoff marker is never exposed to a customer', () => {
  assert.equal(requestsModelHandoff('I can help [[HANDOFF]]'), true)
  assert.equal(removeHandoffMarker('I can help [[HANDOFF]]'), 'I can help')
})


test('deterministic handoff replies are natural and never expose internal terminology', () => {
  const cases = [
    handoffReply('no_approved_answer', 'How much are tonneau covers?'),
    handoffReply('customer_requested_handoff', 'Can I speak to someone?'),
    handoffReply('commercial_request', 'Can I get a quotation for a bumper?'),
    handoffReply('no_approved_answer', 'Will this fit my 2020 Ranger?'),
    handoffReply('no_approved_answer', 'Can you assess my vehicle?')
  ]
  for (const reply of cases) {
    assert.equal(isCustomerSafeReply(reply), true)
    assert.equal(hasNaturalTeamTransition(reply), true)
  }
  assert.equal(isCustomerSafeReply('My approved knowledge says I need a human agent for this handoff.'), false)
  assert.equal(isCustomerSafeReply('This needs escalation from the AI agent.'), false)
})

test('known questions remain available for normal answers while partial answers are instructed to connect the team', () => {
  const live = buildLiveSystem(agent, version)
  assert.equal(configuredHandoff(agent.zoe_configuration, 'Tell me about vehicle servicing'), null)
  assert.equal(lacksLexicalSupport('Tell me about vehicle servicing', live.knowledge), false)
  assert.match(live.prompt, /give any directly supported part of the answer first/)
  assert.match(live.prompt, /Let me connect you with them/)
})
