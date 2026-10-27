const express = require('express')
const { randomUUID } = require('crypto')
const { requestMode, copilotPlan, contextFor, parseResult, instructions } = require('../lib/inboxCopilot')
const { resolveEligibleKnowledge } = require('../lib/aiAgentKnowledge')

function createCopilotRouter({ db, complete }) {
  const router = express.Router()
  async function entitlement(req) {
    const { data, error } = await db.from('customers').select('subscription_plan,subscription_status').eq('id', req.workspace.customerId).single()
    if (error) throw error
    return copilotPlan(data)
  }
  router.get('/access', async (req, res) => {
    res.set('Cache-Control', 'no-store')
    try {
      const plan = await entitlement(req)
      return res.json({ enabled:Boolean(plan), monthly_limit:plan?.limit || 0, pilot:true })
    } catch { return res.status(503).json({ error:'Copilot access is temporarily unavailable' }) }
  })
  router.post('/', async (req, res) => {
    res.set('Cache-Control', 'no-store')
    let reservation
    try {
      const mode = requestMode(req.body)
      const plan = await entitlement(req)
      if (!plan) return res.status(403).json({ error:'ZedPing Ai Copilot is available on Business and Pro', code:'upgrade_required' })
      const customerId = req.workspace.customerId
      let query = db.from('conversations').select('id,status,control_mode,last_message_at,contacts(name,phone_number)').eq('customer_id', customerId)
      if (mode === 'ask') {
        query = query.neq('status', 'resolved').order('id', {ascending:true}).limit(11)
        if (req.body.cursor) query = query.gt('id', req.body.cursor)
      } else query = mode === 'summary' ? query.neq('status', 'resolved').order('last_message_at', { ascending:false, nullsFirst:false }).limit(20) : query.eq('id', req.body.conversation_id).limit(1)
      const { data:rows, error } = await query
      const hasMore = mode === 'ask' && rows?.length > 10
      const conversations = mode === 'ask' ? rows?.slice(0,10) : rows
      if (error) throw error
      if (!conversations?.length) return res.json({ mode, overview:['summary','ask'].includes(mode) ? 'No open conversations to summarise.' : 'Conversation not found.', items:[], reviewed:0 })
      // Per-thread limits prevent one busy thread from crowding all other threads out.
      const histories = await Promise.all(conversations.map(async conversation => {
        const result = await db.from('messages').select('id,conversation_id,direction,message_body,created_at').eq('customer_id', customerId).eq('conversation_id', conversation.id).order('created_at', {ascending:false}).limit(12)
        if (result.error) throw result.error
        return result.data || []
      }))
      let knowledge = []
      if (mode === 'draft') {
        const result = await db.from('content_library_items').select('id').eq('customer_id', customerId).is('archived_at', null).order('updated_at', {ascending:false}).limit(5)
        if (result.error) throw result.error
        knowledge = (await resolveEligibleKnowledge(db, customerId, (result.data || []).map(item => item.id))).map(item => ({name:item.name, text:String(item.text_content || '').slice(0, 1200)}))
      }
      const context = contextFor(conversations, histories.flat())
      reservation = randomUUID()
      const claim = await db.rpc('reserve_inbox_copilot_request', {p_customer_id:customerId, p_user_id:req.workspace.userId, p_request_id:reservation, p_limit:plan.limit})
      if (claim.error) {
        if (claim.error.code === 'P0001') return res.status(429).json({ error:'Copilot request limit reached. Try again later or contact your administrator.', code:'usage_limit' })
        throw claim.error
      }
      const completion = await complete(instructions(mode), JSON.stringify({ staff_question:mode === 'ask' ? req.body.question.trim() : undefined, conversations:context, approved_knowledge:knowledge }))
      const result = parseResult(completion.text, conversations, mode)
      if (mode === 'ask') {
        const raw = JSON.parse(completion.text)
        for (const item of result.items) {
          const source = raw.items?.find(row => row.conversation_id === item.conversation_id)
          const messages = context.find(row => row.id === item.conversation_id)?.messages || []
          item.evidence = messages.filter(message => Array.isArray(source?.evidence_message_ids) && source.evidence_message_ids.includes(message.id)).slice(0,3).map(message => ({id:message.id, text:message.text, direction:message.direction, at:message.at}))
        }
        result.items = result.items.filter((item,index,items) => item.evidence.length && items.findIndex(other => other.conversation_id === item.conversation_id) === index)
      }
      const saved = await db.from('inbox_copilot_requests').update({state:'completed',input_tokens:completion.inputTokens,output_tokens:completion.outputTokens}).eq('id',reservation).eq('customer_id',customerId)
      if (saved.error) throw saved.error
      return res.json({ ...result, mode, reviewed:conversations.length, next_cursor:hasMore ? conversations.at(-1).id : null, sampled:mode === 'summary', scope:mode === 'ask' ? 'Open conversations, reviewed in batches of 10; up to 12 recent text messages per chat. Attachments are not analysed.' :'Up to 20 recently active open conversations; up to 12 recent text messages per conversation.', generated_at:new Date().toISOString(), usage:{monthly_limit:plan.limit, remaining:claim.data?.remaining ?? null}, pilot:true })
    } catch (error) {
      if (reservation) await db.from('inbox_copilot_requests').update({state:'failed'}).eq('id',reservation).eq('customer_id',req.workspace.customerId)
      return res.status(error.status || 503).json({ error:error.status === 400 ? error.message : 'Copilot could not complete this request. Please try again later.' })
    }
  })
  return router
}
module.exports = { createCopilotRouter }
