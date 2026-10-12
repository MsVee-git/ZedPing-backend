const test=require('node:test');const assert=require('node:assert/strict');const {processGupshupInboxBatch}=require('../lib/gupshupInboxWorker');
test('bounded worker stops when queue is empty',async()=>{let calls=0;assert.deepEqual(await processGupshupInboxBatch({rpc:async()=>({data:++calls===1?'event1':null})}),{processed:1});assert.equal(calls,2)});
test('transaction failure propagates without consuming more events',async()=>{let calls=0;await assert.rejects(processGupshupInboxBatch({rpc:async()=>{calls++;return {error:true}}}),/transaction failed/);assert.equal(calls,1)});
