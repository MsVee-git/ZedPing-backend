const crypto = require('node:crypto')

const GUPSHUP_APP_NAME_MAX_LENGTH = 150
const GUPSHUP_APP_NAME_SUFFIX_LENGTH = 16

function appNameForConnection(connectionId, businessName = '') {
  const suffix = crypto.createHash('sha256').update(String(connectionId)).digest('hex').slice(0, GUPSHUP_APP_NAME_SUFFIX_LENGTH)
  // Gupshup accepts alphanumeric app names only. Keep a recognizable workspace
  // prefix while reserving enough room for the stable connection-specific suffix.
  const safeBusinessName = String(businessName).replace(/[^A-Za-z0-9]/g, '')
  const remaining = GUPSHUP_APP_NAME_MAX_LENGTH - 'ZedPing'.length - suffix.length
  return `ZedPing${safeBusinessName.slice(0, remaining)}${suffix}`
}

// Store must provide atomic claimLink, markLinked and markConfirmationRequired.
// It must scope every operation to the supplied customer and connection.
// Call only after signed-session and Meta ownership validation, never from raw FINISH data.
async function linkVerifiedConnection({ customerId, connection, walletId, callbackUrl, appName, store, partner }) {
  if (!customerId || !connection?.id || connection.customer_id !== customerId ||
      connection.provider !== 'gupshup') throw new Error('Invalid Gupshup connection ownership')
  if (connection.gupshup_app_id) return { kind: 'linked', appId: connection.gupshup_app_id }
  if (typeof appName !== 'string' || !/^[A-Za-z0-9]{6,150}$/.test(appName)) throw new Error('Invalid Gupshup app name')
  const claimed = await store.claimLink({ customerId, connectionId: connection.id })
  if (!claimed) return { kind: 'in_progress_or_confirmation_required' }
  try {
    const { appId } = await partner.linkApp({
      name: appName,
      wabaId: connection.whatsapp_business_account_id,
      phone: connection.phone_number,
      walletId, callbackUrl
    })
    await store.markLinked({ customerId, connectionId: connection.id, appId })
    return { kind: 'linked', appId }
  } catch {
    // A timeout or database failure may follow successful provider creation.
    // Do not reclaim/retry this mutation until provider mapping is reconciled.
    await store.markConfirmationRequired({ customerId, connectionId: connection.id })
    throw new Error('Gupshup app linking requires confirmation')
  }
}

module.exports = { GUPSHUP_APP_NAME_MAX_LENGTH, appNameForConnection, linkVerifiedConnection }

