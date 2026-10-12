const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
test('image test-send validates, uploads and includes the uploaded header in Meta request', async () => {
 const original=Module._load;const calls=[]
 const db={from:()=>({insert:async()=>({error:null})})}
 Module._load=function(id,parent,...rest){
  if(parent?.filename.endsWith('/routes/templates.js')){
   if(id==='../lib/supabase')return db
   if(id==='../middleware/auth')return {requireAdmin:(req,res,next)=>next()}
   if(id==='../lib/whatsappCredentials')return {resolveWhatsAppAccessToken:async()=> 'test-token'}
   if(id==='../lib/workspaceTemplates')return {loadWorkspaceTemplates:async()=>({kind:'ok',number:{id:'n',phone_number_id:'12345'},templates:[{id:'t',name:'photo',language:'en_US',components:[{type:'HEADER',format:'IMAGE'}]}],meta:{approvedNoVariableTemplate:t=>t}})}
   if(id==='../lib/whatsapp')return {uploadWhatsAppMedia:async(n,file)=>{calls.push(file.mimetype);return 'media-id'},sendTemplateMessage:async(n,to,t)=>{calls.push(t);return {messages:[{id:'wamid.test'}]}}}
  }
  return original.call(this,id,parent,...rest)
 }
 let router;try{router=require('../routes/templates')}finally{Module._load=original}
 const route=router.stack.find(s=>s.route?.path==='/send').route
 let status=200,body;const res={status:n=>{status=n;return res},json:b=>{body=b;return res}}
 await route.stack.at(-1).handle({workspace:{customerId:'c'},body:{template_id:'t',to:'+260975393853'},file:{buffer:Buffer.from([255,216,255,0]),size:4,mimetype:'application/octet-stream',originalname:'photo.jpg'}},res)
 assert.equal(status,200);assert.equal(body.success,true);assert.equal(calls[0],'image/jpeg');assert.deepEqual(calls[1].headerMedia,{type:'image',id:'media-id'})
})
