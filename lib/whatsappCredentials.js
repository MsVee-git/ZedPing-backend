const { createCredentialVault } = require('./credentialVault')

class WhatsAppCredentialError extends Error {
  constructor() {
    super('The WhatsApp connection credential is unavailable. Reconnect this account or contact support.')
    this.name = 'WhatsAppCredentialError'
  }
}

// Only pass a canonical number loaded server-side for the active workspace.
// Embedded Signup credentials never fall back to the shared legacy system user.
async function resolveWhatsAppAccessToken(number, { customerId = number?.customer_id, vault = null, env = process.env } = {}) {
  if (!number || !customerId || number.customer_id !== customerId || !/^[0-9]{5,32}$/.test(String(number.phone_number_id || ''))) {
    throw new WhatsAppCredentialError()
  }
  let stored
  try {
    stored = await (vault || createCredentialVault()).get({
      customerId,
      integration: 'meta_whatsapp',
      credentialKey: `phone_${number.phone_number_id}`
    })
  } catch (_) {
    // Database, configuration and decryption failures must never switch identity.
    throw new WhatsAppCredentialError()
  }
  if (typeof stored === 'string' && stored.trim()) return stored.trim()
  if (stored != null || number.provisioning_state || number.provisioned_at) throw new WhatsAppCredentialError()
  const legacy = String(number.access_token || env.META_ACCESS_TOKEN || '').trim()
  if (!legacy) throw new WhatsAppCredentialError()
  return legacy
}

module.exports = { resolveWhatsAppAccessToken, WhatsAppCredentialError }
