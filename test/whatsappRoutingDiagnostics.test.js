const test=require('node:test')
const assert=require('node:assert/strict')
const {inspectMetaRouting,metaMessageChange}=require('../lib/whatsappRoutingDiagnostics')
const number={phone_number_id:'123456789'}
test('routing check is GET-only and returns only documented safe fields',async()=>{
 const token='PRIVATE'
 const result=await inspectMetaRouting(number,token,{fetchImpl:async(url,options)=>{
  assert.ok(url.endsWith('/123456789/routing_roles'))
  assert.equal(options.headers.Authorization,'Bearer PRIVATE')
  assert.equal(options.body,undefined)
  return {ok:true,json:async()=>({roles:['customer_service','secret-role'],is_standby:false,token:'PRIVATE'})}
 }})
 assert.deepEqual(result,{state:'checked',roles:['customer_service'],is_standby:false})
 assert.ok(!JSON.stringify(result).includes(token))
})
test('routing failures never leak provider errors or infer disabled from code 100 alone',async()=>{
 const result=await inspectMetaRouting(number,'PRIVATE',{fetchImpl:async()=>({ok:false,status:400,json:async()=>({error:{code:100,message:'PRIVATE'}})})})
 assert.deepEqual(result,{state:'unavailable',http_status:400,error_code:100,routing_disabled:false})
})
test('standby and handover webhooks must not start normal message automation',()=>{
 assert.equal(metaMessageChange({field:'messages'}),true)
 for(const field of ['standby','messaging_handovers','account_update',undefined]) assert.equal(metaMessageChange({field}),false)
})
