// Explicit operator dry run: uses the activated snapshot, never sends WhatsApp
// messages or changes conversation state. Does not log prompts or reply text.
async function verifyLiveKnowledge({db,complete,customerId,diagnostic}) {
 if(!/^[0-9a-f-]{36}$/.test(customerId||'')) return
 const agents=await db.from('ai_agents').select('*').eq('customer_id',customerId).eq('is_active',true).eq('lifecycle_status','active').limit(2)
 if(agents.error || agents.data?.length!==1) throw Error('Active assistant unavailable')
 const agent=agents.data[0]
 const versions=await db.from('ai_agent_configuration_versions').select('*').eq('customer_id',customerId).eq('agent_id',agent.id).not('activated_at','is',null).order('version',{ascending:false}).limit(1).single()
 if(versions.error) throw Error('Active knowledge unavailable')
 const {buildLiveSystem,isCustomerSafeReply,requestsModelHandoff,removeHandoffMarker}=require('./zoeGrounding')
 const question='What are the subscription plans available?'
 const live=buildLiveSystem(agent,versions.data,question)
 const result=await complete(live.prompt,[{role:'user',content:question}],null)
 const reply=removeHandoffMarker(result.text)
 diagnostic({event:'live_knowledge_verification',customer_id:customerId,agent_version:versions.data.version,
  source_ids:[...new Set(live.knowledge.map(item=>item.id))],
  safe_reply:isCustomerSafeReply(reply),requested_handoff:requestsModelHandoff(result.text),
  plan_names_present:['starter','business','pro'].every(name=>new RegExp(`\\b${name}\\b`,'i').test(reply)),
  input_tokens:result.inputTokens,output_tokens:result.outputTokens})
}
module.exports={verifyLiveKnowledge}
