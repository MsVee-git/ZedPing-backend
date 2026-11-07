const test=require('node:test')
const assert=require('node:assert/strict')
const {plannedJobs,followupEligible,eligibleTemplate}=require('../lib/leadFollowupPolicy')
const {processFollowup,runLeadFollowups,scheduleFollowups}=require('../lib/leadFollowups')
const anchor='2026-11-01T10:00:00.000Z'
const config={enabled:true,template_24h_id:'t24',template_72h_id:'t72'}
const agent={id:'agent',customer_id:'c',whatsapp_number_id:'n',lifecycle_status:'active',is_active:true,deployment_mode:'live'}
const conversation={id:'conv',customer_id:'c',contact_id:'person',whatsapp_number_id:'n',last_inbound_at:anchor,status:'open',control_mode:'automation',assigned_user_id:null}
const contact={id:'person',customer_id:'c',phone_number:'260970000000',marketing_opted_out:false}
const version={customer_id:'c',agent_id:'agent',activated_at:anchor,version:1,configuration:{name:'Sales',configuration:{followups:config,handoff:{unknown:true}}},knowledge_snapshot:[{id:'facts',name:'Covers',text_content:'Covers cost K3500.'}]}
const session={id:'session',customer_id:'c',conversation_id:'conv',agent_version:1,status:'active',updated_at:anchor,messages:[{role:'user',content:'Do you sell covers?'},{role:'assistant',content:'Yes, covers cost K3500.'}]}
const plan=()=>plannedJobs({customerId:'c',agent,conversation,session,config})
function database(initial) {
 const tables=structuredClone(initial)
 function from(name){
  tables[name] ||= []
  let predicates=[],kind='read',patch,lim=Infinity,single=false,sort
  const q={
   select(){return q},eq(key,value){predicates.push(row=>row[key]===value);return q},is(key,value){return q.eq(key,value)},
   lt(key,value){predicates.push(row=>row[key]<value);return q},lte(key,value){predicates.push(row=>row[key]<=value);return q},
   not(key,op,value){predicates.push(row=>row[key]!==value);return q},order(key){sort=key;return q},limit(value){lim=value;return q},
   update(value){kind='update';patch=value;return q},insert(value){kind='insert';patch=value;return q},
   upsert(value){kind='upsert';patch=value;return q},maybeSingle(){single=true;return q},
   then(resolve,reject){return Promise.resolve().then(()=>{
    let rows=tables[name].filter(row=>predicates.every(p=>p(row)))
    if(sort)rows.sort((a,b)=>String(a[sort]).localeCompare(String(b[sort])))
    rows=rows.slice(0,lim)
    if(kind==='update')rows.forEach(row=>Object.assign(row,patch))
    if(kind==='insert'||kind==='upsert'){
     rows=[]
     for(const value of Array.isArray(patch)?patch:[patch]){
      const existing=kind==='upsert' && tables[name].find(row=>row.conversation_id===value.conversation_id && row.anchor_at===value.anchor_at && row.step===value.step)
      if(existing)continue
      const row={id:'row'+tables[name].length,...value};tables[name].push(row);rows.push(row)
     }
    }
    return {data:structuredClone(single?rows[0]||null:rows),error:null}
   }).then(resolve,reject)}
  };return q
 }
 return {from,tables}
}
function fixture(step=1){
 const job={id:'job',...plan().find(row=>row.step===step)}
 const db=database({conversations:[conversation],contacts:[contact],ai_agents:[agent],ai_agent_configuration_versions:[version],ai_agent_sessions:[session],whatsapp_numbers:[{id:'n',customer_id:'c',status:'connected'}],ai_lead_followup_jobs:[job]})
 const sent=[]
 const deps={db,now:()=>new Date(Date.parse(anchor)+step*3600000),complete:async()=>({text:'Would you like help choosing a cover?',precisionCheck:'supported',model:'gpt-4o-mini'}),sendText:async args=>{sent.push(['text',args]);return {messages:[{id:'sent'}]}},sendTemplate:async args=>{sent.push(['template',args]);return {messages:[{id:'sent'}]}},listTemplates:async()=>[{id:'t'+step,name:'lead_followup',language:'en',status:'APPROVED',category:'MARKETING',components:[{type:'BODY',text:'Do you still need help with your enquiry?'}]}]}
 return {job,db,sent,deps}
}

