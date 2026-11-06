const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const vm=require('node:vm')
const {reviewReply,fallbackReply,PRECISION_RULES}=require('../lib/answerPrecision')
const {buildLiveSystem}=require('../lib/zoeGrounding')
const {boundedHistory,boundedReply}=require('../lib/aiRuntime')

test('short follow-up retrieves the customer product rather than an earlier assistant guess',()=>{
 const version={configuration:{configuration:{knowledge_limits:{max_context_chars:135}}},knowledge_snapshot:[
  {id:'salon',name:'Salon',text_content:'Hair styling costs K400. '.repeat(3)},
  {id:'covers',name:'Tonneau covers',text_content:'Tonneau covers cost K3,500, excluding fitting. '.repeat(2)}]}
 const live=buildLiveSystem({},version,'How much?',[
  {role:'user',content:'I need tonneau covers'},
  {role:'assistant',content:'Salon hair styling costs K400'}])
 assert.equal(live.knowledge[0].id,'covers')
})

test('review accepts only a completed strict positive verdict',async()=>{
 for(const [content,finish_reason,expected] of [['{"supported":true}','stop',true],['{"supported":false}','stop',false],['{"supported":"true"}','stop',false],['not json','stop',false],['{"supported":true}','length',false]]) {
  const result=await reviewReply({chat:{completions:{create:async()=>({choices:[{message:{content},finish_reason}],usage:{prompt_tokens:20,completion_tokens:5}})}}},{model:'test',prompt:'Cover K3500',history:[],candidate:'Cover K3500'})
  assert.equal(result.supported,expected);assert.equal(result.inputTokens,20)
 }
})

function completionHarness(verdict,{failure=false}={}) {
 const source=fs.readFileSync(require.resolve('../lib/openai'),'utf8')
 const fn=source.slice(source.indexOf('async function getAICompletion'),source.indexOf('async function getAIResponse'))
 const calls=[]
 const context={BETA_MODEL:'test',SAFETY_RULES:'Safety',PRECISION_RULES,boundedHistory,boundedReply,businessPrompt:s=>s,reviewReply,fallbackReply,
 openai:{chat:{completions:{create:async request=>{
 calls.push(request)
 if(calls.length===1)return {choices:[{message:{content:'The cover is K999 and includes fitting.'}}],usage:{prompt_tokens:10,completion_tokens:10}}
 if(failure)throw new Error('timeout')
 return {choices:[{message:{content:JSON.stringify({supported:verdict})},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:5}}
 }}}}}
 vm.createContext(context)
 return {complete:vm.runInContext(fn+';getAICompletion',context),calls}
}

test('a rejected price claim is never returned and review usage is counted',async()=>{
 const h=completionHarness(false)
 const result=await h.complete('Use the exact marker [[HANDOFF]]. APPROVED INFORMATION: Cover K3500, fitting separate.',[{role:'user',content:'How much?'}])
 assert.doesNotMatch(result.text,/999|includes fitting/)
 assert.match(result.text,/team.*confirm/)
 assert.equal(result.precisionCheck,'rejected');assert.equal(result.inputTokens,30);assert.equal(result.outputTokens,15)
 assert.equal(h.calls.length,2)
})

test('review outage fails closed; disabled unknown handoff is respected',async()=>{
 const h=completionHarness(false,{failure:true})
 const result=await h.complete('APPROVED INFORMATION: Cover K3500',[])
 assert.equal(result.precisionCheck,'unavailable');assert.doesNotMatch(result.text,/999|HANDOFF/)
})

test('a supported conversational answer passes unchanged',async()=>{
 const h=completionHarness(true)
 const result=await h.complete('APPROVED INFORMATION: Cover K999 includes fitting.',[])
 assert.equal(result.text,'The cover is K999 and includes fitting.')
 assert.equal(result.precisionCheck,'supported')
})
