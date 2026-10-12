// Dispatch only durably persisted messages. Claims are never reclaimed
// automatically: an interrupted model/send call may already have had effects.
async function processGupshupAutomationBatch({ db, runAutomation, limit = 20 }) {
 if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid automation batch limit')
 const selected = await db.from('gupshup_webhook_events').select('*').eq('event_type','message').eq('processing_state','complete').eq('automation_state','pending').order('created_at').limit(limit)
 if (selected.error) throw new Error('Unable to load automation queue')
 let processed = 0
 for (const event of selected.data || []) {
  const claimed = await db.from('gupshup_webhook_events').update({ automation_state:'processing' }).eq('id',event.id).eq('automation_state','pending').select('id').maybeSingle()
  if (claimed.error) throw new Error('Unable to claim automation event')
  if (!claimed.data) continue
  try {
   const message = await db.from('messages').select('*').eq('customer_id',event.customer_id).eq('whatsapp_number_id',event.whatsapp_number_id).eq('meta_message_id',event.payload.message_id).eq('direction','inbound').single()
   if (message.error) throw message.error
   const [number,contact,conversation] = await Promise.all([
    db.from('whatsapp_numbers').select('*').eq('id',event.whatsapp_number_id).eq('customer_id',event.customer_id).single(),
    db.from('contacts').select('*').eq('id',message.data.contact_id).eq('customer_id',event.customer_id).single(),
    db.from('conversations').select('*').eq('id',message.data.conversation_id).eq('customer_id',event.customer_id).single()
   ])
   if ([number,contact,conversation].some(r=>r.error)) throw new Error('Invalid automation context')
   await runAutomation({customerId:event.customer_id,number:number.data,contact:contact.data,conversation:conversation.data,from:message.data.from_number,body:message.data.message_body,metaId:message.data.meta_message_id,media:message.data.inbound_media,replyContextMetaId:message.data.reply_context_meta_id})
   const done = await db.from('gupshup_webhook_events').update({automation_state:'complete'}).eq('id',event.id).eq('automation_state','processing')
   if (done.error) throw done.error
   processed++
  } catch {
   await db.from('gupshup_webhook_events').update({automation_state:'confirmation_required'}).eq('id',event.id).eq('automation_state','processing')
  }
 }
 return {processed}
}
module.exports={processGupshupAutomationBatch}
