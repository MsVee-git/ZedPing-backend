const axios = require('axios')

class MetaTemplateError extends Error {}

function graphApiVersion(env = process.env) {
  const version = String(env.META_GRAPH_API_VERSION || 'v18.0').trim()
  if (!/^v\d+\.\d+$/.test(version)) throw new MetaTemplateError('Meta Graph API version is invalid')
  return version
}

function tokenFor(accessToken, env = process.env) {
  const token = accessToken || env.META_ACCESS_TOKEN
  if (!token) throw new MetaTemplateError('No WhatsApp access token is configured')
  return token
}

function hasVariables(template) {
  return /{{\s*\d+\s*}}/.test(JSON.stringify(template?.components || []))
}

function approvedNoVariableTemplate(template) {
  if (!template || String(template.status || '').toUpperCase() !== 'APPROVED') throw new MetaTemplateError('Only approved templates can be sent')
  if (!template.id || !template.name || !template.language) throw new MetaTemplateError('Template data from Meta is incomplete')
  if (hasVariables(template)) throw new MetaTemplateError('This template requires variables and cannot be sent by this first version')
  return template
}

function createMetaTemplateClient({ env = process.env, http = axios } = {}) {
  const version = graphApiVersion(env)
  const headersFor = (accessToken) => ({ Authorization: `Bearer ${tokenFor(accessToken, env)}` })

  async function listTemplates({ wabaId, accessToken }) {
    if (!/^[0-9]{5,32}$/.test(String(wabaId || ''))) throw new MetaTemplateError('WABA is invalid')
    const fields = 'id,name,status,category,language,components'
    const result = []
    let url = `https://graph.facebook.com/${version}/${wabaId}/message_templates`
    let params = { fields, limit: 250 }
    for (let page = 0; page < 10 && url; page += 1) {
      let response
      try {
        response = await http.get(url, { headers: headersFor(accessToken), params })
      } catch (_) {
        throw new MetaTemplateError('Meta could not load message templates')
      }
      result.push(...(Array.isArray(response?.data?.data) ? response.data.data : []))
      url = response?.data?.paging?.next || null
      params = undefined
    }
    return result
  }

  return { version, listTemplates, approvedNoVariableTemplate, hasVariables }
}

module.exports = { MetaTemplateError, graphApiVersion, createMetaTemplateClient, approvedNoVariableTemplate, hasVariables }

