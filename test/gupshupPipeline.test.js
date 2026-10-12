const test=require('node:test');const assert=require('node:assert/strict');const {processGupshupPipeline}=require('../lib/gupshupPipeline');
test('disabled pipeline performs no database or automation work',async()=>{assert.deepEqual(await processGupshupPipeline({db:{rpc(){throw Error('must not run')}},runAutomation(){throw Error('must not run')}}),{disabled:true})});
