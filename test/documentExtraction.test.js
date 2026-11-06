const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const { parseExtraction } = require('../lib/knowledgeExtraction')
const { DOCUMENT_TYPES, MAX_FILE_SIZE } = require('../lib/contentLibrary')
const source=fs.readFileSync(require.resolve('../lib/openai'),'utf8')
const fn=source.slice(source.indexOf('async function extractDocumentKnowledge'),source.indexOf('async function getCopilotCompletion'))
function harness(response) {
  const calls=[]
  const context={Buffer,process:{env:{}},BETA_MODEL:'gpt-4o-mini',parseExtraction,require:()=>({DOCUMENT_TYPES,MAX_FILE_SIZE}),openai:{responses:{create:async (...args)=>{calls.push(args);return response}}}}
  vm.createContext(context)
  return {extract:vm.runInContext(fn+';extractDocumentKnowledge',context),calls}
}
test('PDF and Word extraction send private file data and preserve prices for review', async()=>{
  for(const mimeType of ['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document']) {
    const h=harness({status:'completed',output_text:JSON.stringify({text:'Cover K3,500. Offer ends 30 November.',notes:['Confirm fitting charge']})})
    const result=await h.extract({buffer:Buffer.from('document'),mimeType,filename:'price-list.pdf'})
    assert.match(result.text,/K3,500/)
    assert.equal(h.calls[0][0].input[0].content[1].type,'input_file')
    assert.ok(h.calls[0][0].input[0].content[1].file_data.startsWith('data:'+mimeType+';base64,'))
    assert.equal(h.calls[0][1].maxRetries,0)
  }
})
test('invalid files never reach the model and incomplete output is rejected',async()=>{
  const h=harness({status:'incomplete',output_text:'partial'})
  await assert.rejects(h.extract({buffer:Buffer.alloc(0),mimeType:'application/pdf'}),/Invalid/)
  await assert.rejects(h.extract({buffer:Buffer.from('x'),mimeType:'image/png'}),/Invalid/)
  assert.equal(h.calls.length,0)
  await assert.rejects(h.extract({buffer:Buffer.from('x'),mimeType:'application/pdf',filename:'x.pdf'}),/incomplete/)
})
test('document route resolves ownership before reading a file and rejects archived sources',async()=>{
  const routes=fs.readFileSync(require.resolve('../routes/content'),'utf8');
  const handlerSource=routes.split("router.post('/:id/extract-document', requireAdmin, ")[1].split("\n})")[0];
  let downloaded=false,seen;
  const context={Buffer,CONTENT_BUCKET:'private',ownedItem:async(customer,id)=>{seen=[customer,id];return {content_type:'DOCUMENT',archived_at:'today',storage_path:'path'}},supabase:{storage:{from:()=>({download:async()=>{downloaded=true}})}}};
  vm.createContext(context);
  const handler=vm.runInContext('('+handlerSource+'})',context);
  const res={status(value){this.code=value;return this},json(value){this.body=value;return this}};
  await handler({workspace:{customerId:'workspace'},params:{id:'document'}},res);
  assert.deepEqual(seen,['workspace','document']);assert.equal(res.code,400);assert.equal(downloaded,false);
});
