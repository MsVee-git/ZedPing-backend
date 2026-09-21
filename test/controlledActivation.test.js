const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizePhone } = require('../lib/contactImport')
const { configuredHandoff, lacksLexicalSupport, buildLiveSystem } = require('../lib/zoeGrounding')

test('Zambia allowlist and inbound variants normalize to one E.164 value', () => {
  const expected = '+260978748066'
  for (const input of ['0978748066', '978748066', '260978748066', '+260978748066']) {
    assert.equal(normalizePhone(input), expected)
  }
})

test('controlled live safety keeps explicit handoff and unknown-answer decisions deterministic', () => {
  const agent={name:'Assistant',zoe_configuration:{handoff:{person:true,unknown:true,quote_or_buy:true},communication_style:'professional'}}
  const version={configuration:{name:'Assistant',configuration:agent.zoe_configuration},knowledge_snapshot:[{id:'item',name:'Services',text_content:'Vehicle service information'}]}
  const live=buildLiveSystem(agent,version)
  assert.equal(configuredHandoff(live.configuration,'Can I speak to someone?'),'customer_requested_handoff')
  assert.equal(lacksLexicalSupport('How much are tonneau covers?',live.knowledge),true)
})
