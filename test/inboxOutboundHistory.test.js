const test=require('node:test');const assert=require('node:assert/strict');const {loadOutboundHistory,mergeOutboundHistory}=require('../lib/inboxOutboundHistory')
test('loads only orphaned outbound history for the exact workspace, number and contact',async()=>{
 const filters=[];const q={select:()=>q,eq:(...args)=>{filters.push(args);return q},is:(...args)=>{filters.push(args);return q},order:()=>q,limit:async()=>({data:[{id:'broadcast',created_at:'2026-10-12T08:00:00Z',message_body:'Full body respray offer'}]})}
 const history=await loadOutboundHistory({from:()=>q},'workspace',{contact_id:'contact',whatsapp_number_id:'number'})
 assert.deepEqual(filters,[['customer_id','workspace'],['whatsapp_number_id','number'],['contact_id','contact'],['direction','outbound'],['conversation_id',null]])
 assert.match(history[0].message_body,/background, not a quoted reply/);assert.match(history[0].message_body,/Full body respray/);assert.equal(history[0].reply_to_message_id,undefined)
 const merged=mergeOutboundHistory([{id:'reply',created_at:'2026-10-12T09:00:00Z'}],history);assert.deepEqual(merged.map(m=>m.id),['broadcast','reply'])
})
test('an attached message takes precedence without duplicating a quote parent',()=>{
 assert.deepEqual(mergeOutboundHistory([{id:'same',message_body:'original',created_at:'1'}],[{id:'same',message_body:'background',created_at:'1'}]),[{id:'same',message_body:'original',created_at:'1'}])
})
test('no contact identity means no background lookup',async()=>{
 assert.deepEqual(await loadOutboundHistory({from:()=>{throw Error('unexpected')}},'workspace',{}),[])
})
