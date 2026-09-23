const OpenAI = require('openai')
const { BETA_MODEL, SAFETY_RULES, boundedHistory, boundedReply } = require('./aiRuntime')

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

function businessPrompt(systemPrompt, agent) {
  let prompt = String(systemPrompt || '').trim()
  if (agent?.business_name) prompt = prompt.replace(/{{business_name}}/gi, agent.business_name)
  if (agent?.catalog_url) {
    prompt = prompt.replace(/{{catalog_url}}/gi, agent.catalog_url)
    if (!prompt.includes(agent.catalog_url)) prompt += `\n\nProduct catalog: ${agent.catalog_url}`
  }
  if (agent?.payment_details) {
    prompt = prompt.replace(/{{payment_details}}/gi, agent.payment_details)
    if (!prompt.includes(agent.payment_details)) prompt += `\n\nPayment details: ${agent.payment_details}`
  }
  return prompt
}

async function getAICompletion(systemPrompt, messages, agent = null) {
  const response = await openai.chat.completions.create({
    // Customers cannot choose arbitrary provider models during beta.
    model: BETA_MODEL,
    messages: [
      { role: 'system', content: `${SAFETY_RULES}\n\nBusiness instructions:\n${businessPrompt(systemPrompt, agent)}` },
      ...boundedHistory(messages)
    ],
    max_tokens: 500
  })
  return {
    text: boundedReply(response.choices?.[0]?.message?.content),
    model: BETA_MODEL,
    inputTokens: Number(response.usage?.prompt_tokens) || null,
    outputTokens: Number(response.usage?.completion_tokens) || null
  }
}

async function getAIResponse(systemPrompt, messages, agent = null) {
  return (await getAICompletion(systemPrompt, messages, agent)).text
}

function extractionPrompt() {
  return [
    'Read this business image only to help its owner review factual information for a customer-service assistant.',
    'Extract only facts that are clearly visible: product or service names, prices, conditions, dates, compatibility, location, contact details, opening hours, and promotion terms.',
    'Do not guess missing, unreadable, ambiguous, or implied facts. Keep relationships such as product and price together.',
    'Return strict JSON only: {"text":"reviewable factual information","notes":["items that need owner confirmation"]}.',
    'If no reliable business facts are visible, set text to "No reliable business information could be read from this image." and explain why in notes.'
  ].join('\n')
}

function parseExtraction(value) {
  const raw = String(value || '').trim()
  try {
    const parsed = JSON.parse(raw)
    const text = typeof parsed.text === 'string' ? parsed.text.trim() : ''
    const notes = Array.isArray(parsed.notes) ? parsed.notes.map(note => String(note || '').trim()).filter(Boolean).slice(0, 12) : []
    if (text) return { text, notes }
  } catch (_) {}
  // The owner still has to review and approve this fallback; it is never live knowledge.
  return { text: raw || 'No reliable business information could be read from this image.', notes:['Please review the extracted information before approval.'] }
}

async function extractImageKnowledge({ buffer, mimeType }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || !String(mimeType || '').startsWith('image/')) throw new Error('Invalid image extraction request')
  const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`
  const response = await openai.responses.create({
    model: process.env.ZOE_VISION_MODEL || BETA_MODEL,
    input: [{ role:'user', content:[{ type:'input_text', text:extractionPrompt() }, { type:'input_image', image_url:dataUrl }] }],
    max_output_tokens: 1200
  })
  return parseExtraction(response?.output_text)
}

module.exports = { BETA_MODEL, getAICompletion, getAIResponse, extractImageKnowledge, parseExtraction }
