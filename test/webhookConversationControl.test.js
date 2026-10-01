const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('webhook checks conversation control before all automation engines', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhook.js'), 'utf8')
  const guard = source.indexOf('if (shouldSuppressAutomation(conversation))')
  assert.ok(guard > -1)
  assert.ok(guard < source.indexOf('if (await checkAISession(ctx)) return'))
  assert.ok(guard < source.indexOf('if (await continueFlow(ctx, outgoing)) return'))
  assert.ok(guard < source.indexOf('await checkAutomations(ctx)'))
})

test('webhook persists incoming image metadata while retaining the existing Meta idempotency claim', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhook.js'), 'utf8')
  assert.ok(source.includes("const { parseInboundMedia } = require('../lib/inboundMedia')"))
  assert.ok(source.includes('const parsed = parseInboundMedia(incoming)'))
  assert.ok(source.includes('media: parsed.media'))
  assert.ok(source.includes('inbound_media: ctx.media'))
  assert.ok(source.indexOf('if (!(await claimInboundEvent(ctx))) return') < source.indexOf('const contact = await findOrCreateContact(ctx)'))
})

test('team inbox reply derives connection and contact from the conversation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'conversations.js'), 'utf8')
  assert.ok(source.includes(".eq('id', conversation.whatsapp_number_id).eq('customer_id', req.workspace.customerId)"))
  assert.ok(source.includes(".eq('id', conversation.contact_id).eq('customer_id', req.workspace.customerId)"))
  assert.equal(source.includes('req.body.phoneNumberId'), false)
  assert.equal(source.includes('req.body.waba'), false)
})

test('take operation is conditional so a concurrent user cannot overwrite the assignee', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'conversations.js'), 'utf8')
  assert.ok(source.includes(".eq('status', fromAutomation ? 'open' : 'needs_attention')"))
  assert.ok(source.includes(".eq('control_mode', fromAutomation ? 'automation' : 'needs_attention')"))
  assert.ok(source.includes('assigned_user_id.is.null,assigned_user_id.eq.'))
  assert.ok(source.includes('return res.status(409)'))
})
