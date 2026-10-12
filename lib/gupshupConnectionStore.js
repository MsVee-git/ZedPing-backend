const { appNameForConnection } = require('./gupshupOnboarding')

function createGupshupConnectionStore(db) {
  async function load({ customerId, connectionId }) {
    const { data, error } = await db.from('gupshup_connection_mappings').select('*')
      .eq('customer_id', customerId).eq('whatsapp_number_id', connectionId).maybeSingle()
    if (error) throw new Error('Unable to load Gupshup mapping')
    return data
  }
  async function ensure({ customerId, connectionId, walletId }) {
    const { error } = await db.from('gupshup_connection_mappings').insert({
      customer_id: customerId, whatsapp_number_id: connectionId,
      app_name: appNameForConnection(connectionId), wallet_id: walletId
    })
    if (error && error.code !== '23505') throw new Error('Unable to prepare Gupshup mapping')
    const mapping = await load({ customerId, connectionId })
    if (!mapping || mapping.wallet_id !== walletId) throw new Error('Gupshup mapping requires review')
    return mapping
  }
  async function transition({ customerId, connectionId }, from, patch) {
    const { data, error } = await db.from('gupshup_connection_mappings').update({ ...patch, updated_at: new Date().toISOString() })
      .eq('customer_id', customerId).eq('whatsapp_number_id', connectionId).eq('link_state', from)
      .select('id').maybeSingle()
    if (error) throw new Error('Unable to update Gupshup mapping')
    return Boolean(data)
  }
  return {
    load, ensure,
    claimLink: ids => transition(ids, 'prepared', { link_state: 'linking', claimed_at: new Date().toISOString() }),
    markLinked: async ({ appId, ...ids }) => {
      if (!await transition(ids, 'linking', { link_state: 'linked', app_id: appId })) throw new Error('Gupshup mapping finalization requires review')
    },
    markConfirmationRequired: ids => transition(ids, 'linking', { link_state: 'confirmation_required' })
  }
}

module.exports = { createGupshupConnectionStore }
