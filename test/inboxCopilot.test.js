const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const { requestMode, copilotPlan, contextFor, parseResult } = require('../lib/inboxCopilot')
const { createCopilotRouter } = require('../routes/inboxCopilot')
const id = '11111111-1111-4111-8111-111111111111'

test('Starter, inactive and unknown plans cannot use copilot', () => {
  for (const plan of ['starter','enterprise',null]) assert.equal(copilotPlan({subscription_plan:plan,subscription_status:'active'}),null)
  assert.equal(copilotPlan({subscription_plan:'business',subscription_status:'cancelled'}),null)
  assert.ok(copilotPlan({subscription_plan:'business',subscription_status:'trial'}).limit > 0)
})
test('only supported modes and conversation IDs can reach reads', () => {
  assert.throws(()=>requestMode({mode:'send'}))
  assert.throws(()=>requestMode({mode:'draft',conversation_id:'foreign-filter'}))
  assert.equal(requestMode({mode:'summary'}),'summary')
})
test('context is bounded and chronological, with no attachment content', () => {
  const conversations=Array.from({length:20},(_,i)=>({id:String(i)}))
  const messages=conversations.flatMap(c=>Array.from({length:12},(_,i)=>({conversation_id:c.id,id:String(i),message_body:'x'.repeat(5000),direction:'inbound'})))
  const context=contextFor(conversations,messages)
  assert.equal(contextFor([conversations[0]],messages)[0].messages[0].id,'11')
  assert.ok(context.every(c=>c.messages.some(m=>m.text.startsWith('x'))))
  assert.ok(context.flatMap(c=>c.messages).reduce((sum,m)=>sum+(m.text.startsWith('[No readable')?0:m.text.length),0)<=16000)
})
test('model output cannot introduce foreign conversations, stages or actions', () => {
  const result=parseResult(JSON.stringify({items:[{conversation_id:'foreign',draft:'leak'},{conversation_id:id,stage:'rich',draft:'hello'}]}),[{id,contacts:{name:'Verified name'}}],'classify')
  assert.equal(result.items.length,1)
  assert.equal(result.items[0].stage,'unclear')
  assert.equal(result.items[0].draft,'')
  assert.equal(result.items[0].name,'Verified name')
  assert.throws(()=>parseResult('not JSON',[], 'draft'))
})