test('sequence uses absolute 1/24/72/96-hour offsets and stable anchor',()=>{
 const jobs=plan();assert.deepEqual(jobs.map(job=>job.step),[1,24,72,96]);assert.equal(jobs[2].due_at,'2026-11-04T10:00:00.000Z');assert.equal(jobs[3].due_at,'2026-11-05T10:00:00.000Z')
 assert.equal(jobs[1].template_id,'t24');assert.equal(jobs[2].template_id,'t72')
})
test('live agents schedule automatically; test mode and declined conversations do not enroll',()=>{
 const jobs=plannedJobs({customerId:'c',agent,conversation,session});
 assert.deepEqual(jobs.map(job=>job.template_id),[null,'auto:24','auto:72',null])
 assert.equal(followupEligible(jobs[0],{conversation,contact,agent,version:{...version,configuration:{}},session},Date.parse(anchor)+3600000),true)
 assert.equal(plannedJobs({customerId:'c',agent:{...agent,deployment_mode:'test'},conversation,session,config}).length,0)
 assert.equal(plannedJobs({customerId:'c',agent,conversation,session,config,latestMessage:'No thanks, not interested'}).length,0)
})
test('reply, opt-out, takeover, pause, changed version and resolved status cancel',()=>{
 const state={conversation,contact,agent,version,session},job=plan()[0],now=Date.parse(anchor)+3600000
 assert.equal(followupEligible(job,state,now),true)
 for(const overrides of [
 {conversation:{...conversation,last_inbound_at:'2026-11-01T10:30:00Z'}},{contact:{...contact,marketing_opted_out:true}},
 {conversation:{...conversation,control_mode:'human'}},{conversation:{...conversation,status:'resolved'}},
 {agent:{...agent,lifecycle_status:'paused'}},{version:{...version,version:2}},
 {contact:{...contact,customer_id:'other'}},{session:{...session,status:'cancelled'}}])assert.equal(followupEligible(job,{...state,...overrides},now),false)
})
test('only approved static marketing templates are eligible',()=>{
 const template={id:'t',name:'follow',language:'en',status:'APPROVED',category:'MARKETING',components:[{type:'BODY',text:'Still interested?'}]}
 assert.equal(eligibleTemplate(template),true)
 for(const override of [{status:'PENDING'},{category:'UTILITY'},{components:[{type:'BODY',text:'Hi {{1}}'}]},{components:[{type:'HEADER',format:'IMAGE'},{type:'BODY',text:'Hi'}]}])assert.equal(eligibleTemplate({...template,...override}),false)
})
test('one-hour AI message is recorded and does not move last inbound time',async()=>{
 const {job,db,sent,deps}=fixture();assert.equal((await processFollowup({...deps,job})).state,'done');assert.equal(sent[0][0],'text');assert.equal(db.tables.messages.length,1);assert.equal(db.tables.conversations[0].last_inbound_at,anchor);assert.equal(db.tables.ai_agent_sessions[0].messages.at(-1).content,sent[0][1].body)
})
test('24-hour and 72-hour messages use templates, never generated free text',async()=>{
 for(const step of [24,72]){const {job,sent,deps}=fixture(step);deps.complete=()=>{throw Error('Must not generate')};assert.equal((await processFollowup({...deps,job})).state,'done');assert.equal(sent[0][0],'template')}
})
test('automatic follow-ups select only the dedicated approved template',async()=>{
 const {job,sent,deps}=fixture(24)
 job.template_id='auto:24'
 const [approved]=await deps.listTemplates()
 deps.listTemplates=async()=>[approved,{...approved,id:'pending',name:'zedping_ai_followup_24h',status:'PENDING'}]
 assert.equal((await processFollowup({...deps,job})).state,'blocked')
 assert.equal(sent.length,0)
 deps.listTemplates=async()=>[approved,{...approved,id:'default',name:'zedping_ai_followup_24h'}]
 assert.equal((await processFollowup({...deps,job})).state,'done')
 assert.equal(sent[0][1].template.name,'zedping_ai_followup_24h')
})
test('late worker skips earlier stages instead of sending a burst',async()=>{
 const {job,sent,deps}=fixture(1);deps.now=()=>new Date(Date.parse(anchor)+25*3600000);assert.equal((await processFollowup({...deps,job})).state,'blocked');assert.equal(sent.length,0)
})
test('late skipped stages do not cancel the future 72h step',async()=>{
 const {db,deps}=fixture(1);db.tables.ai_lead_followup_jobs=plan().map((job,i)=>({id:'job'+i,...job}));deps.now=()=>new Date(Date.parse(anchor)+25*3600000)
 await runLeadFollowups(deps)
 assert.equal(db.tables.ai_lead_followup_jobs.find(job=>job.step===72).state,'queued')
})
test('reply during generation cancels without sending',async()=>{
 const {job,db,sent,deps}=fixture();deps.complete=async()=>{db.tables.conversations[0].last_inbound_at='2026-11-01T11:00:01Z';return {text:'Still interested?',precisionCheck:'supported'}}
 assert.equal((await processFollowup({...deps,job})).state,'cancelled');assert.equal(sent.length,0)
})
test('no approved template or failed factual review never sends',async()=>{
 const late=fixture(24);late.deps.listTemplates=async()=>[];assert.equal((await processFollowup({...late.deps,job:late.job})).state,'blocked');assert.equal(late.sent.length,0)
 const early=fixture();early.deps.complete=async()=>({text:'K999',precisionCheck:'rejected'});assert.equal((await processFollowup({...early.deps,job:early.job})).state,'blocked');assert.equal(early.sent.length,0)
})
test('no response at 96h closes conversation and ends session without sending',async()=>{
 const {job,db,sent,deps}=fixture(96);assert.equal((await processFollowup({...deps,job})).reason,'closed_no_response');assert.equal(db.tables.conversations[0].status,'resolved');assert.equal(db.tables.ai_agent_sessions[0].status,'ended');assert.equal(sent.length,0)
})
test('repeated scheduling and concurrent workers do not duplicate follow-ups',async()=>{
 const {db,sent,deps}=fixture();db.tables.ai_lead_followup_jobs=[]
 const args={customerId:'c',agent,conversation,session,config};await scheduleFollowups(db,args);await scheduleFollowups(db,args);assert.equal(db.tables.ai_lead_followup_jobs.length,4)
 await Promise.all([runLeadFollowups(deps),runLeadFollowups(deps)]);assert.equal(sent.length,1)
})
test('uncertain send is failed and never automatically replayed',async()=>{
 const {db,sent,deps}=fixture();deps.sendText=async()=>{sent.push('attempt');throw Error('timeout')}
 await runLeadFollowups(deps);await runLeadFollowups(deps);assert.equal(sent.length,1);assert.equal(db.tables.ai_lead_followup_jobs[0].state,'failed')
})
