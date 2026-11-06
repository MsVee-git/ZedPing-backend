const test=require('node:test')
const assert=require('node:assert/strict')
const {scheduledTime,runScheduledCampaigns,saveScheduledCampaign}=require('../lib/campaignScheduler')
const NOW='2026-11-06T10:00:00.000Z'
function memoryDb(rows){
 return {rows,from(table){let conditions=[],change=null,insert=null,single=false,limit=Infinity;
 const query={select(){return query},eq(k,v){conditions.push(row=>row[k]===v);return query},lte(k,v){conditions.push(row=>row[k]<=v);return query},in(k,v){conditions.push(row=>v.includes(row[k]));return query},order(){return query},limit(v){limit=v;return query},maybeSingle(){single=true;return query},update(v){change=v;return query},insert(v){insert=v;return query},then(resolve,reject){
 try{const set=rows[table]||[];if(insert){if(set.some(r=>r.id===insert.id))return Promise.resolve({error:{code:'23505'}}).then(resolve,reject);set.push({...insert});rows[table]=set;return Promise.resolve({error:null}).then(resolve,reject)}
 const matches=set.filter(row=>conditions.every(fn=>fn(row))).slice(0,limit);if(change)for(const row of matches)Object.assign(row,change);
 return Promise.resolve({data:single?(matches[0]?{...matches[0]}:null):matches.map(r=>({...r})),error:null}).then(resolve,reject)}catch(e){return Promise.reject(e).then(resolve,reject)}}};return query}
 }
}
function fixture({future=false,cancelled=false}={}){
 return memoryDb({campaign_schedule_jobs:[{id:'job',customer_id:'tenant-a',state:cancelled?'cancelled':'queued',scheduled_at:future?'2026-11-07T10:00:00.000Z':NOW,spec:{template_id:'template'},recipients:[{id:'a'},{id:'removed'},{id:'foreign'}]}],scheduled_broadcasts:[{id:'job',customer_id:'tenant-a',status:'pending'}],contacts:[{id:'a',customer_id:'tenant-a',phone_number:'260970000001',marketing_opted_out:true},{id:'foreign',customer_id:'tenant-b',phone_number:'260970000002'}]})
}
test('CAT schedule is stored as UTC; ambiguous, past and too-distant dates rejected',()=>{
 const now=Date.parse(NOW)
 assert.equal(scheduledTime('2026-11-06T14:00:00+02:00',now),'2026-11-06T12:00:00.000Z')
 for(const date of ['2026-11-06T14:00','bad','2026-11-06T09:00:00Z','2027-12-01T00:00:00Z'])assert.throws(()=>scheduledTime(date,now))
})
test('future and cancelled jobs never execute',async()=>{
 let calls=0
 for(const options of [{future:true},{cancelled:true}])await runScheduledCampaigns({db:fixture(options),now:()=>new Date(NOW),execute:async()=>{calls++}})
 assert.equal(calls,0)
})
test('concurrent workers claim once, refresh recipients only within workspace, retain opt-out for send revalidation',async()=>{
 const db=fixture();let calls=0
 const execute=async(req,res)=>{calls++;assert.equal(req.scheduledActivity.id,'job');assert.equal(req.scheduledRecipients.length,1);assert.equal(req.scheduledRecipients[0].id,'a');assert.equal(req.scheduledRecipients[0].marketing_opted_out,true);res.json({success:true})}
 await Promise.all([runScheduledCampaigns({db,execute,now:()=>new Date(NOW)}),runScheduledCampaigns({db,execute,now:()=>new Date(NOW)})])
 assert.equal(calls,1);assert.equal(db.rows.campaign_schedule_jobs[0].state,'done')
 await runScheduledCampaigns({db,execute,now:()=>new Date(NOW)});assert.equal(calls,1)
})
test('send-time validation failure and uncertain exceptions fail closed without automatic resends',async()=>{
 for(const throws of [false,true]){
 const db=fixture();let calls=0
 const execute=async(req,res)=>{calls++;if(throws)throw Error('uncertain');res.status(409).json({error:'Template no longer approved.'})}
 await runScheduledCampaigns({db,execute,now:()=>new Date(NOW)})
 assert.equal(db.rows.campaign_schedule_jobs[0].state,'failed');assert.equal(db.rows.scheduled_broadcasts[0].status,'failed')
 await runScheduledCampaigns({db,execute,now:()=>new Date(NOW)});assert.equal(calls,1)
 }
})
test('saving a schedule persists it before acknowledgement and retry returns the same job',async()=>{
 const db=memoryDb({campaign_schedule_jobs:[],scheduled_broadcasts:[]})
 const req={workspace:{customerId:'tenant-a'},body:{scheduled_at:new Date(Date.now()+3600000).toISOString(),schedule_request_id:'11111111-1111-4111-8111-111111111111',template_id:'template'}}
 const review={number:{id:'number',phone_number_id:'meta'},template:{name:'promo',language:'en'},recipients:[{id:'a',phone_number:'260970000001'}]}
 const res={status(code){this.code=code;return this},json(body){assert.equal(db.rows.campaign_schedule_jobs.length,1);this.body=body;return this}}
 await saveScheduledCampaign({db,req,res,review});assert.equal(res.code,202);assert.equal(res.body.status,'scheduled')
 await saveScheduledCampaign({db,req,res,review});assert.equal(db.rows.campaign_schedule_jobs.length,1);assert.equal(db.rows.scheduled_broadcasts.length,1)
})

test('interrupted claims become visible failures without resending',async()=>{
 const db=fixture();Object.assign(db.rows.campaign_schedule_jobs[0],{state:'running',heartbeat_at:'2026-11-06T08:00:00.000Z'});db.rows.scheduled_broadcasts[0].status='sending';
 let calls=0;await runScheduledCampaigns({db,now:()=>new Date(NOW),execute:async()=>{calls++}});
 assert.equal(calls,0);assert.equal(db.rows.campaign_schedule_jobs[0].state,'failed');assert.equal(db.rows.scheduled_broadcasts[0].status,'failed');
});
