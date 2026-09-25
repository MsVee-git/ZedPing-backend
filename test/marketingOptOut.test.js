const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { isMarketingOptOutCommand, splitMarketingRecipients } = require('../lib/marketingOptOut')
const webhook = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhook.js'), 'utf8')
const broadcasts = fs.readFileSync(path.join(__dirname, '..', 'routes', 'broadcasts.js'), 'utf8')

test('recognizes only standalone marketing opt-out commands', () => {
  for (const value of ['STOP', ' stop ', 'STOP ALL', 'unsubscribe', 'CANCEL', 'END', 'QUIT']) assert.equal(isMarketingOptOutCommand(value), true)
  assert.equal(isMarketingOptOutCommand('Please stop sending promotions'), false)
  assert.equal(isMarketingOptOutCommand('Do not unsubscribe me'), false)
})

test('marketing eligibility excludes opted-out contacts without removing them', () => {
  const result = splitMarketingRecipients([{ id: 'ok', marketing_opted_out: false }, { id: 'out', marketing_opted_out: true }])
  assert.deepEqual(result.eligible.map(item => item.id), ['ok'])
  assert.deepEqual(result.optedOut.map(item => item.id), ['out'])
  assert.match(broadcasts, /filterWorkspaceMarketingRecipients\(supabase, workspace, audience\.recipients\)/)
  assert.match(broadcasts, /opted_out_recipients/)
})

test('STOP is processed after inbound persistence and before all automated runtimes', () => {
  const body = webhook.slice(webhook.indexOf('async function processMessage'), webhook.indexOf('\nasync function outgoing'))
  assert.ok(body.indexOf('claimInboundEvent') < body.indexOf('isMarketingOptOutCommand'))
  assert.ok(body.indexOf('isMarketingOptOutCommand') < body.indexOf('shouldSuppressAutomation'))
  assert.match(body, /marketing_opted_out: true/)
  assert.match(body, /whatsapp_stop/)
  assert.match(body, /unsubscribed from promotional WhatsApp messages/)
})
