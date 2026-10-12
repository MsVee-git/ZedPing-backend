const crypto = require('node:crypto')

function appNameForConnection(connectionId) {
  return `ZedPing${crypto.createHash('sha256').update(String(connectionId)).digest('hex').slice(0, 32)}`
}

// Store must provide atomic claimLink, markLinked and markConfirmationRequired.
// It must scope every operation to the supplied customer and connection.
// Call only after signed-session and Meta ownership validation, never from raw FINISH data.
async function linkVerifiedConnection({ customerId, connection, walletId, callbackUrl, store, partner }) {
  if (!customerId || !connection?.id || connection.customer_id !== customerId ||
      connection.provider !== 'gupshup') throw new Error('Invalid Gupshup connection ownership')
  if (connection.gupshup_app_id) return { kind: 'linked', appId: connection.gupshup_app_id }
  const claimed = await store.claimLink({ customerId, connectionId: connection.id })
  if (!claimed) return { kind: 'in_progress_or_confirmation_required' }
  try {
    const { appId } = await partner.linkApp({
      name: appNameForConnection(connection.id),
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

module.exports = { appNameForConnection, linkVerifiedConnection }
