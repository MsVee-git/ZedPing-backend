const test=require('node:test');const assert=require('node:assert/strict');const {startGupshupWorkerLoop}=require('../lib/gupshupWorkerLoop')
test('disabled worker schedules nothing',()=>{startGupshupWorkerLoop({enabled:false,schedule:()=>{throw Error('unexpected')}})})
test('worker schedules the next batch only after completion and stops cleanly',async()=>{
 const tasks=[];let release,runs=0;const stop=startGupshupWorkerLoop({enabled:true,run:()=>{runs++;return new Promise(r=>release=r)},schedule:fn=>{tasks.push(fn);return tasks.length},cancel:()=>{}})
 const first=tasks.shift()();assert.equal(runs,1);assert.equal(tasks.length,0);stop();release();await first;assert.equal(tasks.length,0)
})
test('worker sanitizes failure and schedules recovery',async()=>{
 const tasks=[],errors=[];startGupshupWorkerLoop({enabled:true,run:async()=>{throw Error('secret')},onError:e=>errors.push(e),schedule:fn=>tasks.push(fn)})
 await tasks.shift()();assert.deepEqual(errors,['Gupshup worker batch failed']);assert.equal(tasks.length,1)
})
