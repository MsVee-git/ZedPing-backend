const test=require('node:test')
const assert=require('node:assert/strict')
const {receiptRows,persistDeliveryStatuses,persistMetaDeliveryPayload}=require('../lib/deliveryReceipts')
const {initialDelivery,addDelivery}=require('../lib/deliveryMetrics')
const number={id:'n',customer_id:'w'}
test('maps status evidence and bounded safe errors without message content',()=>{
 const r=receiptRows([{id:'wamid.1',status:'failed',timestamp:'1791972000',errors:[{code:131026,title:'Undeliverable',error_data:{details:'private details'}}]}],number)[0]
 assert.equal(r.status,'failed');assert.equal(r.customer_id,'w');assert.equal(r.errors[0].code,'131026');assert.ok(!JSON.stringify(r).includes('private details'))
 assert.equal(receiptRows([{status:'deleted'}],number).length,0)
})
test('invalid dates and oversized receipt batches fail before acknowledgement',()=>{
 for(const s of [{id:'m',status:'read',timestamp:'bad'},{status:'read',timestamp:'1'}])assert.throws(()=>receiptRows([s],number))
 assert.throws(()=>receiptRows(Array(1001).fill({}),number));assert.throws(()=>receiptRows([],{}))
})
test('storage errors reject and duplicate-safe upsert preserves provider aliases',async()=>{
 let captured
 const db={from:()=>({upsert:async(rows,options)=>{captured={rows,options};return {error:null}}})}
 await persistDeliveryStatuses(db,[{id:'meta',gs_id:'gs',status:'sent',timestamp:'1791972000'}],number,'gupshup')
 assert.equal(captured.rows[0].alternate_message_id,'gs');assert.equal(captured.options.ignoreDuplicates,true)
 await assert.rejects(persistDeliveryStatuses({from:()=>({upsert:async()=>({error:{}})})},[{id:'m',status:'sent',timestamp:'1791972000'}],number),/save delivery/)
})
test('Meta receipt routing rejects ambiguous or mismatched connections',async()=>{
 const body={entry:[{id:'business',changes:[{value:{metadata:{phone_number_id:'phone'},statuses:[{id:'m',status:'read',timestamp:'1791972000'}]}}]}]}
 const db={from:()=>({select(){return this},eq(){return this},limit:async()=>({data:[{...number,whatsapp_business_account_id:'other'}]})})}
 await assert.rejects(persistMetaDeliveryPayload(db,body),/business mismatch/)
})
test('receipt categories partition outbound records; read is included in delivered',()=>{
 const m=initialDelivery()
 for(const row of [
 {status:'sent'}, {status:'accepted'}, {status:'failed'},
 {status:'sent',delivery_receipts:{sent_at:'2026-10-14T10:00:00Z'}},
 {status:'read',delivery_receipts:{read_at:'2026-10-14T10:01:00Z'}},
 {status:'failed',delivery_receipts:{failed_at:'2026-10-14T10:02:00Z',errors:[{code:'131026',title:'Undeliverable'}]}}
 ])addDelivery(m,{direction:'outbound',...row})
 assert.equal(m.unconfirmed,1);assert.equal(m.accepted_pending,1);assert.equal(m.submission_failures,1);assert.equal(m.sent_pending,1);assert.equal(m.delivered,1);assert.equal(m.read,1);assert.equal(m.failed,1)
 assert.equal(m.failure_reasons['131026: Undeliverable'],1)
})
