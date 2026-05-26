const OpenAI = require('openai')

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

async function getAIResponse(systemPrompt, messages) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages
    ],
    max_tokens: 500
  })

  return response.choices[0].message.content
}

module.exports = { getAIResponse }
