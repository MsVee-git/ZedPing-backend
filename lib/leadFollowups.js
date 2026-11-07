const {plannedJobs,followupEligible,resolveFollowupTemplate}=require('./leadFollowupPolicy')
const {buildLiveSystem,removeHandoffMarker,requestsModelHandoff,isCustomerSafeReply}=require('./zoeGrounding')
async function checked(query) {const result=await query;if(result.error)throw result.error;return result.data}
async function cancelFollowups(db,customerId,conversationId) {
  await checked(db.from('ai_lead_followup_jobs').update({state:'cancelled',finished_at:new Date().toISOString(),reason:'customer_replied'}).eq('customer_id',customerId).eq('conversation_id',conversationId).eq('state','queued'))
}
async function scheduleFollowups(db,{customerId,conversation,agent,session,config,latestMessage}) {
  const rows=plannedJobs({customerId,conversation,agent,session,config,latestMessage})
  if(rows.length)await checked(db.from('ai_lead_followup_jobs').upsert(rows,{onConflict:'conversation_id,anchor_at,step',ignoreDuplicates:true}))
}
async function loadState(db,job) {
  const [conversation,contact,agent,version,session]=await Promise.all([
    checked(db.from('conversations').select('*').eq('customer_id',job.customer_id).eq('id',job.conversation_id).maybeSingle()),
    checked(db.from('contacts').select('id,customer_id,phone_number,marketing_opted_out').eq('customer_id',job.customer_id).eq('id',job.contact_id).maybeSingle()),
    checked(db.from('ai_agents').select('*').eq('customer_id',job.customer_id).eq('id',job.agent_id).maybeSingle()),
    checked(db.from('ai_agent_configuration_versions').select('version,configuration,knowledge_snapshot').eq('customer_id',job.customer_id).eq('agent_id',job.agent_id).not('activated_at','is',null).order('version',{ascending:false}).limit(1).maybeSingle()),
    checked(db.from('ai_agent_sessions').select('id,status').eq('customer_id',job.customer_id).eq('id',job.session_id).maybeSingle())])
  return {conversation,contact,agent,version,session}
}
async function processFollowup({db,job,complete,sendText,sendTemplate,listTemplates,now=()=>new Date()}) {
  const nextStep={1:24,24:72,72:96}[job.step]
  if(nextStep && now().getTime()>=Date.parse(job.anchor_at)+nextStep*3600000)return {state:'blocked',reason:'step_expired'}
  let state=await loadState(db,job)
  if(!followupEligible(job,state,now().getTime()))return {state:'cancelled',reason:'conversation_changed_or_step_expired'}
  const number=await checked(db.from('whatsapp_numbers').select('*').eq('customer_id',job.customer_id).eq('id',job.whatsapp_number_id).eq('status','connected').maybeSingle())
  if(!number)return {state:'blocked',reason:'connection_unavailable'}
  if(job.step===96) {
    // Compare-and-set prevents closing a conversation that received a reply or
    // was taken over while this job was being processed. History is retained.
    const closed=await checked(db.from('conversations').update({status:'resolved',control_mode:'human',resolved_at:now().toISOString(),updated_at:now().toISOString()})
      .eq('id',job.conversation_id).eq('customer_id',job.customer_id).eq('status','open').eq('control_mode','automation').is('assigned_user_id',null).eq('last_inbound_at',job.anchor_at).select('id').maybeSingle())
    if(!closed)return {state:'cancelled',reason:'conversation_changed'}
    await checked(db.from('ai_agent_sessions').update({status:'ended',ended_at:now().toISOString(),completion_reason:'lead_unresponsive'})
      .eq('customer_id',job.customer_id).eq('conversation_id',job.conversation_id).eq('id',job.session_id).eq('status','active'))
    return {state:'done',reason:'closed_no_response'}
  }
  let body,template,aiCompletion
  if(job.step===1) {
    if(now().getTime()>=Date.parse(job.anchor_at)+24*3600000)return {state:'blocked',reason:'reply_window_closed'}
    const session=await checked(db.from('ai_agent_sessions').select('messages,status').eq('id',job.session_id).eq('customer_id',job.customer_id).maybeSingle())
    if(!session || session.status!=='active')return {state:'cancelled',reason:'session_ended'}
    const history=session.messages || []
    const live=buildLiveSystem(state.agent,state.version,'Follow up the customer’s most recent enquiry',history)
    const instruction='Send one brief, friendly follow-up about the customer’s most recent enquiry. They have not replied for one hour. Use their stated interest and supported facts. Do not repeat the previous answer, invent a discount, deadline, stock or completed action, or ask for details already supplied. Do not imply the customer replied. Ask at most one useful question. If their intent was to stop, decline or end the conversation, output exactly [[SKIP]].'
    const result=await complete(live.prompt,[...history,{role:'user',content:instruction}])
    aiCompletion=result
    if(/\[\[SKIP\]\]/.test(result.text || ''))return {state:'cancelled',reason:'no_followup_needed'}
    if(result.precisionCheck!=='supported' || !result.text || /\[\[SKIP\]\]/.test(result.text) || requestsModelHandoff(result.text))return {state:'blocked',reason:'no_supported_followup'}
    body=removeHandoffMarker(result.text)
    if(!isCustomerSafeReply(body))return {state:'blocked',reason:'unsafe_followup'}
  } else {
    const templates=await listTemplates(number,job.customer_id)
    template=resolveFollowupTemplate(templates,job)
    if(!template)return {state:'blocked',reason:'approved_marketing_template_unavailable'}
    body=template.components.filter(part=>part.text).map(part=>part.text).join('\n')
  }
  // Re-read immediately before provider submission: customer replies, consent,
  // control changes, agent pause and version changes all cancel the send.
  state=await loadState(db,job)
  if(!followupEligible(job,state,now().getTime()))return {state:'cancelled',reason:'conversation_changed'}
  const result=template
    ? await sendTemplate({number,customerId:job.customer_id,to:state.contact.phone_number,category:template.category,template:{name:template.name,language:template.language,components:[]}})
    : await sendText({number,customerId:job.customer_id,to:state.contact.phone_number,body})
  if(aiCompletion)await require('./aiExecutionEvents').recordAiExecutionEvent(db,{customerId:job.customer_id,whatsappNumberId:job.whatsapp_number_id,agentId:job.agent_id,sessionId:job.session_id,agentVersion:job.agent_version,model:aiCompletion.model,outcome:'replied',executionMode:'live',inputTokens:aiCompletion.inputTokens,outputTokens:aiCompletion.outputTokens,estimatedCostUsd:require('./aiRuntime').estimateCostUsd(aiCompletion.model,aiCompletion.inputTokens,aiCompletion.outputTokens)}).catch(()=>{})
  await checked(db.from('messages').insert({customer_id:job.customer_id,whatsapp_number_id:job.whatsapp_number_id,contact_id:job.contact_id,conversation_id:job.conversation_id,
    direction:'outbound',to_number:state.contact.phone_number,message_body:body,status:'accepted',meta_message_id:result?.messages?.[0]?.id || null}))
  const previousSession=await checked(db.from('ai_agent_sessions').select('messages,updated_at').eq('id',job.session_id).eq('customer_id',job.customer_id).eq('status','active').maybeSingle())
  if(previousSession)await checked(db.from('ai_agent_sessions').update({messages:require('./aiRuntime').boundedHistory([...(previousSession.messages || []),{role:'assistant',content:body}]),updated_at:now().toISOString()}).eq('id',job.session_id).eq('customer_id',job.customer_id).eq('status','active').eq('updated_at',previousSession.updated_at))
  // Do not reset the anchor or customer-service window after our own follow-up.
  await checked(db.from('conversations').update({last_outbound_at:now().toISOString(),last_message_at:now().toISOString(),updated_at:now().toISOString()})
    .eq('id',job.conversation_id).eq('customer_id',job.customer_id).eq('last_inbound_at',job.anchor_at))
  return {state:'done',reason:'submitted'}
}
async function runLeadFollowups(deps) {
  const {db,now=()=>new Date()}=deps
  // At-most-once dispatch: interrupted sends require manual inspection and are
  // never automatically replayed after a provider outcome becomes uncertain.
  await checked(db.from('ai_lead_followup_jobs').update({state:'failed',reason:'interrupted_check_delivery',finished_at:now().toISOString()}).eq('state','running').lt('started_at',new Date(now().getTime()-10*60000).toISOString()))
  const rows=await checked(db.from('ai_lead_followup_jobs').select('*').eq('state','queued').lte('due_at',now().toISOString()).order('due_at').limit(10))
  for(const row of rows || []) {
    const job=await checked(db.from('ai_lead_followup_jobs').update({state:'running',started_at:now().toISOString()}).eq('id',row.id).eq('state','queued').select('*').maybeSingle())
    if(!job)continue
    let result
    try {result=await processFollowup({...deps,job,now})}catch{result={state:'failed',reason:'submission_or_processing_failed_check_delivery'}}
    if(result.state==='cancelled')await checked(db.from('ai_lead_followup_jobs').update({state:'cancelled',reason:result.reason,finished_at:now().toISOString()}).eq('customer_id',job.customer_id).eq('conversation_id',job.conversation_id).eq('anchor_at',job.anchor_at).eq('state','queued'))
    await checked(db.from('ai_lead_followup_jobs').update({...result,finished_at:now().toISOString()}).eq('id',job.id).eq('state','running'))
  }
}
module.exports={scheduleFollowups,cancelFollowups,processFollowup,runLeadFollowups}
