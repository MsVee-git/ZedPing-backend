const { persistDeliveryStatuses } = require('../lib/deliveryReceipts')
const express = require('express')
const { authenticateGupshupWebhook } = require('../lib/gupshupWebhook')
const { normalizeGupshupIncoming, persistGupshupEvents } = require('../lib/gupshupIncoming')

// Not mounted until the queue worker and provider-aware replies are ready.
function createGupshupWebhookRouter({ db, webhookSecret }) {
  const router = express.Router()
  router.post('/', async (req, res) => {
    if (!authenticateGupshupWebhook(req.get('X-Gupshup-Webhook-Secret'), webhookSecret)) return res.sendStatus(401)
    try {
      const appId = req.body?.gs_app_id
      if (typeof appId !== 'string' || !/^[A-Za-z0-9-]+$/.test(appId)) return res.sendStatus(400)
      const { data: mapping, error } = await db.from('gupshup_connection_mappings').select('*').eq('app_id', appId).eq('link_state', 'linked').maybeSingle()
      if (error) throw error
      if (!mapping) return res.sendStatus(403)
      const result = await db.from('whatsapp_numbers').select('*').eq('id', mapping.whatsapp_number_id).eq('customer_id', mapping.customer_id).maybeSingle()
      if (result.error) throw result.error
      if (!result.data) return res.sendStatus(403)
      let events
      try { events = normalizeGupshupIncoming(req.body, mapping, result.data) } catch (error) {
        // Only local fixed validation messages and structural metadata; never message text or tokens.
        console.warn('gupshup_callback_rejected', JSON.stringify({
          stage: error.message, appId,
          entries: (Array.isArray(req.body.entry) ? req.body.entry : []).slice(0, 5).map(entry => ({
            wabaMatches: !entry.id || entry.id === result.data.whatsapp_business_account_id,
            changes: (entry.changes || []).slice(0, 5).map(change => ({
              field: change.field, phoneMatches: !change.value?.metadata?.phone_number_id || change.value.metadata.phone_number_id === result.data.phone_number_id,
              statuses: (change.value?.statuses || []).slice(0, 5).map(status => ({
                status: status.status, hasId: Boolean(status.id), hasGsId: Boolean(status.gs_id),
                codes: [status.code, ...(status.errors || []).map(e => e.code)].filter(code => /^[0-9]{1,12}$/.test(String(code)))
              }))
            }))
          }))
        }))
        return res.sendStatus(422)
      }
      for (const entry of req.body.entry || []) for (const change of entry.changes || []) {
        const statuses = (change.value?.statuses || []).filter(s=>s.type!=='set-callback');
        await persistDeliveryStatuses(db,statuses,result.data,'gupshup');
      }
      await persistGupshupEvents(db, mapping, events)
      return res.status(200).end()
    } catch {
      // Non-2xx lets Gupshup retry; do not acknowledge lost events.
      return res.sendStatus(503)
    }
  })
  return router
}
module.exports = { createGupshupWebhookRouter }
