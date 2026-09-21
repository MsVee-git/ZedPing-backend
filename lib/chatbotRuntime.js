const ALLOWED_STEP_TYPES = new Set(['send_message', 'ask_capture', 'choose_option', 'content', 'human_handoff', 'end'])
const CAPTURE_TYPES = new Set(['name', 'email', 'phone', 'text', 'number', 'date', 'choice'])
const MAX_CAPTURE_ATTEMPTS = 2

function fail(message) {
  const error = new Error(message)
  error.code = 'INVALID_FLOW_DEFINITION'
  throw error
}

function cleanText(value, label, max = 4096, required = true) {
  if (typeof value !== 'string') {
    if (!required && (value === undefined || value === null)) return ''
    fail(`${label} is invalid`)
  }
  const text = value.trim()
  if (required && !text) fail(`${label} is required`)
  if (text.length > max) fail(`${label} is too long`)
  return text
}

function stepMap(definition) {
  return new Map(definition.steps.map((step) => [step.id, step]))
}

function normalizedChoice(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function normalizePhone(value) {
  const raw = String(value || '').trim()
  const cleaned = raw.replace(/[\s()-]/g, '')
  if (!/^\+?[1-9]\d{6,14}$/.test(cleaned)) return null
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`
}

function validateCapture(value, capture) {
  const raw = String(value || '').trim()
  const type = capture.type
  if (!raw && !capture.required) return { ok: true, value: '' }
  if (!raw) return { ok: false, reason: 'A response is required' }
  if (type === 'text' || type === 'name') return { ok: true, value: raw }
  if (type === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? { ok: true, value: raw.toLowerCase() } : { ok: false, reason: 'Enter a valid email address' }
  if (type === 'phone') {
    const phone = normalizePhone(raw)
    return phone ? { ok: true, value: phone } : { ok: false, reason: 'Enter a valid phone number' }
  }
  if (type === 'number') {
    const number = Number(raw)
    return Number.isFinite(number) ? { ok: true, value: number } : { ok: false, reason: 'Enter a valid number' }
  }
  if (type === 'date') {
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`))
      ? { ok: true, value: raw }
      : { ok: false, reason: 'Enter a date as YYYY-MM-DD' }
  }
  return { ok: false, reason: 'Unsupported capture type' }
}

function assertNoAutoCycles(byId, entry) {
  const visiting = new Set()
  const visited = new Set()
  function nextForAuto(step) {
    if (step.type === 'send_message' || step.type === 'content') return step.next_step_id || null
    return null
  }
  function walk(id) {
    if (visited.has(id)) return
    if (visiting.has(id)) fail('Published flows cannot contain an automatic message loop')
    visiting.add(id)
    const step = byId.get(id)
    const next = nextForAuto(step)
    if (next) walk(next)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of byId.keys()) walk(id)
}