async function fixture(t,{plan='business',claimError=null,providerFails=false, conversations=null, resultItems=null}={}) {
  const reads=[],writes=[],prompts=[];let calls=0
  const db={from(table){
    const filters=[];let update=null, maximum=100, after=null
    const q={select(){return q},eq(column,value){filters.push([column,value]);return q},neq(){return q},order(){return q},limit(value){maximum=value;return q},gt(column,value){filters.push([column,value]);after=value;return q},is(){return q},single(){return q},update(value){update=value;return q},then(resolve){
      reads.push({table,filters})
      if(update){writes.push({table,update});return Promise.resolve({data:null,error:null}).then(resolve)}
      const data=table==='customers'?{subscription_plan:plan,subscription_status:'active'}:table==='conversations'?(conversations||[{id,contacts:{name:'Client'}}]).filter(c=>!after||c.id>after).slice(0,maximum):table==='messages'?[{id:'m1',conversation_id:conversations?.[0]?.id||id,direction:'inbound',message_body:'Can I get a quote?',created_at:'2026-10-15'}]:[]
      return Promise.resolve({data,error:null}).then(resolve)
    }};return q
  },async rpc(){return {data:{remaining:99},error:claimError}}}
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.workspace={customerId:'workspace-from-auth',userId:'user-from-auth'};next()})
  app.use('/inbox-copilot',createCopilotRouter({db,complete:async(system,payload)=>{calls++;prompts.push({system,payload:JSON.parse(payload)});if(providerFails)throw new Error('secret provider error');return {text:JSON.stringify({items:resultItems||[{conversation_id:id,summary:'Quote requested'}]}),inputTokens:10,outputTokens:20}}}))
  const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server))})
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}))
  return {reads,writes,prompts,calls:()=>calls,post:async(body)=>fetch(`http://127.0.0.1:${server.address().port}/inbox-copilot`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}
}
test('Starter denial happens before any conversation read or AI request',async t=>{
  const f=await fixture(t,{plan:'starter'});const res=await f.post({mode:'summary'})
  assert.equal(res.status,403);assert.equal(f.calls(),0);assert.deepEqual(f.reads.map(r=>r.table),['customers'])
})
test('workspace from auth scopes all reads and writes; only suggestions are returned',async t=>{
  const f=await fixture(t);const res=await f.post({mode:'summary',customer_id:'attacker-workspace'});const data=await res.json()
  assert.equal(res.status,200);assert.equal(data.reviewed,1);assert.equal(data.usage.remaining,99)
  for(const read of f.reads)assert.ok(read.filters.some(([key,value])=>['id','customer_id'].includes(key)&&value==='workspace-from-auth'))
  assert.ok(f.writes.every(write=>write.table==='inbox_copilot_requests'))
})
test('quota rejection never calls provider',async t=>{
  const f=await fixture(t,{claimError:{code:'P0001'}});const res=await f.post({mode:'summary'})
  assert.equal(res.status,429);assert.equal(f.calls(),0)
})
test('provider failure returns a safe error and records failed usage',async t=>{
  const f=await fixture(t,{providerFails:true});const res=await f.post({mode:'summary'})
  assert.equal(res.status,503);assert.ok(!(await res.text()).includes('secret'))
  assert.equal(f.writes.at(-1).update.state,'failed')
})


test('typed questions validate input before reading data', async t=>{
  const f=await fixture(t)
  for(const question of ['', ' '.repeat(5), 'x'.repeat(1001), {text:'bad'}]) {
    const res=await f.post({mode:'ask',question});assert.equal(res.status,400)
  }
  assert.equal(f.reads.length,0);assert.equal(f.calls(),0)
})
test('ask scans beyond the latest twenty in cursor batches and grounds evidence to each chat', async t=>{
  const rows=Array.from({length:25},(_,i)=>({id:`11111111-1111-4111-8111-${String(i).padStart(12,'0')}`,contacts:{name:`Client ${i}`}}))
  const f=await fixture(t,{conversations:rows,resultItems:[{conversation_id:rows[0].id,summary:'Interested',evidence_message_ids:['m1','forged']},{conversation_id:'foreign',summary:'leak'}]})
  let cursor=null, reviewed=0, pages=0
  do {
    const res=await f.post({mode:'ask',question:'Warm leads needing qualification',cursor});assert.equal(res.status,200)
    const data=await res.json();reviewed+=data.reviewed;pages++;cursor=data.next_cursor
    if(pages===1) {assert.equal(data.items.length,1);assert.ok(data.items[0].evidence.length>0)}
    assert.ok(data.items.every(item=>item.conversation_id!=='foreign'))
    assert.ok(data.items.every(item=>item.evidence.every(message=>message.id==='m1')))
  } while(cursor)
  assert.equal(reviewed,25);assert.equal(pages,3);assert.equal(f.calls(),3)
  assert.equal(f.prompts[0].payload.staff_question,'Warm leads needing qualification')
  assert.ok(f.prompts[0].payload.conversations.length<=10)
  for(const read of f.reads)assert.ok(read.filters.some(([key,value])=>['id','customer_id'].includes(key)&&value==='workspace-from-auth'))
})
test('no matching leads is a successful empty answer, not an AI failure', async t=>{
  const f=await fixture(t,{resultItems:[]});const res=await f.post({mode:'ask',question:'Who needs a quote?'})
  assert.equal(res.status,200);assert.deepEqual((await res.json()).items,[])
})
