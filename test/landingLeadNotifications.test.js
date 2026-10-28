const {test}=require('node:test')
const assert=require('node:assert/strict')
const {sendNotification,startLeadNotifications}=require('../lib/landingLeadNotifications')
const lead={id:'lead-1',business_name:'Garage\r\nOne',name:'Person',phone:'260977123456',email:'person@example.com',interest:'demo',message:'Need a demo',created_at:new Date().toISOString(),notification_next_at:new Date().toISOString(),notification_attempts:0}
test('sends only to the fixed owner inbox, includes details and reply-to, and uses a stable retry key',async()=>{
 let request
 const id=await sendNotification(lead,{env:{RESEND_API_KEY:'private',RESEND_FROM_EMAIL:'ZedPing <alerts@zedping.app>'},fetchImpl:async(url,options)=>{request=options;return {ok:true,json:async()=>({id:'email-1'})}}})
 assert.equal(id,'email-1');const body=JSON.parse(request.body)
 assert.deepEqual(body.to,['hello@zedping.app']);assert.equal(body.reply_to,lead.email)
 assert.match(body.text,/Need a demo/);assert.match(body.text,/app.zedping.app/);assert.doesNotMatch(body.subject,/[\r\n]/)
 assert.equal(request.headers['Idempotency-Key'],'website-enquiry/lead-1')
})
test('provider errors are failures, and missing configuration never calls transport',async()=>{
 await assert.rejects(sendNotification(lead,{env:{},fetchImpl:()=>assert.fail()}),/configuration/)
 await assert.rejects(sendNotification(lead,{env:{RESEND_API_KEY:'x',RESEND_FROM_EMAIL:'x'},fetchImpl:async()=>({ok:false,status:403})}),/403/)
})
async function runWorker({claimed=true,fail=false}={}){
 const updates=[];let sends=0;let finished
 const done=new Promise(resolve=>finished=resolve)
 const db={from(){let update;const query={select(){return this},is(){return this},lte(){return this},gt(){return this},order(){return this},eq(){return this},limit(){return Promise.resolve({data:[lead]})},update(value){update=value;updates.push(value);return this},maybeSingle(){if(!claimed)finished();return Promise.resolve({data:claimed?{id:lead.id}:null})},then(resolve){if(update?.notification_sent_at||updates.length>1)finished();return Promise.resolve({}).then(resolve)}};return query}}
 const stop=startLeadNotifications({db,send:async()=>{sends++;if(fail)throw new Error('private provider detail');return 'email-1'},intervalMs:100000})
 await done;await new Promise(resolve=>setImmediate(resolve));stop();return {updates,sends}
}
test('worker marks accepted notification and records provider ID',async()=>{const r=await runWorker();assert.equal(r.sends,1);assert.equal(r.updates[1].notification_provider_id,'email-1');assert.equal(r.updates[1].notification_next_at,null)})
test('worker schedules retry after failure without marking notification sent',async()=>{const r=await runWorker({fail:true});assert.equal(r.sends,1);assert.ok(r.updates[1].notification_next_at);assert.equal(r.updates[1].notification_sent_at,undefined)})
test('worker does not send when another container owns the lease',async()=>{const r=await runWorker({claimed:false});assert.equal(r.sends,0)})
