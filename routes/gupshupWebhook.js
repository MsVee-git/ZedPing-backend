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
      try { events = normalizeGupshupIncoming(req.body, mapping, result.data) } catch { return res.sendStatus(422) }
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
