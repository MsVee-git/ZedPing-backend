const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { commercialTurn, normaliseCommercialAction, detectsCommercialIntent, commercialMetadata } = require('../lib/zoeCommercial')
const { configuredHandoff, handoffConfirmation } = require('../lib/zoeGrounding')

const config = {
  handoff: { person: true, unknown: true, quote_or_buy: true, phrases: [] },
  commercial_action: {
    type: 'quotation',
    qualification_fields: [
      'product_or_service',
      { key: 'vehicle_make', required: false },
      { key: 'vehicle_year', required: false }
    ],
    handoff_reason: 'Quotation requested'
  }
}

test('factual pricing and discovery remain outside the commercial route', () => {
  for (const message of ['How much is full body respray?', 'What does a tonneau cover cost?', 'Do you install bull bars?', 'How long does a respray take?']) {
    assert.equal(commercialTurn(config, message, [], null), null, message)
  }
})

test('a configured quotation request hands over once its product is known', () => {
  const turn = commercialTurn(config, 'Please quote me for a full body respray.', [], null)
  assert.equal(turn.kind, 'handoff')
  assert.equal(turn.reason, 'quotation_requested')
  assert.equal(turn.context.collected.product_or_service, 'full body respray')
})

test('contextual proceed intent uses bounded earlier product/pricing conversation', () => {
  const history = [
    { role: 'user', content: 'How much is full body respray?' },
    { role: 'assistant', content: 'A full body respray is K28,000 for a 4x4.' }
  ]
  const turn = commercialTurn(config, 'Okay, I want it for my Ranger.', history, null)
  assert.equal(turn.kind, 'handoff')
  assert.equal(turn.context.collected.product_or_service, 'full body respray')
})

test('proceed, booking, payment, order, and quantity intent are configuration-bound commercial candidates', () => {
  for (const message of ['How do I proceed?', 'I want to book this.', 'Where do I pay?', 'I want two of these.']) {
    const turn = commercialTurn(config, message, [{ role: 'user', content: 'How much is a roll bar?' }], null)
    assert.ok(turn, message)
  }
})

test('unknown commercial requests ask only for configured context and never invent a price or quotation', () => {
  const turn = commercialTurn(config, 'Can you quote me?', [], null)
  assert.equal(turn.kind, 'qualify')
  assert.equal(turn.reply, 'To help our team prepare the quotation, what product or service do you need?')
  assert.doesNotMatch(turn.reply, /K\d|price|confirmed|created/i)
})

test('vague interest does not prematurely create a commercial state', () => {
  assert.equal(commercialTurn(config, 'I am interested in your services.', [], null), null)
  assert.equal(detectsCommercialIntent('I am interested in your services.', []), false)
})

test('one required detail is collected naturally and is not requested twice', () => {
  const required = {
    commercial_action: { type: 'quotation', qualification_fields: [{ key: 'product_or_service', required: true }, { key: 'vehicle_year', required: true }] }
  }
  const first = commercialTurn(required, 'Can I get a quotation?', [], null)
  assert.equal(first.kind, 'qualify')
  assert.equal(first.context.pending_field, 'product_or_service')
  const second = commercialTurn(required, 'A full body respray.', [], first.context)
  assert.equal(second.kind, 'qualify')
  assert.equal(second.context.collected.product_or_service, 'A full body respray.')
  assert.equal(second.context.pending_field, 'vehicle_year')
  const third = commercialTurn(required, '2015', [], second.context)
  assert.equal(third.kind, 'handoff')
  assert.equal(third.context.collected.vehicle_year, '2015')
})

test('Test Agent can replay its bounded commercial qualification history without mutable state', () => {
  const first = commercialTurn(config, 'Can I get a quotation?', [], null)
  assert.equal(first.kind, 'qualify')
  const replay = commercialTurn(config, 'A roll bar.', [
    { role: 'user', content: 'Can I get a quotation?' },
    { role: 'assistant', content: first.reply }
  ], null)
  assert.equal(replay.kind, 'handoff')
  assert.equal(replay.context.collected.product_or_service, 'A roll bar.')
})

