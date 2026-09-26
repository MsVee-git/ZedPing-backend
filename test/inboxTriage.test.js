const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const triage=require('../lib/inboxTriage');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const version='2026-09-25T10:00:00.000Z';
const person=id(1000),other=id(1001);
function fixture(extra=[]) {
 const rows=[
  {id:id(1),customer_id:'a',status:'needs_attention',control_mode:'needs_attention',assigned_user_id:null,unread_count:2},
  {id:id(2),customer_id:'a',status:'open',control_mode:'automation',assigned_user_id:null,unread_count:1},
  {id:id(3),customer_id:'a',status:'open',control_mode:'human',assigned_user_id:person,unread_count:0},
  {id:id(4),customer_id:'a',status:'needs_attention',control_mode:'needs_attention',assigned_user_id:person,unread_count:1},
  {id:id(5),customer_id:'a',status:'resolved',control_mode:'human',assigned_user_id:other,unread_count:0},
  {id:id(6),customer_id:'b',status:'needs_attention',control_mode:'needs_attention',assigned_user_id:null,unread_count:1},
  ...extra
 ].map(row=>({updated_at:version,contacts:{name:'Synthetic'},...row}));
 const queries=[],events=[],cleanups=[];let race=false;
 const db={from(table){
  const filters=[];let patch=null,single=false,head=false,start=0,end=Infinity,limit=Infinity;
  const log={table,filters};queries.push(log);
  const q={
   select(fields,opts){log.fields=fields;if(opts?.head)head=true;return q;},
   eq(k,v){filters.push([k,'eq',v]);return q;},neq(k,v){filters.push([k,'neq',v]);return q;},gt(k,v){filters.push([k,'gt',v]);return q;},
   is(k,v){filters.push([k,'eq',v]);return q;},in(k,v){filters.push([k,'in',v]);return q;},
   or(value){log.or=value;return q;},order(k,opts){(log.orders||=[]).push([k,opts]);return q;},
   limit(n,opts){if(opts?.referencedTable)log.embeddedLimit=n;else limit=n;return q;},range(a,b){start=a;end=b;return q;},
   update(value){patch=value;log.patch=value;return q;},maybeSingle(){single=true;return q;},single(){single=true;return q;},
   then(resolve,reject){
    if(race&&patch){const row=rows.find(r=>r.id===filters.find(f=>f[0]==='id')?.[2]);if(row)row.updated_at='2026-09-26T00:00:00.000Z';race=false;}
    let data=table==='conversations'?rows.filter(r=>filters.every(([k,op,v])=>k.startsWith('messages.') || (op==='eq'?r[k]===v:op==='neq'?r[k]!==v:op==='gt'?r[k]>v:v.includes(r[k])))):[];
    if(log.or)data=data.filter(r=>r.assigned_user_id===null || r.assigned_user_id===person);
    const count=data.length;data=data.slice(start,Math.min(end+1,start+limit));
    if(patch)data.forEach(row=>Object.assign(row,patch));
    return Promise.resolve({data:head?null:single?structuredClone(data[0]||null):structuredClone(data),error:null,count}).then(resolve,reject);
   }
  };return q;
 }};
 const routes=new Map(),router={get(p,...h){routes.set('GET '+p,h)},post(p,...h){routes.set('POST '+p,h)},patch(p,...h){routes.set('PATCH '+p,h)}};
 const context={module:{exports:{}},require(name){
  if(name==='express')return {Router:()=>router};if(name==='../lib/supabase')return db;if(name==='../lib/inboxTriage')return triage;
  if(name==='../lib/conversationState')return require('../lib/conversationState');
  if(name==='../lib/conversationEvents')return {recordConversationEvent:async event=>events.push(event)};
  if(name==='../lib/chatbotExecution')return {handoffActiveFlowForConversation:async event=>cleanups.push(event)};
  if(name==='../lib/aiAgentSessions')return {closeActiveAiSessionsForConversation:async event=>cleanups.push(event)};
  if(name==='../middleware/auth')return {requireAdmin:(req,res,next)=>['owner','admin'].includes(req.workspace.role)?next():res.status(403).json({error:'Forbidden'})};
  return {};
 }};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../routes/conversations.js'),'utf8'),context);
 const workspace={customerId:'a',role:'admin',userId:person};
 return {rows,queries,events,cleanups,workspace,race:()=>{race=true},async call(method,url,{body={},query={},role='admin',params={}}={}){
  const result={status:200},res={status(code){result.status=code;return res},json(data){result.body=JSON.parse(JSON.stringify(data));return res}};
  const req={workspace:{...workspace,role},body,query,params};const handlers=routes.get(method+' '+url);let i=0;const next=()=>handlers[i++]?.(req,res,next);await next();return result;
 },bulk(body,role='admin'){return triage.runBulk({db,fields:'*',workspace:{...workspace,role},body,assertMember:async(w,u)=>{assert.equal(w,'a');if(![person,other].includes(u))throw Error('Foreign member')},recordEvent:async e=>events.push(e)})}};
}
const body=(action,ids,extra={})=>({action,items:ids.map(n=>({id:id(n),updated_at:version})),...extra});
test('canonical counts overlap unread/state and exclude other workspaces',async()=>{
 const f=fixture(),r=await f.call('GET','/counts');assert.equal(r.status,200);
 assert.deepEqual(r.body,{needs_attention:2,zoe:1,assigned_to_me:2,unassigned_human:1,unread:3,resolved:1,all:5});
 assert.equal(f.queries.length,7);assert.ok(f.queries.every(q=>q.filters.some(([k,op,v])=>k==='customer_id'&&v==='a')));
});
for(const [view,expected] of [['needs_attention',[1,4]],['zoe',[2]],['assigned_to_me',[3,4]],['unassigned_human',[1]],['unread',[1,2,4]],['resolved',[5]],['all',[1,2,3,4,5]]])test('server triage view '+view,async()=>{
 const f=fixture(),r=await f.call('GET','/',{query:{view,offset:'0',user_id:other}});assert.equal(r.status,200);assert.deepEqual(r.body.conversations.map(r=>r.id),expected.map(id));
 assert.equal(f.queries.length,1);assert.equal(f.queries[0].embeddedLimit,1);assert.ok(f.queries[0].filters.some(([k])=>k==='messages.customer_id'));
});
test('list pages make conversations beyond 100 reachable',async()=>{
 const extra=Array.from({length:160},(_,i)=>({id:id(10+i),customer_id:'a',status:'open',control_mode:'automation',assigned_user_id:null,unread_count:0}));const f=fixture(extra);
 const first=await f.call('GET','/',{query:{offset:'0'}}),third=await f.call('GET','/',{query:{offset:'100'}});
 assert.equal(first.body.conversations.length,50);assert.equal(first.body.next_offset,50);assert.equal(third.body.conversations.length,50);assert.equal(third.body.next_offset,150);
 assert.equal((await f.call('GET','/',{query:{offset:'-1'}})).status,400);
});
test('assignment is admin-only, validates target workspace, preserves needs-attention and Zoe',async()=>{
 const f=fixture();assert.equal((await f.bulk(body('assign',[1],{assigned_user_id:other}),'member')).status,403);
 await assert.rejects(f.bulk(body('assign',[1],{assigned_user_id:id(9999)})));
 const r=await f.bulk(body('assign',[1,2,6],{assigned_user_id:other}));assert.deepEqual(r.results.map(r=>r.outcome),['applied','skipped','skipped']);
 assert.equal(f.rows[0].assigned_user_id,other);assert.equal(f.rows[0].control_mode,'needs_attention');assert.equal(f.rows[1].control_mode,'automation');
});
test('assign-to-me cannot steal another member or take over Zoe',async()=>{
 const f=fixture();f.rows[3].assigned_user_id=other;
 const r=await f.bulk(body('assign_me',[1,2,4]),'member');assert.deepEqual(r.results.map(r=>r.outcome),['applied','skipped','skipped']);assert.equal(f.rows[0].assigned_user_id,person);assert.equal(f.rows[0].status,'needs_attention');
});
test('bulk Resolve handles mixed states safely and next inbound uses existing routing',async()=>{
 const f=fixture(),r=await f.bulk(body('resolve',[1,2,3,5,6]));assert.deepEqual(r.results.map(r=>r.outcome),['applied','skipped','applied','skipped','skipped']);
 const state=require('../lib/conversationState');assert.equal(state.stateForInbound(f.rows[0]).control_mode,'automation');assert.equal(f.rows[1].control_mode,'automation');
});
test('member Resolve only permits their assignments',async()=>{
 const f=fixture(),r=await f.bulk(body('resolve',[1,3,4]),'member');assert.deepEqual(r.results.map(r=>r.outcome),['skipped','applied','applied']);
});
test('Reopen only affects resolved rows and keeps human suppression',async()=>{
 const f=fixture(),r=await f.bulk(body('reopen',[1,5]),'member');assert.deepEqual(r.results.map(r=>r.outcome),['skipped','applied']);assert.equal(f.rows[4].assigned_user_id,person);assert.equal(require('../lib/conversationState').shouldSuppressAutomation(f.rows[4]),true);
});
test('stale, concurrent and duplicate requests cannot repeat transitions',async()=>{
 const f=fixture();const request=body('resolve',[3]);f.race();assert.equal((await f.bulk(request)).results[0].outcome,'skipped');assert.equal(f.rows[2].status,'open');
 const g=fixture();assert.equal((await g.bulk(request)).results[0].outcome,'applied');assert.equal((await g.bulk(request)).results[0].outcome,'skipped');assert.equal(g.events.length,1);
 await assert.rejects(g.bulk(body('resolve',[3,3])));await assert.rejects(g.bulk({action:'resolve',items:[]}));await assert.rejects(g.bulk(body('take',[2])));
});
test('single explicit Zoe takeover uses existing cleanup and rejects stale state',async()=>{
 const f=fixture();let r=await f.call('POST','/:id/take',{params:{id:id(2)}});assert.equal(r.status,409);
 r=await f.call('POST','/:id/take',{params:{id:id(2)},body:{from_automation:true}});assert.equal(r.status,200);assert.equal(r.body.conversation.control_mode,'human');assert.equal(f.cleanups.length,2);
 r=await f.call('POST','/:id/take',{params:{id:id(2)},body:{from_automation:true}});assert.equal(r.status,409);assert.equal(f.cleanups.length,2);
});
test('bulk payload is bounded to 200 unique versioned selections',()=>{
 assert.doesNotThrow(()=>triage.validateBulk(body('resolve',Array.from({length:200},(_,i)=>i+1))));
 assert.throws(()=>triage.validateBulk(body('resolve',Array.from({length:201},(_,i)=>i+1))));
 assert.throws(()=>triage.validateBulk({action:'resolve',items:[{id:id(1)}]}));
});