function validateDefinition(input, { contentItems = new Map() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Flow definition is invalid')
  const entry_step_key = cleanText(input.entry_step_key, 'Entry step', 100)
  const steps = Array.isArray(input.steps) ? input.steps : null
  if (!steps || !steps.length || steps.length > 100) fail('A flow requires between 1 and 100 steps')
  const ids = new Set()
  const normalised = steps.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Flow step is invalid')
    const id = cleanText(raw.id, 'Step ID', 100)
    if (!/^[A-Za-z0-9_-]+$/.test(id) || ids.has(id)) fail('Step IDs must be unique stable values')
    ids.add(id)
    const type = cleanText(raw.type, 'Step type', 50).toLowerCase()
    if (!ALLOWED_STEP_TYPES.has(type)) fail('Flow contains an unsupported step type')
    const step = { id, type }
    if (type === 'send_message') {
      step.text = cleanText(raw.text, 'Message', 4096)
      step.next_step_id = raw.next_step_id ? cleanText(raw.next_step_id, 'Next step', 100) : null
      if (!step.next_step_id) fail('A send-message step must lead to another step')
    }
    if (type === 'content') {
      step.content_library_item_id = cleanText(raw.content_library_item_id, 'Content Library item', 100)
      step.next_step_id = raw.next_step_id ? cleanText(raw.next_step_id, 'Next step', 100) : null
      if (!step.next_step_id) fail('A content step must lead to another step')
      const item = contentItems.get(step.content_library_item_id)
      if (!item || item.archived_at || !['TEXT', 'LINK'].includes(item.content_type)) fail('Flow content must reference active workspace Text or Link content')
    }
    if (type === 'ask_capture') {
      step.text = cleanText(raw.text, 'Capture question', 4096)
      step.next_step_id = cleanText(raw.next_step_id, 'Next step', 100)
      const capture = raw.capture
      if (!capture || typeof capture !== 'object' || Array.isArray(capture)) fail('Capture configuration is invalid')
      const key = cleanText(capture.key, 'Capture field key', 80)
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) fail('Capture field key is invalid')
      const captureType = cleanText(capture.type, 'Capture type', 30).toLowerCase()
      if (!CAPTURE_TYPES.has(captureType)) fail('Capture type is unsupported')
      const validation = capture.validation && typeof capture.validation === 'object' && !Array.isArray(capture.validation) ? capture.validation : {}
      if (captureType === 'choice') {
        const options = Array.isArray(validation.options) ? validation.options : []
        if (options.length < 2 || options.length > 10) fail('Choice capture requires between 2 and 10 options')
        const optionValues = options.flatMap((option, index) => [String(index + 1), option?.label, ...(Array.isArray(option?.aliases) ? option.aliases : [])]).map(normalizedChoice)
        if (optionValues.some((value) => !value) || new Set(optionValues).size !== optionValues.length) fail('Choice capture options must be unambiguous')
      }
      const failure_action = cleanText(capture.failure_action || 'handoff', 'Failure action', 20).toLowerCase()
      if (!['handoff', 'end'].includes(failure_action)) fail('Capture failure action must be handoff or end')
      step.capture = {
        key, label: cleanText(capture.label || step.text, 'Capture label', 300),
        type: captureType, required: capture.required !== false,
        validation,
        failure_action, max_attempts: MAX_CAPTURE_ATTEMPTS
      }
    }
    if (type === 'choose_option') {
      step.text = cleanText(raw.text, 'Choice question', 4096)
      const choices = Array.isArray(raw.choices) ? raw.choices : []
      if (choices.length < 2 || choices.length > 10) fail('A choice step requires between 2 and 10 choices')
      const seen = new Set()
      step.choices = choices.map((choice, index) => {
        const label = cleanText(choice?.label, 'Choice label', 300)
        const aliases = Array.isArray(choice?.aliases) ? choice.aliases.map((alias) => cleanText(alias, 'Choice alias', 160)) : []
        const outcome = choice?.outcome ? cleanText(choice.outcome, 'Choice outcome', 20).toLowerCase() : null
        const next_step_id = choice?.next_step_id ? cleanText(choice.next_step_id, 'Choice next step', 100) : null
        if ((outcome && !['human_handoff', 'end'].includes(outcome)) || (!outcome && !next_step_id) || (outcome && next_step_id)) fail('Each choice must route to one next step, handoff, or end')
        for (const phrase of [String(index + 1), label, ...aliases]) {
          const normalized = normalizedChoice(phrase)
          if (!normalized || seen.has(normalized)) fail('Choice labels and aliases must be unambiguous')
          seen.add(normalized)
        }
        return { id: cleanText(choice?.id || `choice_${index + 1}`, 'Choice ID', 100), label, aliases, outcome, next_step_id }
      })
    }
    if (type === 'human_handoff') step.reason = cleanText(raw.reason || 'Requested by chatbot flow', 'Handoff reason', 500)
    if (type === 'end') step.text = raw.text ? cleanText(raw.text, 'Final message', 4096) : ''
    return step
  })
  if (!ids.has(entry_step_key)) fail('Flow entry step does not exist')
  const byId = new Map(normalised.map((step) => [step.id, step]))
  let customCaptures = 0
  let terminalReachable = false
  for (const step of normalised) {
    if (step.type === 'ask_capture') {
      if (!byId.has(step.next_step_id)) fail('Capture step references a missing next step')
      if (!['name', 'email', 'phone'].includes(step.capture.type)) customCaptures += 1
    }
    if (step.type === 'send_message' || step.type === 'content') if (!byId.has(step.next_step_id)) fail('Step references a missing next step')
    if (step.type === 'choose_option') for (const choice of step.choices) if (choice.next_step_id && !byId.has(choice.next_step_id)) fail('Choice references a missing next step')
    if (step.type === 'end' || step.type === 'human_handoff') terminalReachable = true
  }
  if (customCaptures > 5) fail('Flows support at most five custom capture questions')
  if (!terminalReachable) fail('A published flow requires an end or handoff outcome')
  const outgoing = (step) => {
    if (step.type === 'send_message' || step.type === 'content' || step.type === 'ask_capture') return [step.next_step_id]
    if (step.type === 'choose_option') return step.choices.filter((choice) => choice.next_step_id).map((choice) => choice.next_step_id)
    return []
  }
  const reachable = new Set()
  const visitReachable = (id) => {
    if (reachable.has(id)) return
    reachable.add(id)
    outgoing(byId.get(id)).forEach(visitReachable)
  }
  visitReachable(entry_step_key)
  if (reachable.size !== byId.size) fail('Published flows cannot contain unreachable steps')
  const terminalMemo = new Map()
  const terminalVisiting = new Set()
  const hasTerminalPath = (id) => {
    if (terminalMemo.has(id)) return terminalMemo.get(id)
    if (terminalVisiting.has(id)) return false
    terminalVisiting.add(id)
    const step = byId.get(id)
    const result = step.type === 'end' || step.type === 'human_handoff' || outgoing(step).some(hasTerminalPath)
    terminalVisiting.delete(id)
    terminalMemo.set(id, result)
    return result
  }
  if (!hasTerminalPath(entry_step_key)) fail('Published flows require a reachable terminal outcome')
  assertNoAutoCycles(byId, entry_step_key)
  return { entry_step_key, steps: normalised }
}