test('an immutable activated configuration, not the mutable agent draft, controls commercial handling', () => {
  const { buildLiveSystem } = require('../lib/zoeGrounding')
  const live = buildLiveSystem({ zoe_configuration: {} }, {
    configuration: { name: 'Assistant', configuration: config },
    knowledge_snapshot: [{ id: 'source', name: 'Services', text_content: 'Roll bars are available.' }]
  }, 'Can I get a quotation for a roll bar?')
  assert.equal(commercialTurn(live.configuration, 'Can I get a quotation for a roll bar?', [], null).kind, 'handoff')
})

test('businesses without immutable commercial configuration do not inherit quotation behavior', () => {
  assert.equal(commercialTurn({ handoff: { quote_or_buy: true } }, 'Can I get a quotation?', [], null), null)
  assert.equal(configuredHandoff({ handoff: { quote_or_buy: true } }, 'Can I get a quotation?'), null)
})

test('commercial context is bounded and event metadata contains only the configured safe fields', () => {
  const action = normaliseCommercialAction(config.commercial_action)
  assert.deepEqual(action.qualification_fields.map(field => field.key), ['product_or_service', 'vehicle_make', 'vehicle_year'])
  const turn = commercialTurn(config, 'Please quote me for a full body respray.', [], null)
  const metadata = commercialMetadata(turn.context)
  assert.deepEqual(metadata, { action_type: 'quotation', stage: 'ready_for_handoff', handoff_reason: 'Quotation requested', collected: { product_or_service: 'full body respray' } })
})

test('quotation handoff explicitly says the business team will prepare the quotation', () => {
  const message = handoffConfirmation('Example Motors', 'quotation_requested')
  assert.match(message, /Example Motors team/)
  assert.match(message, /prepare a quotation/)
  assert.match(message, /stay available here on WhatsApp/)
  assert.doesNotMatch(message, /shortly|immediately|within \d|minutes|hours/i)
})

test('runtime retains normal human takeover precedence and commercial handoff metadata', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhook.js'), 'utf8')
  assert.ok(source.indexOf('shouldSuppressAutomation(conversation)') < source.indexOf('checkAISession(ctx)'))
  assert.match(source, /commercialTurn\(live\.configuration, ctx\.body, history\.slice\(0, -1\), session\.commercial_context\)/)
  assert.match(source, /commercialContext\?\.handoff_reason \|\| 'Quotation requested'/)
  assert.match(source, /commercial_context:commercialMetadata\(commercialContext\)/)
  assert.match(source, /commercial_context: null/)
})

test('commercial handling preserves immutable activated configuration, inbound idempotency, and resolved-conversation routing', () => {
  const webhook = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhook.js'), 'utf8')
  const control = fs.readFileSync(path.join(__dirname, '..', 'lib', 'conversationState.js'), 'utf8')
  const liveVersion = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhook.js'), 'utf8')
  assert.match(webhook, /await claimInboundEvent\(ctx\)/)
  assert.ok(webhook.indexOf('await claimInboundEvent(ctx)') < webhook.indexOf('await checkAISession(ctx)'))
  assert.match(liveVersion, /not\('activated_at', 'is', null\)/)
  assert.match(liveVersion, /order\('version', \{ ascending: false \}\)/)
  assert.match(control, /conversation\.status === 'resolved'/)
  assert.match(control, /control_mode: 'automation'/)
})

test('configured commercial intent remains tenant and number scoped through the existing live session query', () => {
  const webhook = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhook.js'), 'utf8')
  const sessionLookup = webhook.slice(webhook.indexOf('async function checkAISession'), webhook.indexOf('\nmodule.exports = router'))
  assert.match(sessionLookup, /\.eq\('customer_id', ctx\.customerId\)/)
  assert.match(sessionLookup, /\.eq\('whatsapp_number_id', ctx\.number\.id\)/)
  assert.match(sessionLookup, /\.eq\('conversation_id', ctx\.conversation\.id\)/)
})

test('the migration is idempotent and keeps commercial state on the existing workspace-scoped session table', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260930103000_add_ai_session_commercial_context.sql'), 'utf8')
  assert.match(migration, /add column if not exists commercial_context jsonb/)
  assert.match(migration, /jsonb_typeof\(commercial_context\) = 'object'/)
  assert.doesNotMatch(migration, /create table/i)
})
