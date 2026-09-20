const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

function loadWith(fakeSupabase) {
  const original = Module._load
  Module._load = (request, parent, isMain) => request === './supabase' && parent?.filename.endsWith('automationExecution.js') ? fakeSupabase : original(request, parent, isMain)
  delete require.cache[require.resolve('../lib/automationExecution')]
  try { return require('../lib/automationExecution') } finally { Module._load = original }
}

test('welcome claim is workspace + WhatsApp-number + contact scoped and completes only after a send result', async () => {
  const calls = []
  const fake = {
    from() { return {
      insert(row) { calls.push(['insert', row]); return Promise.resolve({ error: null }) },
      update(row) { calls.push(['update', row]); return { eq() { return this } } },
      delete() { calls.push(['delete']); return { eq() { return this } } }
    } }
  }
  const { claimWelcome, completeWelcome } = loadWith(fake)
  const ctx = { customerId: 'workspace-a', number: { id: 'number-a' }, contact: { id: 'contact-a' } }
  assert.equal(await claimWelcome(ctx, 'automation-a'), true)
  await completeWelcome(ctx, 'message-a')
  assert.deepEqual(calls[0][1], { customer_id: 'workspace-a', whatsapp_number_id: 'number-a', contact_id: 'contact-a', first_automation_id: 'automation-a', status: 'pending' })
  assert.equal(calls[1][1].status, 'sent')
  assert.equal(calls[1][1].outbound_message_id, 'message-a')
})

test('execution-event metadata excludes message content and identifiers outside relational columns', () => {
  const { safeMetadata } = loadWith({ from() { throw new Error('not used') } })
  assert.deepEqual(safeMetadata({ reason: 'outside_business_hours', message_body: 'do not store this', access_token: 'secret' }), { reason: 'outside_business_hours' })
})

