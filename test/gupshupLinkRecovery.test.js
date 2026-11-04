const test=require('node:test'),assert=require('node:assert/strict');
const {createGupshupPartnerClient}=require('../lib/gupshupPartner');
const {reconcileWhatsAppConnection:reconcile}=require('../lib/whatsappConnectionReconciliation');
const input={name:'ZedPingExample123456',phone:'260977123456',wabaId:'123456789'};
const ok=data=>({ok:true,status:200,json:async()=>({status:'success',...data})});
function provider(overrides={}) {
 const calls=[];
 const client=createGupshupPartnerClient({universalToken:'private',diagnostic(){},fetchImpl:async(url,options)=>{
  calls.push({url,options});
  if(url.includes('/partnerApps?'))return ok({partnerAppsList:[{id:'app-1',name:input.name}],...overrides.list});
  if(url.endsWith('/details'))return ok({data:{id:'app-1',name:input.name,phone:input.phone,...overrides.details}});
  if(url.endsWith('/waba/info'))return ok({wabaInfo:{wabaId:input.wabaId,phone:input.phone,...overrides.waba}});
  assert.fail('Unexpected endpoint');
 }});
 return{client,calls};
}
test('lost app-link response recovers by exact saved app name, phone and WABA with GETs only',async()=>{
 const {client,calls}=provider();assert.deepEqual(await client.findLinkedApp(input),{appId:'app-1'});
 assert.ok(calls.every(call=>call.options.method==='GET'));
 assert.match(calls[0].url,/page=0&size=100&searchTerm=ZedPingExample123456/);
 assert.ok(!JSON.stringify(await client.findLinkedApp(input)).includes('private'));
});
test('recovery rejects wrong workspace assets, duplicate names, truncated lookup and unsafe identifiers',async()=>{
 for(const overrides of [{details:{phone:'260977999999'}},{details:{name:'Other'}},{details:{id:'different'}},{waba:{wabaId:'999999999'}},{waba:{phone:'260977999999'}},{list:{totalPages:2}},{list:{partnerAppsList:[{id:'a',name:input.name},{id:'b',name:input.name}]}},{list:{partnerAppsList:[{id:'../other',name:input.name}]}}])await assert.rejects(provider(overrides).client.findLinkedApp(input),/recovery_identity|app_lookup/);
 const p=provider();await assert.rejects(p.client.findLinkedApp({...input,name:'../other'}),/validation/);assert.equal(p.calls.length,0);
 assert.equal(await provider({list:{partnerAppsList:[]}}).client.findLinkedApp(input),null);
});
function fixture(){
 const number={id:'number',customer_id:'client',phone_number:'+260 977123456',phone_number_id:'555555',whatsapp_business_account_id:input.wabaId,status:'provisioning'};
 const mapping={id:'mapping',customer_id:'client',whatsapp_number_id:'number',app_id:null,app_name:input.name,link_state:'confirmation_required'};
 const writes=[];
 const db={from(table){let patch,filters=[];const row=()=>table==='gupshup_connection_mappings'?mapping:table==='whatsapp_numbers'?number:{};
  const matches=()=>filters.every(([k,v,op])=>op==='in'?v.includes(row()[k]):row()[k]===v);
  const result=()=>{const applies=table==='gupshup_connection_mappings'?matches():true;if(patch&&applies){Object.assign(row(),patch);writes.push({table,patch,filters})}return{data:applies?{...row()}:null,error:null}};
  const q={select(){return q},update(value){patch=value;return q},eq(k,v){filters.push([k,v]);return q},is(k,v){filters.push([k,v]);return q},in(k,v){filters.push([k,v,'in']);return q},single:async()=>result(),maybeSingle:async()=>result(),then:resolve=>Promise.resolve(result()).then(resolve)};return q;
 }};return{db,number,mapping,writes};
}
test('confirmation-required mappings finalize the verified existing app, webhook and connection without another link/register',async()=>{
 const f=fixture();let subscriptions=0,lookups=0;
 const partner={findLinkedApp:async args=>{lookups++;assert.deepEqual(args,input);return{appId:'app-1'}},getAppStatus:async id=>{assert.equal(id,'app-1');return{provisioned:true}},ensureSubscription:async()=>subscriptions++,linkApp:()=>assert.fail('duplicate create')};
 const args={db:f.db,customerId:'client',connection:f.number,mapping:f.mapping,partner,meta:{registerPhone:()=>assert.fail('duplicate register')}};
 assert.equal((await reconcile(args)).phase,'complete');assert.equal(f.mapping.app_id,'app-1');assert.equal(f.mapping.link_state,'linked');assert.equal(f.number.status,'connected');assert.equal(subscriptions,1);
 assert.equal((await reconcile(args)).phase,'complete');assert.equal(lookups,1);assert.equal(subscriptions,1);
 const write=f.writes.find(w=>w.table==='gupshup_connection_mappings');assert.ok(write.filters.some(([k,v])=>k==='customer_id'&&v==='client'));assert.ok(write.filters.some(([k,v])=>k==='app_id'&&v===null));
});
test('eventually visible app is left recoverable; subscription failure never marks connected',async()=>{
 let f=fixture();const args={customerId:'client',partner:{findLinkedApp:async()=>null}};
 assert.equal((await reconcile({...args,db:f.db,connection:f.number,mapping:f.mapping})).phase,'confirmation_required');assert.equal(f.writes.length,0);
 f=fixture();await assert.rejects(reconcile({...args,db:f.db,connection:f.number,mapping:f.mapping,partner:{findLinkedApp:async()=>({appId:'app-1'}),getAppStatus:async()=>({provisioned:true}),ensureSubscription:async()=>{throw Error('Not subscribed')}}}),/Not subscribed/);
 assert.equal(f.number.status,'provisioning');assert.equal(f.mapping.link_state,'linked');
});
