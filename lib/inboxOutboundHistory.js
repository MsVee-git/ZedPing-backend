// Orphaned outbound messages include broadcasts sent before a conversation
// existed. Show their recorded content, never infer a native quoted reply.
async function loadOutboundHistory(db, customerId, conversation) {
 if (!conversation.contact_id) return []
 const {data,error}=await db.from('messages')
  .select('id,direction,to_number,from_number,message_body,status,created_at,meta_message_id')
  .eq('customer_id',customerId).eq('whatsapp_number_id',conversation.whatsapp_number_id)
  .eq('contact_id',conversation.contact_id).eq('direction','outbound').is('conversation_id',null)
  .order('created_at',{ascending:false}).limit(50)
 if(error)throw error
 return (data||[]).map(message=>({...message,message_body:'[Earlier outbound message — background, not a quoted reply]\n'+(message.message_body||'[Message content not recorded]')}))
}
function mergeOutboundHistory(messages,history){
 const byId=new Map(history.map(m=>[m.id,m]));for(const m of messages||[])byId.set(m.id,m)
 return [...byId.values()].sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at)))
}
module.exports={loadOutboundHistory,mergeOutboundHistory}
