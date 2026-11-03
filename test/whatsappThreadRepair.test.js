const test=require('node:test')
const assert=require('node:assert/strict')
const {passToService,repairFailedThread}=require('../lib/whatsappThreadRepair')
test('repair passes only to configured customer service and never takes control or sends messages',async()=>{
 const result=await passToService({phone_number_id:'123456'},'PRIVATE','260978748066',{fetchImpl:async(url,opts)=>{
  assert.ok(url.endsWith('/123456/thread_control'))
  assert.deepEqual(JSON.parse(opts.body),{messaging_product:'whatsapp',to:'260978748066',action:'pass',control_pass:{target_role:'customer_service'}})
  return {ok:true,json:async()=>({request_id:'r1'})}
 }})
 assert.deepEqual(result,{state:'passed'})
})
test('unsupported thread control is reported without leaking response data',async()=>{
 const result=await passToService({phone_number_id:'123456'},'PRIVATE','260978748066',{fetchImpl:async()=>({ok:false,status:400,json:async()=>({error:{code:100,message:'Pass action is not supported. PRIVATE',fbtrace_id:'trace1'}})})})
 assert.equal(result.reason,'feature_not_enabled')
 assert.ok(!JSON.stringify(result).includes('PRIVATE'))
})
test('an ambiguous timeout cannot be automatically retried',async()=>{
 let calls=0
 const result=await passToService({phone_number_id:'123456'},'PRIVATE','260978748066',{fetchImpl:async()=>{calls++;throw Error('PRIVATE')}})
 assert.equal(calls,1);assert.deepEqual(result,{state:'unconfirmed'})
})
test('operator repair is disabled without an explicit target',async()=>{
 await repairFailedThread({db:{from(){throw Error('no database calls allowed')}}})
})
test('releasing a legacy thread does not pass to an unsupported role or send messages',async()=>{
 const result=await passToService({phone_number_id:'123456'},'PRIVATE','260978748066',{action:'release',fetchImpl:async(url,opts)=>{
  assert.ok(url.endsWith('/thread_control'))
  assert.deepEqual(JSON.parse(opts.body),{messaging_product:'whatsapp',to:'260978748066',action:'release'})
  return {ok:true,json:async()=>({request_id:'release1'})}
 }})
 assert.deepEqual(result,{state:'released'})
})
test('operator cannot take control or target arbitrary actions',async()=>{
 await assert.rejects(passToService({phone_number_id:'123456'},'PRIVATE','260978748066',{action:'take',fetchImpl:async()=>{throw Error('must not call')}}),/Invalid thread repair/)
})
