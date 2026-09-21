const test = require('node:test')
const assert = require('node:assert/strict')
const { validateDefinition, validateCapture, findChoice, simulateFlow } = require('../lib/chatbotRuntime')

const complete = {
  entry_step_key: 'welcome',
  steps: [
    { id: 'welcome', type: 'send_message', text: 'Welcome', next_step_id: 'email' },
    { id: 'email', type: 'ask_capture', text: 'Your email?', next_step_id: 'service', capture: { key: 'email', label: 'Email', type: 'email', required: true, failure_action: 'handoff' } },
    { id: 'service', type: 'choose_option', text: 'Choose', choices: [
      { id: 'service_a', label: 'Service', aliases: ['repair'], next_step_id: 'done' },
      { id: 'service_b', label: 'Human', outcome: 'human_handoff' }
    ] },
    { id: 'done', type: 'end', text: 'Thanks' }
  ]
}

test('valid published definition has deterministic capture and choices', () => {
  const definition = validateDefinition(complete)
  assert.equal(definition.steps.length, 4)
  assert.equal(findChoice(definition.steps[2], '1').id, 'service_a')
  assert.equal(findChoice(definition.steps[2], 'repair').id, 'service_a')
  assert.equal(findChoice(definition.steps[2], 'unknown'), null)
})

test('capture validation supports approved types', () => {
  assert.equal(validateCapture('a@b.co', { type: 'email', required: true }).ok, true)
  assert.equal(validateCapture('bad', { type: 'email', required: true }).ok, false)
  assert.equal(validateCapture('+260 770 123 456', { type: 'phone', required: true }).value, '+260770123456')
  assert.equal(validateCapture('not-a-date', { type: 'date', required: true }).ok, false)
  assert.equal(validateCapture('2026-09-21', { type: 'date', required: true }).ok, true)
  assert.equal(validateCapture('3.5', { type: 'number', required: true }).value, 3.5)
})

test('publish rejects ambiguous choices and automatic loops', () => {
  const duplicate = structuredClone(complete)
  duplicate.steps[2].choices[1] = { id: 'duplicate', label: 'Service', outcome: 'end' }
  assert.throws(() => validateDefinition(duplicate), /unambiguous/)
  const loop = { entry_step_key: 'a', steps: [
    { id: 'a', type: 'send_message', text: 'A', next_step_id: 'b' },
    { id: 'b', type: 'send_message', text: 'B', next_step_id: 'a' },
    { id: 'end', type: 'end' }
  ] }
  assert.throws(() => validateDefinition(loop), /automatic message loop/)
})

test('pure test simulation never needs a WhatsApp send or database write', () => {
  const result = simulateFlow(complete, ['person@example.com', '1'])
  assert.deepEqual(result.captured, { email: 'person@example.com' })
  assert.equal(result.terminal, 'end')
  assert.deepEqual(result.output, ['Welcome', 'Your email?', 'Choose\n1. Service\n2. Human', 'Thanks'])
})

test('content references must be active workspace Text or Link items', () => {
  const flow = { entry_step_key: 'content', steps: [
    { id: 'content', type: 'content', content_library_item_id: 'item', next_step_id: 'end' },
    { id: 'end', type: 'end' }
  ] }
  assert.throws(() => validateDefinition(flow, { contentItems: new Map() }), /active workspace Text or Link/)
  const valid = validateDefinition(flow, { contentItems: new Map([['item', { content_type: 'TEXT', archived_at: null }]]) })
  assert.equal(valid.steps[0].type, 'content')
})
