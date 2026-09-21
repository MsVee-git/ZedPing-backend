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
  const loop = { entry_step_key: 'select', steps: [
    { id: 'select', type: 'choose_option', text: 'Choose', choices: [
      { id: 'loop', label: 'Loop', next_step_id: 'a' },
      { id: 'end_choice', label: 'End', next_step_id: 'end' }
    ] },
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


const vehicleService = {
  entry_step_key: 'intro',
  steps: [
    { id: 'intro', type: 'send_message', text: 'Vehicle intro', next_step_id: 'vehicle' },
    { id: 'vehicle', type: 'ask_capture', text: 'What vehicle do you have?', next_step_id: 'service', capture: { key: 'vehicle', label: 'Vehicle', type: 'text', required: true, failure_action: 'handoff' } },
    { id: 'service', type: 'choose_option', text: 'What service?', choices: [
      { id: 'service', label: 'Vehicle Service', next_step_id: 'team' },
      { id: 'repairs', label: 'Repairs', next_step_id: 'team' }
    ] },
    { id: 'team', type: 'human_handoff', reason: 'Vehicle service enquiry' }
  ]
}

test('simulation advances valid text capture and waits at the next input step', () => {
  const result = simulateFlow(vehicleService, ['Ford Ranger'])
  assert.deepEqual(result.captured, { vehicle: 'Ford Ranger' })
  assert.equal(result.waiting_for_input, true)
  assert.equal(result.terminal, null)
  assert.deepEqual(result.transcript.map(item => [item.speaker, item.text]), [
    ['zedping', 'Vehicle intro'],
    ['zedping', 'What vehicle do you have?'],
    ['you', 'Ford Ranger'],
    ['zedping', 'What service?\n1. Vehicle Service\n2. Repairs']
  ])
})

test('simulation consumes a configured numbered choice and reaches handoff', () => {
  const result = simulateFlow(vehicleService, ['Ford Ranger', '1'])
  assert.deepEqual(result.captured, { vehicle: 'Ford Ranger' })
  assert.equal(result.terminal, 'human_handoff')
  assert.equal(result.waiting_for_input, false)
})

test('simulation retries one invalid answer and only hands off after a second invalid answer', () => {
  const first = simulateFlow(complete, ['bad-email'])
  assert.equal(first.waiting_for_input, true)
  assert.equal(first.terminal, null)
  assert.match(first.output.at(-1), /Enter a valid email address/)
  const second = simulateFlow(complete, ['bad-email', 'still-not-an-email'])
  assert.equal(second.terminal, 'handoff')
  assert.equal(second.waiting_for_input, false)
})

test('simulation content step continues without external writes', () => {
  const flow = { entry_step_key: 'content', steps: [
    { id: 'content', type: 'content', content_library_item_id: 'item', next_step_id: 'end' },
    { id: 'end', type: 'end', text: 'Done' }
  ] }
  const items = new Map([['item', { content_type: 'TEXT', archived_at: null }]])
  const result = simulateFlow(flow, [], { contentItems: items })
  assert.deepEqual(result.output, ['[Content Library item]', 'Done'])
  assert.equal(result.terminal, 'end')
})
