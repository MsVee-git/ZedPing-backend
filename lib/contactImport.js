const E164 = /^\+[1-9]\d{7,14}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_ROWS = 1000

function cleanText(value, max = 255) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max)
}

function normalizePhone(value, { country = 'ZM' } = {}) {
  const raw = cleanText(value, 80)
  if (!raw) throw new Error('Missing phone number')
  let compact = raw.replace(/[\s().-]/g, '')
  if (compact.startsWith('00')) compact = '+' + compact.slice(2)
  if (compact.startsWith('+')) {
    if (!E164.test(compact)) throw new Error('We could not recognise this phone number.')
    return compact
  }
  if (!/^\d+$/.test(compact)) throw new Error('We could not recognise this phone number.')

  if (country === 'ZM') {
    if (/^0\d{9}$/.test(compact)) return '+260' + compact.slice(1)
    if (/^9\d{8}$/.test(compact)) return '+260' + compact
    if (/^2609\d{8}$/.test(compact)) return '+' + compact
  }
  throw new Error('We could not recognise this phone number.')
}

function readMapping(mapping, width) {
  const mapped = {}
  for (const field of ['phone', 'name', 'email']) {
    const value = mapping?.[field]
    if (value === null || value === undefined || value === '') continue
    if (!Number.isInteger(value) || value < 0 || value >= width) throw new Error('Choose valid columns before continuing.')
    mapped[field] = value
  }
  if (!Number.isInteger(mapped.phone)) throw new Error('Choose one column for phone numbers.')
  const indexes = Object.values(mapped)
  if (new Set(indexes).size !== indexes.length) throw new Error('A column can only be used once.')
  return mapped
}

function normalizedExistingContacts(contacts, country) {
  const byPhone = new Map()
  for (const contact of contacts || []) {
    let phone = contact.phone_e164 || ''
    try { phone = phone || normalizePhone(contact.phone_number, { country }) } catch { continue }
    if (!byPhone.has(phone)) byPhone.set(phone, contact)
  }
  return byPhone
}

function buildImportPlan({ headers, rows, mapping, existingContacts, country = 'ZM' }) {
  if (!Array.isArray(headers) || !Array.isArray(rows)) throw new Error('The file could not be read.')
  if (headers.length < 1 || headers.length > 50) throw new Error('The file must include between 1 and 50 columns.')
  if (rows.length < 1) throw new Error('The file has no contact rows.')
  if (rows.length > MAX_ROWS) throw new Error('This beta import supports up to 1,000 rows at a time.')
  const fields = readMapping(mapping, headers.length)
  const existingByPhone = normalizedExistingContacts(existingContacts, country)
  const seen = new Set()
  const entries = []
  const preview = []
  let invalidRows = 0
  let duplicateRows = 0
  let existingCount = 0
  let newCount = 0

  rows.forEach((rawRow, index) => {
    const row = Array.isArray(rawRow) ? rawRow : []
    const rowNumber = index + 2
    const phoneRaw = row[fields.phone]
    const name = fields.name === undefined ? '' : cleanText(row[fields.name], 160)
    const email = fields.email === undefined ? '' : cleanText(row[fields.email], 254).toLowerCase()
    let phone
    let reason = ''
    try { phone = normalizePhone(phoneRaw, { country }) } catch (error) { reason = error.message }
    if (!reason && email && !EMAIL.test(email)) reason = 'Invalid email address'
    if (!reason && seen.has(phone)) { reason = 'Duplicate within uploaded file'; duplicateRows += 1 }
    if (reason) {
      invalidRows += 1
      if (preview.length < 20) preview.push({ row_number: rowNumber, status: 'skipped', name, phone_number: cleanText(phoneRaw, 80), email, reason })
      return
    }
    seen.add(phone)
    const existing = existingByPhone.get(phone)
    const entry = { phone_e164: phone, name, email, existing_contact_id: existing?.id || null }
    entries.push(entry)
    if (existing) existingCount += 1
    else newCount += 1
    if (preview.length < 20) preview.push({ row_number: rowNumber, status: existing ? 'existing' : 'new', name, phone_number: phone, email, reason: '' })
  })

  return {
    entries,
    preview,
    summary: {
      total_rows: rows.length,
      valid_rows: entries.length,
      new_contacts: newCount,
      existing_contacts: existingCount,
      invalid_rows: invalidRows,
      duplicate_rows: duplicateRows
    }
  }
}

function safeFilename(value) {
  return cleanText(String(value || '').split(/[\\/]/).pop(), 180)
}

module.exports = { MAX_ROWS, normalizePhone, readMapping, buildImportPlan, safeFilename }
