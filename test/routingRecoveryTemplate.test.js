const test=require('node:test')
const assert=require('node:assert/strict')
const {prepareRoutingRecoveryTemplate,TEMPLATE}=require('../lib/routingRecoveryTemplate')
const customerId='3b25fffa-f0c4-4d98-a69c-fbbeb7afe6c3'
function db(){const q={select(){return this},eq(){return this},limit:async()=>({data:[{id:'number',customer_id:customerId,whatsapp_business_account_id:'123456'}]})};return {from:()=>q}}
function approved(body=TEMPLATE.body){return {name:TEMPLATE.name,language:TEMPLATE.language,status:'APPROVED',category:'UTILITY',components:[{type:'BODY',text:body},{type:'BUTTONS',buttons:[{type:'QUICK_REPLY',text:'Continue'}]}]}}
test('preparation reuses the exact approved recovery template and never sends it',async()=>{
 const logs=[]
 await prepareRoutingRecoveryTemplate({db:db(),customerId,resolveToken:async()=> 'PRIVATE',meta:{listTemplates:async()=>[approved()],createTemplate:async()=>{throw Error('must reuse')}},diagnostic:r=>logs.push(r)})
 assert.equal(logs[0].ready,true)
 assert.ok(!JSON.stringify(logs).includes('PRIVATE'))
})
test('same-name different content is not considered safe to send',async()=>{
 const logs=[]
 await prepareRoutingRecoveryTemplate({db:db(),customerId,resolveToken:async()=> 'PRIVATE',meta:{listTemplates:async()=>[approved('Unrelated campaign')]},diagnostic:r=>logs.push(r)})
 assert.equal(logs[0].ready,false)
})
test('missing template is submitted once and only approved content is marked ready',async()=>{
 let created=0
 const logs=[]
 await prepareRoutingRecoveryTemplate({db:db(),customerId,resolveToken:async()=> 'PRIVATE',meta:{listTemplates:async()=>created?[{...approved(),status:'PENDING'}]:[],createTemplate:async({template})=>{assert.deepEqual(template,TEMPLATE);created++}},diagnostic:r=>logs.push(r)})
 assert.equal(created,1);assert.equal(logs[0].ready,false);assert.equal(logs[0].status,'PENDING')
})
