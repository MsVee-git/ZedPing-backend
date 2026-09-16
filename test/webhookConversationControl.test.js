const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('webhook checks conversation control before all automation engines', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhook.js'), 'utf8')
  const guard = source.indexOf('if (shouldSuppressAutomation(conversation)) return')
  assert.ok(guard > -1)
  assert.ok(guard < source.indexOf('if (await checkAISession(ctx)) return'))
  assert.ok(guard < source.indexOf('if (await checkFlowSession(ctx)) return'))
  assert.ok(guard < source.indexOf('await checkAutomations(ctx)'))
})

test('team inbox reply derives connection and contact from the conversation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'conversations.js'), 'utf8')
  assert.ok(source.includes(".eq('id', conversation.whatsapp_number_id).eq('customer_id', req.workspace.customerId)"))
  assert.ok(source.includes(".eq('id', conversation.contact_id).eq('customer_id', req.workspace.customerId)"))
  assert.equal(source.includes('req.body.phoneNumberId'), false)
  assert.equal(source.includes('req.body.waba'), false)
})
