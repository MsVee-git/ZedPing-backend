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

module.exports = { BETA_MODEL, getAICompletion, getAIResponse }
