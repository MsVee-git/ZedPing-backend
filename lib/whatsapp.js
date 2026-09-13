const axios = require('axios')

function tokenFor(accessToken) {
  const token = accessToken || process.env.META_ACCESS_TOKEN
  if (!token) throw new Error('No WhatsApp access token is configured')
  return token
}

function graphApiVersion() {
  const version = String(process.env.META_GRAPH_API_VERSION || 'v18.0').trim()
  if (!/^v\d+\.\d+$/.test(version)) throw new Error('META_GRAPH_API_VERSION is invalid')
  return version
}

function messageUrl(phoneNumberId) {
  return `https://graph.facebook.com/${graphApiVersion()}/${phoneNumberId}/messages`
}

const sendTextMessage = async (phoneNumberId, to, message, accessToken) => {
  const response = await axios.post(messageUrl(phoneNumberId), { messaging_product:'whatsapp', to, type:'text', text:{body:message} }, { headers:{Authorization:`Bearer ${tokenFor(accessToken)}`,'Content-Type':'application/json'} })
  return response.data
}

const sendTemplateMessage = async (phoneNumberId, to, template, accessToken) => {
  const response = await axios.post(messageUrl(phoneNumberId), {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: template.name,
      language: { code: template.language }
    }
  }, { headers: { Authorization: `Bearer ${tokenFor(accessToken)}`, 'Content-Type': 'application/json' } })
  return response.data
}

module.exports = { sendTextMessage, sendTemplateMessage, graphApiVersion }
