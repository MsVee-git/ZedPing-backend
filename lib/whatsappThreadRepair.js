// Explicit operator repair of ONE evidenced failed conversation. Disabled unless
// WHATSAPP_THREAD_REPAIR_MESSAGE_ID is set. Does not send/retry customer messages,
// change routing configuration, take control, or accept terms.
const {inspectMetaRouting}=require('./whatsappRoutingDiagnostics')
async function passToService(number,token,to,{fetchImpl=globalThis.fetch,version='v26.0',action='pass'}={}) {
 if (!/^[0-9]{5,32}$/.test(number?.phone_number_id||'') || !/^[1-9][0-9]{6,14}$/.test(to||'') || !token || !/^v[0-9]+\.0$/.test(version) || !['pass','release'].includes(action)) throw new Error('Invalid thread repair')
 try {
  const response=await fetchImpl(`https://graph.facebook.com/${version}/${number.phone_number_id}/thread_control`,{
   method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
   body:JSON.stringify({messaging_product:'whatsapp',to,action,...(action==='pass'?{control_pass:{target_role:'customer_service'}}:{})}),
   signal:AbortSignal.timeout(15000),redirect:'error'
  })
  const data=await response.json()
  if(response.ok && (data.request_id || data.success===true)) return {state:action==='release'?'released':'passed'}
  const message=typeof data.error?.message==='string'?data.error.message:''
  return {state:'rejected',http_status:response.status,error_code:Number.isInteger(data.error?.code)?data.error.code:null,
   provider_reason:message==='(#100) Pass action is not supported.'?'pass_not_supported':message==='Method not supported for this endpoint.'?'endpoint_not_supported':/Target role.*not supported/.test(message)?'target_role_not_supported':null,
   reason:/terms/i.test(message)?'terms_required':/not supported|enrolled/i.test(message)?'feature_not_enabled':/controlling|own.*thread/i.test(message)?'not_thread_owner':'provider_rejected',
   trace_id:typeof data.error?.fbtrace_id==='string' && /^[A-Za-z0-9_-]{1,100}$/.test(data.error.fbtrace_id)?data.error.fbtrace_id:null}
 } catch {return {state:'unconfirmed'}} // never retry a possibly successful pass
}
async function repairFailedThread({db,resolveToken,messageId,diagnostic,fetchImpl=globalThis.fetch,env=process.env,now=Date.now}) {
 if(!/^[a-zA-Z0-9-]{8,100}$/.test(messageId||'')) return
 const result=await db.from('messages').select('*').eq('meta_message_id',messageId).eq('direction','outbound').eq('status','failed').maybeSingle()
 if(result.error || !result.data) throw new Error('Repair target unavailable')
 const message=result.data
 if(!message.delivery_receipts?.errors?.some(error=>String(error.code)==='131070') || now()-Date.parse(message.created_at)>24*60*60*1000) throw new Error('Repair evidence unavailable')
 const [numberResult,mapping,inbound]=await Promise.all([
  db.from('whatsapp_numbers').select('*').eq('id',message.whatsapp_number_id).eq('customer_id',message.customer_id).eq('status','connected').single(),
  db.from('gupshup_connection_mappings').select('app_id').eq('whatsapp_number_id',message.whatsapp_number_id).eq('customer_id',message.customer_id).eq('link_state','linked').single(),
  db.from('messages').select('meta_message_id,from_number').eq('customer_id',message.customer_id).eq('conversation_id',message.conversation_id).eq('whatsapp_number_id',message.whatsapp_number_id).eq('direction','inbound').order('created_at',{ascending:false}).limit(1).single()
 ])
 if([numberResult,mapping,inbound].some(r=>r.error) || inbound.data.from_number.replace(/[^0-9]/g,'')!==message.to_number.replace(/[^0-9]/g,'')) throw new Error('Repair connection mismatch')
 const claim=await db.from('inbound_webhook_events').select('id').eq('customer_id',message.customer_id).eq('whatsapp_number_id',message.whatsapp_number_id).eq('meta_message_id',inbound.data.meta_message_id).maybeSingle()
 if(claim.error || !claim.data) throw new Error('Direct Meta receipt required')
 const token=await resolveToken(numberResult.data,{customerId:message.customer_id})
 const options={fetchImpl,version:env.META_GRAPH_VERSION||'v26.0',action:env.WHATSAPP_THREAD_REPAIR_ACTION||'pass'}
 const routing=await inspectMetaRouting(numberResult.data,token,options)
 // Only repair a legacy owner that no longer has any configured roles. Never
 // pass a thread away from a deliberately configured primary/escalation business.
 if(routing.state!=='checked' || routing.roles.length || routing.is_standby) throw new Error('Repair routing evidence unavailable')
 const outcome=await passToService(numberResult.data,token,message.to_number.replace(/[^0-9]/g,''),options)
 diagnostic({event:'whatsapp_thread_repair',connection_id:numberResult.data.id,...outcome})
}
module.exports={passToService,repairFailedThread}
