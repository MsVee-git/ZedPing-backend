function normalizePhone(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  if (!digits) return null

  if (raw.startsWith('+') && /^[1-9]\d{7,14}$/.test(digits)) return '+' + digits
  if (digits.startsWith('260') && /^260\d{9}$/.test(digits)) return '+' + digits
  if (/^0\d{9}$/.test(digits)) return '+260' + digits.slice(1)
  if (/^[79]\d{8}$/.test(digits)) return '+260' + digits
  if (/^[1-9]\d{7,14}$/.test(digits)) return '+' + digits
  return null
}

function transientRecipient(input) {
  const phone_number = normalizePhone(input?.phone_number ?? input?.phone ?? input?.number)
  if (!phone_number) return null
  const name = String(input?.name || '').trim().slice(0, 160)
  return { name, phone_number }
}

function dedupeRecipients(recipients) {
  const seen = new Set()
  return recipients.filter((recipient) => {
    if (!recipient?.phone_number || seen.has(recipient.phone_number)) return false
    seen.add(recipient.phone_number)
    return true
  })
}

module.exports = { normalizePhone, transientRecipient, dedupeRecipients }
