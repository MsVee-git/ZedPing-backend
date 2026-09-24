const { MetaTemplateError } = require('./metaTemplates')

const ALLOWED_SOURCES = new Set(['contact_name', 'contact_phone', 'contact_email', 'fixed'])

function bodyComponent(template) {
  return (template?.components || []).find((component) => String(component?.type || '').toUpperCase() === 'BODY') || null
}

function placeholders(text) {
  return [...new Set([...String(text || '').matchAll(/{{\s*(\d+)\s*}}/g)].map((match) => Number(match[1])))]
    .sort((left, right) => left - right)
}

function unsupportedDynamicComponents(template) {
  return (template?.components || []).some((component) => {
    const type = String(component?.type || '').toUpperCase()
    if (type === 'BODY') return false
    return /{{\s*\d+\s*}}/.test(JSON.stringify(component || {}))
  })
}

function describeTemplate(template) {
  const body = bodyComponent(template)
  const variableNumbers = placeholders(body?.text)
  const status = String(template?.status || '').toUpperCase()
  const unsupported = unsupportedDynamicComponents(template)
  return {
    id: String(template?.id || ''),
    name: template?.name || '',
    status,
    category: template?.category || null,
    language: template?.language || null,
    body_preview: String(body?.text || '').slice(0, 1024),
    variables: variableNumbers,
    sendable: status === 'APPROVED' && !unsupported,
    unavailable_reason: status !== 'APPROVED'
      ? 'Only approved templates can be used in a broadcast.'
      : unsupported ? 'This template has dynamic content outside its message body and is not supported for broadcast yet.' : null
  }
}

function normalizeMappings(value, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {}
  const mappings = {}
  for (const number of required) {
    const raw = value[String(number)]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !ALLOWED_SOURCES.has(raw.source)) {
      throw new MetaTemplateError(`Choose a value for template variable {{${number}}}.`)
    }
    const source = raw.source
    const fixed = source === 'fixed' ? String(raw.value || '').trim() : null
    if (source === 'fixed' && (!fixed || fixed.length > 1024)) {
      throw new MetaTemplateError(`Enter a valid fixed value for template variable {{${number}}}.`)
    }
    mappings[number] = { source, ...(fixed ? { value: fixed } : {}) }
  }
  if (Object.keys(value).some((key) => !required.includes(Number(key)))) {
    throw new MetaTemplateError('Template variables do not match the selected template.')
  }
  return mappings
}

function valueFor(contact, mapping) {
  if (mapping.source === 'fixed') return mapping.value
  if (mapping.source === 'contact_name') return String(contact.name || '').trim()
  if (mapping.source === 'contact_phone') return String(contact.phone_number || '').trim()
  if (mapping.source === 'contact_email') return String(contact.email || '').trim()
  return ''
}

function resolveTemplateRecipients(template, contacts, rawMappings) {
  const description = describeTemplate(template)
  if (description.status !== 'APPROVED') throw new MetaTemplateError('Only approved templates can be used in a broadcast.')
  if (!description.sendable) throw new MetaTemplateError(description.unavailable_reason)
  const mappings = normalizeMappings(rawMappings, description.variables)
  const recipients = []
  const unresolved = []
  for (const contact of contacts || []) {
    const values = description.variables.map((number) => valueFor(contact, mappings[number]))
    if (values.some((value) => !value)) {
      unresolved.push({ contact_id: contact.id, reason: 'Missing a value required by the selected template.' })
      continue
    }
    recipients.push({ ...contact, template_components: description.variables.length ? [{
      type: 'body', parameters: values.map((text) => ({ type: 'text', text }))
    }] : [] })
  }
  return { template: description, mappings, recipients, unresolved }
}

module.exports = { describeTemplate, resolveTemplateRecipients, normalizeMappings, placeholders, unsupportedDynamicComponents }

