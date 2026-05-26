const OpenAI = require('openai')

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

async function getAIResponse(systemPrompt, messages, agent = null) {
  let finalPrompt = systemPrompt

  if (agent) {
    if (agent.business_name) {
      finalPrompt = finalPrompt.replace(/{{business_name}}/gi, agent.business_name)
    }
    if (agent.catalog_url) {
      finalPrompt = finalPrompt.replace(/{{catalog_url}}/gi, agent.catalog_url)
      if (!finalPrompt.includes(agent.catalog_url)) {
        finalPrompt += `\n\nProduct catalog: ${agent.catalog_url}`
      }
    }
    if (agent.payment_details) {
      finalPrompt = finalPrompt.replace(/{{payment_details}}/gi, agent.payment_details)
      if (!finalPrompt.includes(agent.payment_details)) {
        finalPrompt += `\n\nPayment details: ${agent.payment_details}`
      }
    }
  }

  const response = await openai.chat.completions.create({
    model: agent?.model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: finalPrompt },
      ...messages
    ],
    max_tokens: 500
  })

  return response.choices[0].message.content
}

module.exports = { getAIResponse }
