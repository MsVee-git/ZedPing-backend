// Read-only, bounded connection checks. Never log tokens, headers, message bodies,
// callback URLs or provider response bodies. Roles are for the token's business.
const ROLES = new Set(['customer_service','ctwa','marketing','utility','calls','escalation'])
async function inspectMetaRouting(number, token, {fetchImpl = globalThis.fetch, version = 'v26.0'} = {}) {
  if (!/^[0-9]{5,32}$/.test(number?.phone_number_id || '') || !token || !/^v[0-9]+\.0$/.test(version)) throw new Error('Invalid routing check')
  try {
    const response = await fetchImpl(`https://graph.facebook.com/${version}/${number.phone_number_id}/routing_roles`, {
      headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000),redirect:'error'
    })
    const data = await response.json()
    if (!response.ok) return {state:'unavailable',http_status:response.status,
      error_code:Number.isInteger(data.error?.code)?data.error.code:null,
      routing_disabled:data.error?.code===100 && data.error?.message==='Conversation routing is not enabled for this phone number.'}
    if (!Array.isArray(data.roles) || typeof data.is_standby !== 'boolean') return {state:'invalid_response'}
    return {state:'checked',roles:data.roles.filter(role=>ROLES.has(role)),is_standby:data.is_standby}
  } catch {return {state:'unavailable'}}
}
function metaMessageChange(change) {return change?.field === 'messages'}
async function inspectConnectedRouting({db,resolveToken,diagnostic,fetchImpl=globalThis.fetch,env=process.env}) {
  const rows = await db.from('gupshup_connection_mappings').select('customer_id,app_id,whatsapp_numbers!inner(*)')
    .eq('link_state','linked').eq('whatsapp_numbers.status','connected').limit(20)
  if (rows.error) throw new Error('Unable to inspect routing')
  for (const row of rows.data || []) {
    const number = row.whatsapp_numbers
    if (number?.customer_id !== row.customer_id) continue
    try {
      const config=require('./gupshupConfig').gupshupConfigForCustomer(row.customer_id,env,'messaging')
      if(config) {
        const identity=await require('./gupshupPartner').createGupshupPartnerClient({...config,fetchImpl}).inspectConnectionIdentity(row.app_id,number.phone_number)
        diagnostic({event:'gupshup_connection_identity',connection_id:number.id,app_id:row.app_id,...identity})
      }
    } catch {diagnostic({event:'gupshup_connection_identity',connection_id:number.id,state:'unavailable'})}
    let routing
    try {routing=await inspectMetaRouting(number,await resolveToken(number,{customerId:row.customer_id}),{fetchImpl,version:env.META_GRAPH_VERSION||'v26.0'})}
    catch {routing={state:'credential_unavailable'}}
    diagnostic({event:'whatsapp_routing_check',connection_id:number.id,send_provider:'gupshup',gupshup_app_id:row.app_id,meta_token_business:routing})
  }
}
module.exports={inspectMetaRouting,inspectConnectedRouting,metaMessageChange}
