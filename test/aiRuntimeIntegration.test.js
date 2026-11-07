const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

test('AI management is workspace-protected and owner/admin-only', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'aiAgents.js'), 'utf8')
  assert.ok(source.includes('router.post(\'/drafts\', requireAdmin'))
  assert.ok(source.includes('router.patch(\'/:id/draft\', requireAdmin'))
  assert.ok(source.includes(".eq('customer_id', req.workspace.customerId)"))
  assert.equal(source.includes('req.body.customer_id'), false)
  assert.equal(source.includes('req.body.model'), false)
})

test('AI runtime is evaluated after Team Inbox suppression and before Flow execution', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhook.js'), 'utf8')
  assert.ok(source.indexOf('shouldSuppressAutomation(conversation)') < source.indexOf('checkAISession(ctx, followupsCancelled)'))
  assert.ok(source.indexOf('checkAISession(ctx, followupsCancelled)') < source.indexOf('continueFlow(ctx, outgoing)'))
  assert.ok(source.includes('recordAiExecutionEvent'))
  assert.ok(source.includes('sessionExpired(session)'))
})

test('session lookup overlaps cancellation, but a reply waits for cancellation', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhook.js'), 'utf8')
  const start = source.indexOf('async function checkAISession')
  const end = source.indexOf('module.exports = router', start)
  const agent = { customer_id:'workspace', whatsapp_number_id:'number' }
  const query = {
    select: () => query,
    eq: () => query,
    async maybeSingle() {
      events.push('session lookup')
      return { data:{ ai_agents:agent }, error:null }
    }
  }
  const events = []
  let cancel
  const followupsCancelled = new Promise(resolve => { cancel = resolve })
  const checkAISession = vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
    supabase:{ from:() => query },
    mayReplyToContact:async () => true,
    sessionExpired:() => false,
    loadLiveVersion:async () => ({ version:1 }),
    runLiveAiTurn:async () => { events.push('reply'); return true }
  })

  const pending = checkAISession({
    customerId:'workspace', number:{id:'number'}, conversation:{id:'conversation'}
  }, followupsCancelled)
  assert.deepEqual(events, ['session lookup'])
  cancel()
  assert.equal(await pending, true)
  assert.deepEqual(events, ['session lookup', 'reply'])
})

test('manual team control terminates active AI sessions', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'conversations.js'), 'utf8')
  assert.ok(source.includes('closeActiveAiSessionsForConversation'))
  assert.ok(source.includes("reason: 'manual_takeover'"))
  assert.ok(source.includes("reason: 'manual_handoff'"))
})
