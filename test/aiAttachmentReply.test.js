const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { buildLiveSystem } = require('../lib/zoeGrounding')
const { attachmentCaption } = require('../lib/contentLibraryAttachments')
const source = fs.readFileSync(require.resolve('../routes/webhook'), 'utf8')
const turnSource = source.slice(source.indexOf('async function runLiveAiTurn'), source.indexOf('async function checkAISession'))
const menu = { id:'menu', name:'Braai House Demo Menu', filename:'Braai_House_Demo_Menu.pdf', type:'document' }
const version = { configuration:{ configuration:{ shareable_attachments:[menu] } }, knowledge_snapshot:[{id:'facts',name:'Menu',text_content:'The chicken costs K145.'}] }

function harness({ sendFile } = {}) {
  const sent = [], saved = []
  let completions = 0
  const context = {
    buildLiveSystem, attachmentCaption,
    aiReplyContext:()=>'', adReferralContext:()=>'', commercialTurn:()=>null, configuredHandoff:()=>null,
    boundedHistory:messages=>messages, removeHandoffMarker:text=>text, requestsModelHandoff:()=>false,
    isCustomerSafeReply:()=>true, BETA_MODEL:'test', supabase:{}, estimateCostUsd:()=>0,
    recordAiExecutionEvent:async()=>{}, scheduleFollowups:async()=>{},
    updateLiveSession:async (_ctx, _session, payload)=>saved.push(payload.messages),
    getAICompletion:async()=>{ completions++; return {text:'The chicken costs K145.',model:'test'} },
    outgoing:async (_ctx,text)=>sent.push({text}),
    outgoingContentAttachment:async (_ctx,file,_source,caption)=>{
      if (sendFile) return sendFile()
      sent.push({file:file.filename,caption}); return {id:'accepted'}
    }
  }
  vm.createContext(context)
  const runTurn = vm.runInContext(`(${turnSource.trim()})`,context)
  return {sent,saved,completions:()=>completions,run:body=>runTurn({body,customerId:'workspace',number:{id:'number'}},{id:'session',messages:[]},{id:'agent',name:'Braai House'},version)}
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
