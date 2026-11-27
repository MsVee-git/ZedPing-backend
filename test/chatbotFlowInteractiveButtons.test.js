const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { validateDefinition, findChoice } = require('../lib/chatbotRuntime')
const { parseInboundMedia } = require('../lib/inboundMedia')
const { createGupshupPartnerClient } = require('../lib/gupshupPartner')

function definition(choices, presentation = 'buttons') {
  return { entry_step_key: 'pick', steps: [
    { id: 'pick', type: 'choose_option', presentation, text: 'Choose one', choices },
    { id: 'end', type: 'end', text: '' }
  ] }
}
function choice(id, label) { return { id, label, aliases: [], next_step_id: 'end' } }

test('published flows allow two or three WhatsApp buttons and match choice identifiers', () => {
  const flow = validateDefinition(definition([choice('accounting', 'Accounting'), choice('computer', 'Computer skills')]))
  assert.equal(flow.steps[0].presentation, 'buttons')
  assert.equal(findChoice(flow.steps[0], 'computer').id, 'computer')
})

test('button flows reject unsupported WhatsApp shapes but text choices remain compatible', () => {
  assert.throws(() => validateDefinition(definition([choice('one', 'One'), choice('two', 'Two'), choice('three', 'Three'), choice('four', 'Four')])), /at most three/)
  assert.throws(() => validateDefinition(definition([choice('one', 'This label is deliberately longer than twenty characters'), choice('two', 'Two')])), /20 characters/)
  assert.equal(validateDefinition(definition([choice('one', 'One'), choice('two', 'Two'), choice('three', 'Three'), choice('four', 'Four')], 'text')).steps[0].presentation, 'text')
})

test('Meta button replies become safe readable inbound flow input', () => {
  assert.deepEqual(parseInboundMedia({ type: 'interactive', interactive: { button_reply: { id: 'flow:course:computer', title: 'Computer skills' } } }), { body: 'Computer skills', media: null })
})

test('Gupshup uses a WhatsApp interactive button payload', async () => {
  const calls = []
  const client = createGupshupPartnerClient({ universalToken: 'test-token', fetchImpl: async (url, options) => {
    calls.push({ url, options })
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.test' }] }) }
  } })
  const result = await client.sendInteractiveButtons('app-123', { to: '260971234567', body: 'Choose one', buttons: [{ id: 'flow:course:computer', title: 'Computer skills' }, { id: 'flow:course:accounting', title: 'Accounting' }] })
  assert.equal(result.status, 'accepted')
  const payload = JSON.parse(calls[0].options.body)
  assert.equal(payload.type, 'interactive')
  assert.equal(payload.interactive.type, 'button')
})

test('webhook uses the shared provider route for button choices', () => {
  const webhook = fs.readFileSync(require.resolve('../routes/webhook'), 'utf8')
  assert.match(webhook, /sendWorkspaceInteractiveButtons/)
  assert.match(webhook, /continueFlow\(ctx, outgoing, outgoingChoice\)/)
  assert.match(webhook, /startFlow\(ctx, automation\.chatbot_flow_id, outgoing, outgoingChoice\)/)
})
