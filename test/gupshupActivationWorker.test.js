const test=require('node:test'),assert=require('node:assert/strict');
const {reconcilePendingGupshupConnections:run}=require('../lib/gupshupActivationWorker');
const env={GUPSHUP_WORKER_ENABLED:'true',GUPSHUP_ROUTING_ENABLED:'true',GUPSHUP_WEBHOOK_ENABLED:'true',GUPSHUP_WEBHOOK_SECRET:'x'.repeat(32)};
const row={customer_id:'client',whatsapp_number_id:'number',app_id:'app',link_state:'linked',whatsapp_numbers:{id:'number',customer_id:'client',status:'provisioning'}};
function db(rows){const q={select:()=>q,eq:()=>q,not:()=>q,order:()=>q,limit:async()=>({data:rows})};return {from:()=>q}}
test('worker checks existing linked apps without requiring an open browser',async()=>{
 let checks=0;const diagnostics=[];
 await run({db:db([row]),env,configForCustomer:()=>({callbackUrl:'https://example.com'}),createPartner:()=>({}),reconcile:async args=>{checks++;assert.equal(args.mapping.app_id,'app');assert.equal(args.routingReady,true);return {phase:'complete'}},diagnostic:r=>diagnostics.push(r)});
 assert.equal(checks,1);assert.equal(diagnostics[0].phase,'complete');
});
test('worker preserves failures and refuses mismatched ownership',async()=>{
 const diagnostics=[];let calls=0;
 await run({db:db([{...row,customer_id:'other'},row]),env,configForCustomer:()=>({}),createPartner:()=>({}),reconcile:async()=>{calls++;throw Object.assign(new Error('private'),{stage:'app_status',status:401})},diagnostic:r=>diagnostics.push(r)});
 assert.equal(calls,1);assert.equal(diagnostics[0].http_status,401);assert.ok(!JSON.stringify(diagnostics).includes('private'));
});
