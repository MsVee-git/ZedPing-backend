// Operator preparation only: creates a reviewed support template, never sends
// it to a recipient. The button postback can reset a stale Meta routing owner.
const TEMPLATE={name:'zedping_support_continue_v1',category:'UTILITY',language:'en_US',
 body:'You requested help with your ZedPing conversation. Tap Continue below to resume your support chat.',
 buttons:[{type:'quick_reply',text:'Continue'}]}
async function prepareRoutingRecoveryTemplate({db,customerId,resolveToken,meta,diagnostic}) {
 if(!/^[0-9a-f-]{36}$/.test(customerId||'')) return
 const rows=await db.from('whatsapp_numbers').select('*').eq('customer_id',customerId).eq('status','connected').limit(2)
 if(rows.error || rows.data?.length!==1) throw Error('Select one connected number')
 const number=rows.data[0]
 const accessToken=await resolveToken(number,{customerId})
 const params={wabaId:number.whatsapp_business_account_id,accessToken}
 let templates=await meta.listTemplates(params)
 let selected=templates.find(t=>t.name===TEMPLATE.name && t.language===TEMPLATE.language)
 if(!selected) {
  await meta.createTemplate({...params,template:TEMPLATE})
  templates=await meta.listTemplates(params)
  selected=templates.find(t=>t.name===TEMPLATE.name && t.language===TEMPLATE.language)
 }
 // Do not consider a name match proof that a previously created template is
 // the recovery template. Verify the exact visible body and quick-reply button.
 const body=selected?.components?.find(c=>String(c.type).toUpperCase()==='BODY')
 const buttons=selected?.components?.find(c=>String(c.type).toUpperCase()==='BUTTONS')?.buttons
 const matches=body?.text===TEMPLATE.body && buttons?.length===1 && buttons[0].type==='QUICK_REPLY' && buttons[0].text==='Continue'
 const status=['APPROVED','PENDING','REJECTED','PAUSED','DISABLED'].includes(selected?.status)?selected.status:'UNKNOWN'
 diagnostic({event:'routing_recovery_template',connection_id:number.id,name:TEMPLATE.name,status,matches:matches===true,
  category:['UTILITY','MARKETING'].includes(selected?.category)?selected.category:null,
  ready:matches===true && status==='APPROVED' && selected?.category==='UTILITY'})
}
module.exports={prepareRoutingRecoveryTemplate,TEMPLATE}
