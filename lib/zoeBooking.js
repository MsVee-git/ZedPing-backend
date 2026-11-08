const TABLE = /\b(?:tables?|seats?)\b/i
const BOOKING = /\b(?:book(?:ing)?|appointments?|reserv(?:e|ation))\b/i
const REQUEST = /\b(?:book|reserve|schedule|make|arrange|get|need|want|would like|looking to|available|availability)\b/i
const GENERIC_BOOKING = /\b(?:(?:make|request|arrange|schedule|get|want|need|would like)\s+(?:a\s+)?booking|(?:can|could|may)\s+(?:i|we)\s+book(?=[?.!]|$)|(?:want|would like|need|looking)\s+to\s+book(?=[?.!]|$))/i
const BOOKING_TYPE_ANSWER = /^(?:a[n]?\s+)?(table|appointment)\b/i
const OTHER_INTENT = /\b(?:quote|quotation|cancel|reschedule|change|speak to|talk to|human|agent|representative)\b/i
const DATE = /\b(?:day after tomorrow|tomorrow|tonight|today|(?:this |next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend)|\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{4})?)\b/i
const TIME = /\b(?:(?:0?[1-9]|1[0-2])(?::[0-5]\d)?\s*(?:am|pm)|(?:[01]?\d|2[0-3]):[0-5]\d|noon|midday|midnight)\b/i
const PARTY = /\b(?:for\s+(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\b(?!\s*(?:am\b|pm\b|:|hours?\b|minutes?\b))|(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:guests?|people|persons?|pax|adults?)\b)/i
const COUNTS = ['one','two','three','four','five','six','seven','eight','nine','ten']
const QUESTIONS = {
  booking_type:'What would you like to book?',
  date:'What date would you like?',
  time:'What time would you prefer? Please include AM or PM.',
  party_size:'How many guests should I include?',
  service:'What would you like the appointment for?',
  name:'What name should I put on the request?'
}
const FIELDS = {
  table:['date','time','party_size','name'],
  appointment:['service','date','time','name']
}

function bookingTopic(text) {
  return /\b(?:appointments?|(?:my|our|existing) booking|booking policy|reservations?)\b/i.test(text) || (TABLE.test(text) && (BOOKING.test(text) || /\btable for|available|availability\b/i.test(text))) ||
    GENERIC_BOOKING.test(text)
}

function bookingKind(text) {
  if (!bookingTopic(text) || !REQUEST.test(text) || OTHER_INTENT.test(text) || /\b(?:my|our|existing) booking\b/i.test(text)) return null
  if (/\b(?:how (?:do|can|should) (?:i|we)|do (?:i|we) (?:have|need) to|what(?:'s| is)|what are)\b.*\b(?:book|reserve|reservation|appointment)/i.test(text)) return null
  if (/\b(?:don['’]t|do not|no longer)\s+(?:want|need|wish)\b/i.test(text)) return null
  if (/\bappointments?\b/i.test(text)) return 'appointment'
  return TABLE.test(text) || /\breserv(?:e|ation)\b/i.test(text) ? 'table' : 'unspecified'
}

function partySize(value) {
  if (!value) return null
  const count = Number(value) || COUNTS.indexOf(value.toLowerCase()) + 1
  return count > 0 && count <= 999 ? String(count) : null
}

function extract(text, type, pending, isNew) {
  const details = {}
  const date = text.match(DATE)?.[0]
  const time = text.match(TIME)?.[0]
  const party = text.replace(DATE, ' ').replace(TIME, ' ').match(PARTY)
  const count = partySize(party?.[1] || party?.[2] ||
    (pending === 'party_size' && /^(?:\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)[.!]?$/.test(text.toLowerCase()) ? text.replace(/[.!]$/, '') : null))
  const name = text.match(/\b(?:under(?: the name)?|my name is|name is)\s+([\p{L}][\p{L}\p{M}'’ -]{0,78}?)(?=\s+(?:for|on|at|today|tomorrow|this|next)\b|[,.!?]|$)/iu)?.[1]?.trim()
  if (date) details.date = date
  if (time) details.time = time
  if (type !== 'appointment' && count) details.party_size = count
  if (name) details.name = name
  if (!isNew && !date && !time && !count && !/[?\n]/.test(text) &&
      !/^(?:ok(?:ay)?|thanks?|thank you|sure|yes|no|hi|hello|goodbye|stop|menu|where|when|how|what|send|show|can|do|please|sorry|tell|give|share)\b/i.test(text)) {
    if (pending === 'name' && /^(?:[\p{L}][\p{L}\p{M}'’-]*)(?: [\p{L}][\p{L}\p{M}'’-]*){0,4}[.!]?$/u.test(text)) details.name ||= text.replace(/[.!]$/, '')
    if (pending === 'service' && /^[\p{L}\p{N}][\p{L}\p{N}\p{M}'’ &-]{0,79}[.!]?$/u.test(text)) details.service = text.replace(/[.!]$/, '')
  }
  if (type === 'appointment') {
    const service = text.match(/\bappointment\s+for\s+([^,?.!]+?)(?=\s+(?:on|at|this|next|tomorrow|today|under)\b|[,?.!]|$)/i)?.[1]?.trim()
    if (service && !DATE.test(service) && !TIME.test(service)) details.service = service.slice(0,80)
  }
  return details
}

function requestSummary(type, details) {
  const request = type === 'table' ? `a table for ${details.party_size}` : `an appointment for ${details.service}`
  return `Thanks, ${details.name}. I’ll pass along your request for ${request} ${details.date} at ${details.time}.`
}

function bookingTurn(message, existingContext) {
  const text = String(message || '').trim().slice(0,500)
  if (!text || OTHER_INTENT.test(text)) return null
  const requested = bookingKind(text)
  const previous = existingContext?.action_type === 'booking' && existingContext.stage === 'booking_qualifying' ? existingContext : null
  let type = requested && requested !== 'unspecified' ? requested : previous?.booking_type || requested
  if (type !== 'unspecified' && !Object.hasOwn(FIELDS, type)) return null
  const typeAnswer = type === 'unspecified' ? text.match(BOOKING_TYPE_ANSWER)?.[1].toLowerCase() : null
  if (typeAnswer) type = typeAnswer
  const continuing = previous && (previous.booking_type === type || previous.booking_type === 'unspecified')
  const details = extract(text, type, continuing ? previous.pending_field : null, Boolean(requested))
  if (!requested && !typeAnswer && !Object.keys(details).length) return null
  const collected = { ...(continuing ? previous.collected : {}), ...details }
  if (type === 'unspecified' && collected.party_size) type = 'table'
  const context = {
    action_type:'booking',
    stage:'booking_qualifying',
    booking_type:type,
    handoff_reason:type === 'table' ? 'Table reservation request' : type === 'appointment' ? 'Appointment request' : 'Booking request',
    collected
  }
  const pending = type === 'unspecified' ? 'booking_type' : FIELDS[type].find(field => !collected[field])
  if (pending) return { kind:'qualify', reply:QUESTIONS[pending], context:{ ...context, pending_field:pending } }
  return { kind:'handoff', reason:'booking_requested', reply:requestSummary(type,collected), context:{ ...context, stage:'ready_for_handoff' } }
}

function replayBooking(history) {
  let context = null
  for (const turn of history || []) {
    if (turn.role !== 'user') continue
    const next = bookingTurn(turn.content, context)
    if (next) context = next.kind === 'qualify' ? next.context : null
  }
  return context
}

module.exports = { bookingTopic, bookingTurn, replayBooking }
