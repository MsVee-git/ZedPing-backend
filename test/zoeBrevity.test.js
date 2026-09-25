const test = require('node:test')
const assert = require('node:assert/strict')
const { buildLiveSystem, configuredHandoff, handoffReply, handoffConfirmation, isCustomerSafeReply } = require('../lib/zoeGrounding')
const version = { configuration: { name: 'Example assistant', configuration: { handoff: { unknown: true, quote_or_buy: true } } }, knowledge_snapshot: [{ id: 'fact', name: 'Services', text_content: 'Resprays use PPG Envirobase. Pricing requires an assessment.' }] }
test('WhatsApp generation instructions require short answers, one question and requested detail', () => {
  const { prompt } = buildLiveSystem({}, version)
  for (const expected of ['1–3 short sentences', 'short paragraphs', 'actual question first', 'at most ONE useful follow-up question', 'do not list every known fact', 'explicitly asks for detail', 'Use conversation history', 'never sacrifice factual safety']) assert.ok(prompt.includes(expected), expected)
})
test('brevity preserves snapshot facts and safety rather than cutting generated text', () => {
  const before = structuredClone(version)
  const { prompt, knowledge } = buildLiveSystem({}, version)
  assert.equal(knowledge[0].text_content, version.knowledge_snapshot[0].text_content)
  assert.match(prompt, /Only use the approved information/)
  assert.match(prompt, /Do not invent prices, stock, availability, bookings, quotes/)
  assert.match(prompt, /Do not promise a response time/)
  assert.deepEqual(version, before)
})
test('handoff remains explicit, concise and customer-facing without a timing promise', () => {
  const confirmation = handoffConfirmation('Example Motors')
  assert.equal(confirmation, "I'll hand you over to the Example Motors team for further assistance. Please stay available here on WhatsApp.")
  for (const [reason, question] of [['commercial_request', 'I need a quotation'], ['commercial_request', 'I want to buy'], ['customer_requested_handoff', 'A person please'], ['no_approved_answer', 'What is the price?']]) {
    const response = handoffReply(reason, question) + '\n\n' + confirmation
    assert.equal(isCustomerSafeReply(response), true)
    assert.ok(response.split(/\s+/).length <= 40)
    assert.doesNotMatch(response, /\bhandoff\b|escalation|AI agent|knowledge base|grounding|within|shortly/i)
  }
  assert.equal(configuredHandoff(version.configuration.configuration, 'I need a quotation'), 'commercial_request')
})
