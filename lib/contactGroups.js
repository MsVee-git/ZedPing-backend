function normalizeGroupName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

function validateGroupName(value) {
  const name = normalizeGroupName(value)
  if (!name) throw new Error('Enter a contact group name.')
  if (name.length > 100) throw new Error('Contact group names must be 100 characters or fewer.')
  return name
}

function isUniqueViolation(error) {
  return error?.code === '23505'
}

module.exports = { normalizeGroupName, validateGroupName, isUniqueViolation }
