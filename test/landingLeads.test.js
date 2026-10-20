const {test}=require('node:test')
const assert=require('node:assert/strict')
const {validateLead,createCaptureHandler}=require('../lib/landingLeads')
const sample={submission_id:'11000000-0000-4000-8000-000000000001',name:'Demo Person',business_name:'Example Business',phone:'+260 977 123 456',email:'',interest:'demo',message:'School reminders',consent:true}
test('normalizes phone and optional email and stores no unchecked fields',()=>{const lead=validateLead({...sample,admin:true});assert.equal(lead.phone,'260977123456');assert.equal(lead.email,null);assert.equal(lead.admin,undefined)})
test('requires consent, international phone and bounded fields',()=>{for(const change of [{consent:false},{phone:'0977123456'},{email:'bad'},{message:'x'.repeat(2001)},{submission_id:'wrong'},{name:'a'}])assert.throws(()=>validateLead({...sample,...change}))})
test('honeypot submissions are dropped',()=>assert.equal(validateLead({...sample,website:'spam'}),null))
async function submit({origin='https://www.zedping.app',body=sample,result={data:true},reject=false}={}){let calls=0;let status;let value;const response={set(){},status(code){status=code;return this},json(data){value=data}};await createCaptureHandler({async rpc(){calls++;if(reject)throw new Error('secret');return result}})({get:()=>origin,body},response);return {calls,status,value}}
test('public capture accepts valid enquiries only after storage succeeds',async()=>{assert.equal((await submit()).status,201);assert.equal((await submit({result:{error:{message:'secret'}}})).status,503)})
test('foreign origins and invalid submissions never hit storage',async()=>{assert.equal((await submit({origin:'https://attacker.example'})).calls,0);assert.equal((await submit({body:{...sample,consent:false}})).calls,0)})
test('rate refusal is explicit and database errors stay private',async()=>{assert.equal((await submit({result:{data:false}})).status,429);const r=await submit({reject:true});assert.equal(r.status,503);assert.doesNotMatch(JSON.stringify(r.value),/secret/)})
