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

async function runHandoffConversation(configuration, messages) {
  const { commercialTurn, commercialMetadata } = require('../lib/zoeCommercial')
  const { buildLiveSystem, handoffConfirmation } = require('../lib/zoeGrounding')
  const { shouldSuppressAutomation } = require('../lib/conversationState')
  const source = fs.readFileSync(require.resolve('../routes/webhook'), 'utf8')
  const route = source.slice(source.indexOf('async function transitionAiToHandoff'), source.indexOf('async function checkAISession'))
  const intake = source.slice(source.indexOf('async function runInboundAutomation'), source.indexOf('async function outgoing('))
  const conversation = { id:'conversation', status:'open', control_mode:'automation' }
  const session = { id:'session', messages:[], status:'active' }
  const agent = { id:'agent', name:'Assistant' }
  const version = { configuration:{ configuration }, knowledge_snapshot:[] }
  const replies = [], handoffs = []
  let automationSkips = 0
  const query = {
    eq:()=>query, select:()=>query,
    async maybeSingle() { return { data:conversation } }
  }
  const scope = vm.createContext({
    commercialTurn, commercialMetadata, buildLiveSystem, handoffConfirmation, shouldSuppressAutomation,
    aiReplyContext:()=>'', adReferralContext:()=>'', boundedHistory:history=>history,
    isMarketingOptOutCommand:()=>false, cancelFollowups:async()=>{},
    recordAutomationEvent:async (_ctx, _outcome, _status, { reason })=>{ if (reason === 'team_inbox_control') automationSkips++ },
    closeActiveAiSessionsForConversation:async()=>{ session.status = 'closed' },
    recordConversationEvent:async event=>handoffs.push(event),
    recordAiExecutionEvent:async()=>{}, BETA_MODEL:'test', SESSION_IDLE_MS:60000,
    outgoing:async (_ctx, text)=>replies.push(text),
    supabase:{ from:table=>({
      update(patch) { Object.assign(table === 'conversations' ? conversation : session, patch); return query }
    }) }
  })
  vm.runInContext(route + '\n' + intake, scope)
  scope.checkAISession = async ctx=>scope.runLiveAiTurn(ctx, session, agent, version)
  for (const body of messages) {
    await scope.runInboundAutomation({ body, conversation, customerId:'workspace', number:{ id:'number' } })
  }
  assert.equal(conversation.status, 'needs_attention')
  assert.equal(conversation.control_mode, 'needs_attention')
  assert.equal(conversation.assigned_user_id, null)
  assert.equal(session.status, 'closed')
  assert.equal(handoffs.length, 1)
  assert.equal(automationSkips, 1)
  return { conversation, handoffs, replies }
}

test('a completed generic reservation moves to Needs Attention and pauses later AI replies', async () => {
  const { handoffs, replies } = await runHandoffConversation(
    { booking_enabled:true, handoff:{business_name:'Demo Restaurant'} },
    ['No, I would like to make a booking', '14 November, 7pm', '3guests', 'Chika', 'Thank you']
  )
  assert.equal(handoffs[0].metadata.reason, 'booking_requested')
  assert.equal(handoffs[0].metadata.commercial_context.collected.party_size, '3')
  assert.equal(replies.length, 4)
  assert.match(replies.at(-1), /Demo Restaurant team will check availability/)
})

test('the live assessment request sends one assessment reply and labels the Team Inbox handoff', async () => {
  const { conversation, handoffs, replies } = await runHandoffConversation(
    { booking_enabled:false, handoff:{business_name:'Example Motors'}, commercial_action:{type:'quotation'} },
    ['I want to come in for a vehicle assessment', 'Thank you']
  )
  assert.equal(handoffs[0].metadata.reason, 'assessment_requested')
  assert.equal(conversation.handoff_reason, 'Vehicle assessment requested')
  assert.deepEqual(replies, ['I’ll connect you with the Example Motors team here on WhatsApp to help arrange your vehicle assessment.'])
})
