const axios = require('axios')

class MetaTemplateError extends Error {
  constructor(message, { kind = 'validation', detail = null } = {}) {
    super(message)
    this.name = 'MetaTemplateError'
    this.kind = kind
    this.detail = detail
  }
}

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

function assertWabaId(wabaId) {
  if (!/^[0-9]{5,32}$/.test(String(wabaId || ''))) throw new MetaTemplateError('WABA is invalid')
}

function templateComponents({ body, variable_examples: variableExamples = [] }) {
  if (typeof body !== 'string') throw new MetaTemplateError('Template body is required')
  const text = body.trim()
  if (!text || text.length > 1024) throw new MetaTemplateError('Template body must be between 1 and 1024 characters')
  const matches = [...text.matchAll(/{{(\d+)}}/g)]
  if (/{{|}}/.test(text.replace(/{{\d+}}/g, ''))) throw new MetaTemplateError('Variables must use the format {{1}}, {{2}}, and so on')
  const numbers = [...new Set(matches.map((match) => Number(match[1])))]
  const variableCount = numbers.length
  if (variableCount > 10) throw new MetaTemplateError('A template body can contain at most 10 variables')
  if (numbers.some((number, index) => number !== index + 1)) throw new MetaTemplateError('Variables must be consecutive, starting with {{1}}')
  if (!Array.isArray(variableExamples) || variableExamples.length !== variableCount) throw new MetaTemplateError('Provide one example value for each variable')
  const examples = variableExamples.map((value) => String(value || '').trim())
  if (examples.some((value) => !value || value.length > 128)) throw new MetaTemplateError('Each variable example must be between 1 and 128 characters')
  const component = { type: 'BODY', text }
  if (variableCount) component.example = { body_text: [examples] }
  return [component]
}

function buildTemplateSubmission(input = {}) {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const category = typeof input.category === 'string' ? input.category.trim().toUpperCase() : ''
  const language = typeof input.language === 'string' ? input.language.trim() : ''
  if (!/^[a-z][a-z0-9_]{0,99}$/.test(name)) throw new MetaTemplateError('Template name must use lowercase letters, numbers, and underscores')
  if (!['UTILITY', 'MARKETING'].includes(category)) throw new MetaTemplateError('Template category must be UTILITY or MARKETING')
  if (!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language)) throw new MetaTemplateError('Template language is invalid')
  return { name, category, language, components: templateComponents(input) }
}

function metaErrorDetail(error) {
  const source = error?.response?.data?.error || {}
  const detail = String(source.error_user_msg || source.message || '').replace(/Bearer\s+[^\s]+/gi, '').trim()
  return detail ? detail.slice(0, 400) : null
}

function createMetaTemplateClient({ env = process.env, http = axios } = {}) {
  const version = graphApiVersion(env)
  const headersFor = (accessToken) => ({ Authorization: `Bearer ${tokenFor(accessToken, env)}` })

  async function listTemplates({ wabaId, accessToken }) {
    assertWabaId(wabaId)
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

  async function createTemplate({ wabaId, accessToken, template }) {
    assertWabaId(wabaId)
    const payload = buildTemplateSubmission(template)
    try {
      const response = await http.post(
        `https://graph.facebook.com/${version}/${wabaId}/message_templates`,
        payload,
        { headers: headersFor(accessToken) }
      )
      const data = response?.data || {}
      if (!data.id && !data.status) throw new MetaTemplateError('Meta returned an incomplete template submission result', { kind: 'upstream' })
      return { id: data.id ? String(data.id) : null, status: String(data.status || 'PENDING').toUpperCase(), category: data.category ? String(data.category).toUpperCase() : payload.category }
    } catch (error) {
      if (error instanceof MetaTemplateError) throw error
      throw new MetaTemplateError('Meta rejected the template submission', { kind: 'rejected', detail: metaErrorDetail(error) })
    }
  }

  async function deleteTemplate({ wabaId, accessToken, templateName }) {
    assertWabaId(wabaId)
    const name = typeof templateName === 'string' ? templateName.trim() : ''
    if (!/^[a-z][a-z0-9_]{0,99}$/.test(name)) throw new MetaTemplateError('Template name is invalid')
    try {
      const response = await http.delete(
        `https://graph.facebook.com/${version}/${wabaId}/message_templates`,
        { headers: headersFor(accessToken), params: { name } }
      )
      if (response?.data?.success !== true) throw new MetaTemplateError('Meta returned an incomplete template deletion result', { kind: 'upstream' })
      return { success: true }
    } catch (error) {
      if (error instanceof MetaTemplateError) throw error
      throw new MetaTemplateError('Meta rejected the template deletion', { kind: 'rejected', detail: metaErrorDetail(error) })
    }
  }

  return { version, listTemplates, createTemplate, deleteTemplate, buildTemplateSubmission, approvedNoVariableTemplate, hasVariables }
}

module.exports = { MetaTemplateError, graphApiVersion, createMetaTemplateClient, approvedNoVariableTemplate, hasVariables, buildTemplateSubmission }

