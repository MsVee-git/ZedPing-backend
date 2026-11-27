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

test('published flows allow up to ten WhatsApp choices and match choice identifiers', () => {
  const flow = validateDefinition(definition([choice('accounting', 'Accounting'), choice('computer', 'Computer skills')]))
  assert.equal(flow.steps[0].presentation, 'buttons')
  assert.equal(findChoice(flow.steps[0], 'computer').id, 'computer')
})

test('interactive flows reject more than ten choices while text choices remain compatible', () => {
  assert.throws(() => validateDefinition(definition([choice('one', 'One'), choice('two', 'Two'), choice('three', 'Three'), choice('four', 'Four'), choice('five', 'Five'), choice('six', 'Six'), choice('seven', 'Seven'), choice('eight', 'Eight'), choice('nine', 'Nine'), choice('ten', 'Ten'), choice('eleven', 'Eleven')])), /between 2 and 10/)
  assert.throws(() => validateDefinition(definition([choice('one', 'This list title is deliberately more than twenty four chars'), choice('two', 'Two'), choice('three', 'Three'), choice('four', 'Four')])), /24 characters/)
  assert.equal(validateDefinition(definition([choice('one', 'One'), choice('two', 'Two'), choice('three', 'Three'), choice('four', 'Four')], 'text')).steps[0].presentation, 'text')
})

test('Meta button replies become safe readable inbound flow input', () => {
  assert.deepEqual(parseInboundMedia({ type: 'interactive', interactive: { button_reply: { id: 'flow:course:computer', title: 'Computer skills' } } }), { body: 'Computer skills', media: null })
})

test('Gupshup sends buttons and list menus through the interactive provider API', async () => {
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
  const menu = await client.sendInteractiveList('app-123', { to: '260971234567', body: 'Choose one', rows: [{ id: 'flow:1:one', title: 'One' }, { id: 'flow:1:two', title: 'Two' }, { id: 'flow:1:three', title: 'Three' }, { id: 'flow:1:four', title: 'Four' }] })
  assert.equal(menu.status, 'accepted')
  const menuPayload = JSON.parse(calls[1].options.body)
  assert.equal(menuPayload.interactive.type, 'list')
  assert.equal(menuPayload.interactive.action.sections[0].rows.length, 4)
})

test('webhook uses the shared provider route for button choices', () => {
  const webhook = fs.readFileSync(require.resolve('../routes/webhook'), 'utf8')
  assert.match(webhook, /sendWorkspaceInteractiveButtons/)
  assert.match(webhook, /sendWorkspaceInteractiveList/)
  assert.match(webhook, /choices\.length <= 3/)
  assert.match(webhook, /continueFlow\(ctx, outgoing, outgoingChoice\)/)
  assert.match(webhook, /startFlow\(ctx, automation\.chatbot_flow_id, outgoing, outgoingChoice\)/)
})
