// Explicitly invoked pilot worker; no startup scheduling or live activation.
async function processGupshupInboxBatch(db, limit = 20, kind = 'message') {
 if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid Gupshup batch limit')
 if (!['message','status'].includes(kind)) throw new Error('Invalid event kind')
 let processed = 0
 for (; processed < limit; processed++) {
  const { data, error } = await db.rpc(kind === 'message' ? 'process_next_gupshup_text_event' : 'process_next_gupshup_delivery_event')
  if (error) throw new Error('Gupshup inbox transaction failed')
  if (!data) break
 }
 return { processed }
}
module.exports = { processGupshupInboxBatch }
