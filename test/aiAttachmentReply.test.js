const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { buildLiveSystem } = require('../lib/zoeGrounding')
const { attachmentCaption } = require('../lib/contentLibraryAttachments')
const { adReferralContext } = require('../lib/whatsappAdReferral')
const { boundedHistory } = require('../lib/aiRuntime')
const source = fs.readFileSync(require.resolve('../routes/webhook'), 'utf8')
const turnSource = source.slice(source.indexOf('async function runLiveAiTurn'), source.indexOf('async function checkAISession'))
const menu = { id:'menu', name:'Braai House Demo Menu', filename:'Braai_House_Demo_Menu.pdf', type:'document' }
const version = { configuration:{ configuration:{ shareable_attachments:[menu] } }, knowledge_snapshot:[{id:'facts',name:'Menu',text_content:'The chicken costs K145.'}] }

function harness({ sendFile } = {}) {
  const sent = [], saved = [], modelRequests = []
  let completions = 0
  const context = {
    buildLiveSystem, attachmentCaption,
    aiReplyContext:()=>'', adReferralContext, commercialTurn:()=>null, configuredHandoff:()=>null,
    boundedHistory, removeHandoffMarker:text=>text, requestsModelHandoff:()=>false,
    isCustomerSafeReply:()=>true, BETA_MODEL:'test', supabase:{}, estimateCostUsd:()=>0,
    recordAiExecutionEvent:async()=>{}, scheduleFollowups:async()=>{},
    updateLiveSession:async (_ctx, _session, payload)=>saved.push(payload.messages),
    getAICompletion:async(prompt,history)=>{ modelRequests.push({prompt,history}); completions++; return {text:'The chicken costs K145.',model:'test'} },
    outgoing:async (_ctx,text)=>sent.push({text}),
    outgoingContentAttachment:async (_ctx,file,_source,caption)=>{
      if (sendFile) return sendFile()
      sent.push({file:file.filename,caption}); return {id:'accepted'}
    }
  }
  vm.createContext(context)
  const runTurn = vm.runInContext(`(${turnSource.trim()})`,context)
  return {sent,saved,modelRequests,completions:()=>completions,run:(body,adReferral)=>runTurn({body,adReferral,customerId:'workspace',number:{id:'number'}},{id:'session',messages:[]},{id:'agent',name:'Braai House'},version)}
}

test('a clear menu request sends one captioned PDF and does not generate menu text', async () => {
  const h = harness()
  await h.run('Share your menu please')
  assert.deepEqual(h.sent,[{file:menu.filename,caption:'Here’s our menu.'}])
  assert.equal(h.completions(),0)
  assert.equal(h.saved[0].at(-1).content,'Here’s our menu.')
})

test('price and text-only menu questions generate text without an attachment', async () => {
  for (const question of ['How much is the chicken on the menu?', 'Please share your menu in text', 'Can you show me the price of chicken on your menu?']) {
    const h = harness()
    await h.run(question)
    assert.deepEqual(h.sent,[{text:'The chicken costs K145.'}])
    assert.equal(h.completions(),1)
  }
})

test('a duplicate claim or uncertain file submission never sends an extra reply', async () => {
  for (const sendFile of [async()=>null,async()=>{throw Error('Provider timeout')}]) {
    const h = harness({sendFile})
    await h.run('Menu please')
    assert.equal(h.sent.length,0)
    assert.equal(h.saved.length,0)
    assert.equal(h.completions(),0)
  }
})

test('a broad ad enquiry reaches the live model with answer-first instructions and the customer message intact', async () => {
  const h = harness()
  const question = 'Hello! Can I get more info on this?'
  await h.run(question, {source_type:'ad',source_id:'123456',headline:'Restaurant menu',body:'See our menu. '.repeat(250)})
  const request = h.modelRequests[0]
  assert.match(request.prompt, /Start with a short, useful answer about what the ad is promoting/)
  assert.match(request.prompt, /The chicken costs K145/)
  assert.ok(request.history.at(-1).content.startsWith('Customer message:\n'+question))
  assert.match(request.history.at(-1).content, /Restaurant menu/)
  assert.equal(h.sent.length,1)
  assert.equal(h.sent[0].file,undefined)
  const ordinary = harness()
  await ordinary.run(question)
  assert.doesNotMatch(ordinary.modelRequests[0].prompt, /This message came from a WhatsApp ad/)
})
