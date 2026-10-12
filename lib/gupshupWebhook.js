const crypto = require('node:crypto')

// Shared-secret header is supported by subscription `meta`.
// This is authentication, not a provider payload signature.
function authenticateGupshupWebhook(received, expected) {
  if (typeof expected !== 'string' || expected.length < 32 ||
      typeof received !== 'string' || received.length > 512) return false
  const a = crypto.createHash('sha256').update(received).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}

function validateGupshupEventMapping(event, mapping) {
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      !mapping?.customer_id || !mapping?.whatsapp_number_id ||
      !mapping?.app_id || event.appId !== mapping.app_id) return false
  // App ID, rather than client-controlled workspace identifiers, resolves ownership.
  return typeof event.type === 'string' && event.type.length <= 100
}

module.exports = { authenticateGupshupWebhook, validateGupshupEventMapping }
