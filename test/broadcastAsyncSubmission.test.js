const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const source = fs.readFileSync(require('node:path').join(__dirname, '../routes/broadcasts.js'), 'utf8')

function harness({asyncResponse=true,persistError=false,progressError=false,recipientCount=6}={}) {
  const handlers={},updates=[],sent=[],messages=[],responses=[]
  let release,entered
  const gate=new Promise(resolve=>{release=resolve})
  const started=new Promise(resolve=>{entered=resolve})
  const db={from(table){
    if(table==='messages')return {async insert(row){messages.push(row);return {error:null}}}
    assert.equal(table,'scheduled_broadcasts')
    return {
      insert(){return {select(){return {async single(){return persistError?{error:new Error('storage down')}:{data:{id:'activity'}}}}}}},
      update(value){
        const chain={eq(){return chain},then(resolve,reject){
          updates.push(value)
          return (progressError&&!value.status?Promise.reject(new Error('progress unavailable')):Promise.resolve({error:null})).then(resolve,reject)
        }}
        return chain
      }
    }
  }}
  const router={get(){},post(path,...parts){handlers[path]=parts.at(-1)}}
  const multer=()=>({single:()=>()=>{}});multer.memoryStorage=()=>({})
  const review={number:{id:'number',phone_number_id:'meta'},template:{name:'promo',language:'en_US',header_media_type:'text',category:'MARKETING'},recipients:Array.from({length:recipientCount},(_,i)=>({id:'c'+i,phone_number:'2609700000'+i,template_components:[]})),eligible_recipients:recipientCount,skipped_recipients:0,opted_out_recipients:1}
  class MetaTemplateError extends Error {}
  const imports={express:{Router:()=>router},multer,'../lib/supabase':db,'../lib/metaTemplates':{MetaTemplateError},'../lib/broadcastTemplates':{renderedTemplatePreview:()=> 'Rendered promo'},'../lib/whatsappRuntime':{sendWorkspaceTemplate:async params=>{sent.push(params);if(sent.length===1){entered();await gate}return {messages:[{id:'wamid-'+sent.length}]}}}}
  const context={module:{exports:{}},require:id=>imports[id]||{},console:{error(){}},testReview:async()=>review}
  vm.runInNewContext(source+'\ntemplateReview = testReview;',context)
  const res={headersSent:false,statusCode:200,status(code){this.statusCode=code;return this},json(body){assert.equal(this.headersSent,false,'second HTTP response');responses.push(body);this.headersSent=true;return this}}
  const req={workspace:{customerId:'workspace'},body:{},headers:asyncResponse?{prefer:'respond-async'}:{}}
  return {run:()=>handlers['/send-template'](req,res),started,release,res,responses,updates,sent,messages}
}
test('acknowledges a saved campaign before the first slow provider send finishes',async()=>{
  const h=harness();let finished=false
  const job=h.run().then(()=>{finished=true})
  await h.started
  assert.equal(finished,false)
  assert.equal(h.res.statusCode,202)
  assert.equal(h.responses[0].activity_id,'activity')
  assert.equal(h.responses[0].status,'sending')
  assert.equal(h.responses[0].accepted,undefined)
  h.release();await job
  assert.equal(h.responses.length,1)
  assert.equal(h.sent.length,6)
  assert.equal(h.messages.length,6)
  assert.equal(h.updates.at(-1).status,'completed')
  assert.equal(h.updates.at(-1).sent_count,6)
  assert.equal(h.updates[0].sent_count,5)
})
test('older clients retain the final counts response',async()=>{
  const h=harness({asyncResponse:false});const job=h.run();await h.started
  assert.equal(h.responses.length,0)
  h.release();await job
  assert.equal(h.res.statusCode,200)
  assert.equal(h.responses[0].accepted,6)
})
test('failed campaign persistence never acknowledges or sends',async()=>{
  const h=harness({persistError:true});await h.run()
  assert.equal(h.res.statusCode,502)
  assert.equal(h.sent.length,0)
})
test('progress reporting failure neither stops nor retries provider sends',async()=>{
  const h=harness({progressError:true});const job=h.run();await h.started;h.release();await job
  assert.equal(h.sent.length,6)
  assert.equal(h.updates.at(-1).status,'completed')
  assert.equal(h.responses.length,1)
})
