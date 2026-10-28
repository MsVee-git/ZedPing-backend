// Confirm external readiness without re-registering a phone or creating an app.
async function reconcileWhatsAppConnection({db,customerId,connection,mapping,partner,meta,accessToken,callbackUrl,webhookSecret,routingReady=true}) {
 if(!connection || connection.customer_id!==customerId)throw new Error('Invalid connection ownership')
 if(connection.status==='connected')return {phase:'complete',connection}
 if(mapping){
  if(mapping.customer_id!==customerId || mapping.whatsapp_number_id!==connection.id)throw new Error('Invalid mapping ownership')
  if(!mapping.app_id)return {phase:mapping.link_state==='confirmation_required'?'confirmation_required':'in_progress',connection}
  if(!routingReady)return {phase:'in_progress',connection}
  const status=await partner.getAppStatus(mapping.app_id)
  if(!status.provisioned)return {phase:status.creationStage==='ERROR'?'confirmation_required':'in_progress',connection}
  await partner.ensureSubscription(mapping.app_id,{callbackUrl,webhookSecret})
 } else {
  if(!accessToken || !connection.provisioning_registration_attempted_at)return {phase:'in_progress',connection}
  const status=await meta.getRegistrationStatus(connection.phone_number_id,accessToken)
  if(!status.connected)return {phase:'confirmation_required',connection}
  await meta.subscribeApp(connection.whatsapp_business_account_id,accessToken)
 }
 const now=new Date().toISOString()
 const saved=await db.from('whatsapp_numbers').update({status:'connected',provisioning_state:'operational',provisioning_error:null,provisioned_at:now})
  .eq('id',connection.id).eq('customer_id',customerId).select('id,customer_id,phone_number,phone_number_id,whatsapp_business_account_id,display_name,status,provisioning_state,provisioning_error,provisioned_at').single()
 if(saved.error)throw saved.error
 const customer=await db.from('customers').update({whatsapp_connected_at:now}).eq('id',customerId).is('whatsapp_connected_at',null)
 if(customer.error)throw customer.error
 const sessions=await db.from('whatsapp_connection_sessions').update({completed_at:now,whatsapp_number_id:connection.id})
  .eq('customer_id',customerId).eq('signup_phone_number_id',connection.phone_number_id).is('completed_at',null)
 if(sessions.error)throw sessions.error
 return {phase:'complete',connection:saved.data}
}
module.exports={reconcileWhatsAppConnection}
