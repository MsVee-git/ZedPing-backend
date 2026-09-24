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

const uploadWhatsAppMedia = async (phoneNumberId, file, accessToken) => {
  if (!file?.buffer || !file?.mimetype) throw new Error('Media file is invalid')
  const form = new FormData()
  form.append('messaging_product', 'whatsapp')
  form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname || 'template-header')
  const response = await axios.post(`https://graph.facebook.com/${graphApiVersion()}/${phoneNumberId}/media`, form,
    { headers: { Authorization: `Bearer ${tokenFor(accessToken)}` } }
  )
  if (!response?.data?.id) throw new Error('WhatsApp did not return a media ID')
  return response.data.id
}

const sendTemplateMessage = async (phoneNumberId, to, template, accessToken) => {
  const headerComponent = template.headerMedia ? [{ type: 'header', parameters: [{ type: template.headerMedia.type, [template.headerMedia.type]: { id: template.headerMedia.id } }] }] : []
  // Components are built only by server-side template validation. This makes
  // broadcast body parameters possible without accepting arbitrary Meta JSON
  // from the browser.
  const parameterComponents = Array.isArray(template.components) ? template.components : []
  const components = [...headerComponent, ...parameterComponents]
  const response = await axios.post(messageUrl(phoneNumberId), {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: { name: template.name, language: { code: template.language }, ...(components.length ? { components } : {}) }
  }, { headers: { Authorization: `Bearer ${tokenFor(accessToken)}`, 'Content-Type': 'application/json' } })
  return response.data
}

module.exports = { sendTextMessage, sendTemplateMessage, uploadWhatsAppMedia, graphApiVersion }