function findChoice(step, body) {
  const value = normalizedChoice(body)
  if (!value) return null
  return step.choices.find((choice, index) => [String(index + 1), choice.label, ...(choice.aliases || [])].some((item) => normalizedChoice(item) === value)) || null
}

function formatChoicePrompt(step) {
  return [step.text, ...step.choices.map((choice, index) => `${index + 1}. ${choice.label}`)].join('\n')
}

function simulateFlow(definition, inputs = []) {
  const valid = validateDefinition(definition)
  const byId = stepMap(valid)
  let current = valid.entry_step_key
  let inputIndex = 0
  const output = []
  const captured = {}
  let terminal = null
  for (let guard = 0; guard < 100 && current && !terminal; guard += 1) {
    const step = byId.get(current)
    if (step.type === 'send_message') { output.push(step.text); current = step.next_step_id; continue }
    if (step.type === 'content') { output.push('[content]'); current = step.next_step_id; continue }
    if (step.type === 'ask_capture') {
      output.push(step.text)
      const result = validateCapture(inputs[inputIndex++], step.capture)
      if (!result.ok) { terminal = step.capture.failure_action; continue }
      captured[step.capture.key] = result.value; current = step.next_step_id; continue
    }
    if (step.type === 'choose_option') {
      output.push(formatChoicePrompt(step))
      const selected = findChoice(step, inputs[inputIndex++])
      if (!selected) { terminal = 'invalid_choice'; continue }
      terminal = selected.outcome || null; current = selected.next_step_id || null; continue
    }
    if (step.type === 'human_handoff') { terminal = 'human_handoff'; continue }
    if (step.type === 'end') { if (step.text) output.push(step.text); terminal = 'end' }
  }
  return { output, captured, terminal }
}

module.exports = { ALLOWED_STEP_TYPES, CAPTURE_TYPES, MAX_CAPTURE_ATTEMPTS, validateDefinition, validateCapture, normalizePhone, findChoice, formatChoicePrompt, simulateFlow }
