const test=require('node:test'),assert=require('node:assert/strict');
const {recoverSignupManagementCredential:recover,repairConnectedTemplateCredentials:repair}=require('../lib/signupManagementCredential');
const number={id:'number',customer_id:'client',phone_number_id:'123456',whatsapp_business_account_id:'987654'};
function database({mapping={app_id:'app',link_state:'linked'},session={id:'session'}}={}){
 const filters=[];return {filters,from(table){const q={select:()=>q,eq:(k,v)=>{filters.push([table,k,v]);return q},not:()=>q,order:()=>q,limit:async()=>({data:session?[session]:[]}),maybeSingle:async()=>({data:mapping})};return q}}
}
test('completed signup recovery revalidates assets and saves only a phone-scoped encrypted credential',async()=>{
 const db=database(),writes=[];const result=await recover(number,{db,vault:{get:async()=> 'private-test',put:async x=>writes.push(x)},meta:{validatePhoneOwnership:async input=>{assert.equal(input.finishWabaId,'987654');return {phoneNumberId:'123456',wabaId:'987654'}}}});
 assert.equal(result,'private-test');assert.equal(writes[0].credentialKey,'phone_123456');assert.equal(writes[0].customerId,'client');
 assert.ok(db.filters.some(([t,k,v])=>t==='whatsapp_connection_sessions'&&k==='customer_id'&&v==='client'));
 assert.ok(db.filters.some(([t,k,v])=>t==='whatsapp_connection_sessions'&&k==='signup_waba_id'&&v==='987654'));
});
test('missing or conflicting provider/session/ownership never promotes a credential',async()=>{
 const vault={get:async()=> 'private',put:async()=>assert.fail('must not write')};
 assert.equal(await recover(number,{db:database({mapping:null}),vault}),null);
 assert.equal(await recover(number,{db:database({session:null}),vault}),null);
 await assert.rejects(recover(number,{db:database(),vault,meta:{validatePhoneOwnership:async()=>({phoneNumberId:'other',wabaId:'987654'})}}),/ownership mismatch/);
});
test('startup verification reports template counts without exposing credentials',async()=>{
 const logs=[],rows=[{customer_id:'client',whatsapp_numbers:number}];const q={select:()=>q,eq:()=>q,limit:async()=>({data:rows})};
 await repair({db:{from:()=>q},resolveToken:async()=> 'private-test',createMeta:()=>({listTemplates:async()=>[{id:'template'}]}),diagnostic:r=>logs.push(r)});
 assert.equal(logs[0].success,true);assert.equal(logs[0].template_count,1);assert.ok(!JSON.stringify(logs).includes('private-test'));
});
