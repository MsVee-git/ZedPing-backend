const { normalizePhone } = require('./contactImport')
const { simulateFlow } = require('./chatbotRuntime')

const MAX_TEST_INPUTS = 40
const END_TEST = 'END TEST'

async function handleWhatsAppTest(supabase, ctx, send) {
  let sender
  try { sender = normalizePhone('+' + String(ctx.from).replace(/^\+/, '')) } catch { return false }
  const { data: test, error } = await supabase.from('chatbot_whatsapp_tests').select('*')
    .eq('customer_id', ctx.customerId).eq('whatsapp_number_id', ctx.number.id)
    .eq('sender', sender).gt('expires_at', new Date().toISOString()).maybeSingle()
  if (error) {
    console.error('Unable to look up WhatsApp chatbot test', error.code)
    return false
  }
  if (!test) return false

  const body = String(ctx.body || '').trim()
  const startsTest = !ctx.media && body.toUpperCase() === 'ZEDPING TEST ' + test.start_code
  const active = Array.isArray(test.inputs)
  if (!startsTest && !active) return false

  if (ctx.unsupported || ctx.media) {
    await send('WhatsApp test: Reply with text, or send END TEST to stop.')
    return true
  }

  const stopped = body.toUpperCase() === END_TEST
  const inputs = startsTest ? [] : [...test.inputs, body.slice(0, 4096)]
  const contentItems = new Map(Object.entries(test.content_items))
  const prior = startsTest || stopped ? null : simulateFlow(test.definition, test.inputs, { contentItems })
  const result = stopped ? null : simulateFlow(test.definition, inputs, { contentItems })
  const completed = stopped || !result.waiting_for_input || inputs.length >= MAX_TEST_INPUTS
  const mutation = completed
    ? supabase.from('chatbot_whatsapp_tests').delete()
    : supabase.from('chatbot_whatsapp_tests').update({ inputs })
  const current = mutation.eq('id', test.id)
  const { data: changed, error: writeError } = await (active
    ? current.eq('inputs', JSON.stringify(test.inputs))
    : current.is('inputs', null)).select('id').maybeSingle()
  if (writeError) throw writeError
  if (!changed) return true

  if (startsTest) await send('ZedPing WhatsApp test. Send END TEST at any time to stop.')
  for (const message of result?.output.slice(prior?.output.length || 0) || []) await send(message)
  if (completed) {
    const outcome = result?.terminal === 'human_handoff' || result?.terminal === 'handoff'
      ? ' The flow would hand this conversation to the team.'
      : ''
    await send('ZedPing WhatsApp test ended.' + outcome)
  }
  return true
}

function routeWhatsAppTest(supabase, ctx, sendWorkspaceText) {
  return handleWhatsAppTest(supabase, ctx, body =>
    sendWorkspaceText({ number: ctx.number, customerId: ctx.customerId, to: ctx.from, body })
  )
}

module.exports = { handleWhatsAppTest, routeWhatsAppTest }
