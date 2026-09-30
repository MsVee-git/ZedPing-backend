const MAX_CONTEXT_VALUE_CHARS = 160
const MAX_QUALIFICATION_FIELDS = 5
const FIELD_KEY = /^[a-z][a-z0-9_]{0,48}$/

function cleanValue(value, max = MAX_CONTEXT_VALUE_CHARS) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function fieldLabel(key) {
  return String(key || 'detail').replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase())
}

function normaliseField(field) {
  const raw = typeof field === 'string' ? { key: field } : field
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const key = String(raw.key || '').trim().toLowerCase()
  if (!FIELD_KEY.test(key)) return null
  return {
    key,
    // A product/service is the only useful default for a quotation. Other
    // fields are opt-in requirements so one business cannot accidentally turn
    // every enquiry into a long form.
    required: raw.required === true || (raw.required === undefined && key === 'product_or_service'),
    label: cleanValue(raw.label || fieldLabel(key), 80)
  }
}

function normaliseCommercialAction(value) {
  if (value === undefined || value === null || value === false) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Commercial action configuration is invalid')
  if (value.type !== 'quotation') throw new Error('Commercial action type is invalid')
  const fields = [...new Map((Array.isArray(value.qualification_fields) ? value.qualification_fields : [])
    .map(normaliseField).filter(Boolean).slice(0, MAX_QUALIFICATION_FIELDS).map(field => [field.key, field])).values()]
  return {
    type: 'quotation',
    qualification_fields: fields,
    handoff_reason: cleanValue(value.handoff_reason || 'Quotation requested', 120) || 'Quotation requested'
  }
}

function commercialAction(configuration) {
  try { return normaliseCommercialAction(configuration?.commercial_action) } catch (_) { return null }
}

function priorCommercialContext(messages) {
  const text = (Array.isArray(messages) ? messages : []).map(item => String(item?.content || '')).join(' ').toLowerCase()
  return /\b(price|cost|how much|quotation|quote|respray|service|product|accessor|install)\b/.test(text)
}

function detectsCommercialIntent(message, history) {
  const input = cleanValue(message).toLowerCase()
  if (!input) return false
  if (/\b(quote|quotation|where\s+do\s+i\s+pay|how\s+do\s+i\s+proceed|payment|book(?:ing)?|order|purchase)\b/.test(input)) return true
  if (/\b(?:i\s+(?:want|would\s+like|need)|i['’]?ll\s+take|let['’]?s\s+(?:do\s+it|proceed)|go\s+ahead)\b/.test(input)) return true
  return /\b(?:this|that|it|one)\b/.test(input) && priorCommercialContext(history)
}

function productFromMessages(messages) {
  const userMessages = (Array.isArray(messages) ? messages : []).filter(item => item?.role === 'user').map(item => cleanValue(item.content))
  for (let index = userMessages.length - 1; index >= 0; index -= 1) {
    const value = userMessages[index]
    const match = value.match(/(?:how much (?:is|does)|(?:price|cost) (?:of|for)?|quote(?:\s+me)?\s+for|quotation(?:\s+for)?|want(?:\s+to\s+(?:buy|order))?)\s+(?:an?\s+|the\s+)?(.+)/i)
    const candidate = cleanValue(match?.[1] || '')
    if (candidate && !/^(?:it|this|that|one)(?:\b|\s)/i.test(candidate)) return candidate.replace(/[?.!]+$/, '')
  }
  return null
}

function boundedCollected(action, value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const allowed = new Set(action.qualification_fields.map(field => field.key))
  return Object.fromEntries(Object.entries(source)
    .filter(([key, item]) => allowed.has(key) && cleanValue(item))
    .map(([key, item]) => [key, cleanValue(item)]))
}

function quotationQuestion(field) {
  const label = field?.label || fieldLabel(field?.key)
  return `To help our team prepare the quotation, what ${label.toLowerCase()} do you need?`
}

function inferredQualificationContext(action, history) {
  const lastAssistant = [...(Array.isArray(history) ? history : [])].reverse().find(item => item?.role === 'assistant')
  const question = cleanValue(lastAssistant?.content)
  const match = question.match(/^To help our team prepare the quotation, what (.+) do you need\?$/i)
  if (!match) return null
  const pending = action.qualification_fields.find(field => field.label.toLowerCase() === match[1].toLowerCase())
  if (!pending) return null
  return { action_type: action.type, stage: 'quotation_qualifying', pending_field: pending.key, asked_fields:[pending.key], collected:{} }
}

function commercialTurn(configuration, message, history, existingContext) {
  const action = commercialAction(configuration)
  if (!action) return null
  const inheritedContext = existingContext || inferredQualificationContext(action, history)
  const prior = inheritedContext && inheritedContext.action_type === action.type && inheritedContext.stage === 'quotation_qualifying'
  if (!prior && !detectsCommercialIntent(message, history)) return null

  const context = {
    action_type: action.type,
    stage: 'quotation_qualifying',
    collected: boundedCollected(action, inheritedContext?.collected),
    asked_fields: Array.isArray(inheritedContext?.asked_fields) ? inheritedContext.asked_fields.filter(key => action.qualification_fields.some(field => field.key === key)).slice(-MAX_QUALIFICATION_FIELDS) : [],
    handoff_reason: action.handoff_reason,
    detected_at: inheritedContext?.detected_at || new Date().toISOString(),
    updated_at: new Date().toISOString()
  }
  const pending = action.qualification_fields.find(field => field.key === inheritedContext?.pending_field)
  if (pending) {
    const answer = cleanValue(message)
    if (answer) context.collected[pending.key] = answer
  }
  if (!context.collected.product_or_service) {
    const product = productFromMessages([...(history || []), { role: 'user', content: message }])
    if (product) context.collected.product_or_service = product
  }

  const next = action.qualification_fields.find(field => field.required && !context.collected[field.key])
  if (next) {
    context.pending_field = next.key
    if (!context.asked_fields.includes(next.key)) context.asked_fields.push(next.key)
    return { kind: 'qualify', action, context, reply: quotationQuestion(next) }
  }

  context.stage = 'ready_for_handoff'
  delete context.pending_field
  return { kind: 'handoff', action, context, reason: 'quotation_requested' }
}

function commercialMetadata(context) {
  if (!context || context.action_type !== 'quotation') return null
  const collected = Object.fromEntries(Object.entries(context.collected || {}).map(([key, value]) => [key, cleanValue(value)]).filter(([, value]) => value))
  return { action_type: 'quotation', stage: context.stage, handoff_reason: cleanValue(context.handoff_reason || 'Quotation requested', 120), collected }
}

module.exports = { cleanValue, normaliseCommercialAction, commercialAction, detectsCommercialIntent, commercialTurn, commercialMetadata, quotationQuestion, inferredQualificationContext }
