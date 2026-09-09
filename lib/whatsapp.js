const axios = require('axios')

function tokenFor(accessToken) {
  const token = accessToken || process.env.META_ACCESS_TOKEN
  if (!token) throw new Error('No WhatsApp access token is configured')
  return token
}

const sendTextMessage = async (phoneNumberId, to, message, accessToken) => {
  const response = await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, { messaging_product:'whatsapp', to, type:'text', text:{body:message} }, { headers:{Authorization:`Bearer ${tokenFor(accessToken)}`,'Content-Type':'application/json'} })
  return response.data
}
const sendTemplateMessage = async (phoneNumberId,to,templateName,variables,accessToken) => {
 const response=await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,{messaging_product:'whatsapp',to,type:'template',template:{name:templateName,language:{code:'en'},components:[{type:'body',parameters:variables.map(v=>({type:'text',text:v}))}]}},{headers:{Authorization:`Bearer ${tokenFor(accessToken)}`,'Content-Type':'application/json'}})
 return response.data
}
module.exports={sendTextMessage,sendTemplateMessage}
