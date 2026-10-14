const STATUSES = new Set(['sent','delivered','read','failed'])
function safeErrors(errors) {
 return (Array.isArray(errors) ? errors : []).slice(0,5).map(error => ({
  code: /^\\d{1,12}$/.test(String(error?.code)) ? String(error.code) : 'unknown',
  title: typeof error?.title === 'string' ? error.title.slice(0,160) : 'Delivery failed; provider did not supply a reason'
 }))
}
function receiptRows(statuses, number, provider='meta') {
 if (!number?.customer_id || !number?.id) throw new Error('Receipt workspace required')
 if (!Array.isArray(statuses) || statuses.length>1000) throw new Error('Invalid receipt batch')
 return statuses.filter(s=>STATUSES.has(s?.status)).map(s=>{
  const id=typeof s.id==='string'&&s.id ? s.id : s.gs_id
  if(typeof id!=='string' || !id || id.length>255 || !/^\\d{1,12}$/.test(String(s.timestamp))) throw new Error('Invalid delivery receipt')
  const at = new Date(Number(s.timestamp)*1000)
  if(!Number.isFinite(at.getTime()) || at.getTime()>Date.now()+86400000) throw new Error('Invalid receipt timestamp')
  return {customer_id:number.customer_id,whatsapp_number_id:number.id,provider,message_id:id,
   alternate_message_id:typeof s.gs_id==='string'&&s.gs_id.length<=255?s.gs_id:null,status:s.status,occurred_at:at.toISOString(),errors:safeErrors(s.errors)}
 })
}
async function persistDeliveryStatuses(db,statuses,number,provider='meta') {
 const rows=receiptRows(statuses,number,provider)
 if(!rows.length)return
 const {error}=await db.from('message_delivery_events').upsert(rows,{onConflict:'customer_id,whatsapp_number_id,provider,message_id,status,occurred_at',ignoreDuplicates:true})
 if(error)throw new Error('Unable to save delivery receipts')
}
async function persistMetaDeliveryPayload(db,payload) {
 for(const entry of payload?.entry||[])for(const change of entry.changes||[]){
  const value=change.value||{}
  if(!Array.isArray(value.statuses)||!value.statuses.length)continue
  const phone=value.metadata?.phone_number_id
  if(typeof phone!=='string'||!phone)throw new Error('Receipt phone missing')
  const {data,error}=await db.from('whatsapp_numbers').select('id,customer_id,whatsapp_business_account_id').eq('phone_number_id',phone).limit(2)
  if(error)throw new Error('Receipt connection lookup failed')
  if(!data?.length)continue
  if(data.length!==1)throw new Error('Receipt connection ambiguous')
  const number=data[0]
  if(number.whatsapp_business_account_id&&entry.id&&number.whatsapp_business_account_id!==entry.id)throw new Error('Receipt business mismatch')
  await persistDeliveryStatuses(db,value.statuses,number)
 }
}
module.exports={safeErrors,receiptRows,persistDeliveryStatuses,persistMetaDeliveryPayload}
