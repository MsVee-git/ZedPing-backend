const HOURS = [1, 24, 72, 96]
function normalizeFollowups(value) {
  if (!value?.enabled) return { enabled:false }
  const ids=[value.template_24h_id,value.template_72h_id]
  if(ids.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id))) throw new Error('Select approved follow-up templates for 24 and 72 hours')
  return {enabled:true,template_24h_id:ids[0],template_72h_id:ids[1]}
}
function eligibleTemplate(template) {
  const parts=template?.components || []
  return String(template?.status).toUpperCase()==='APPROVED' && template?.category==='MARKETING' && Boolean(template?.id && template?.name && template?.language)
    && parts.some(part=>part.type==='BODY' && part.text)
    && parts.every(part=>['BODY','FOOTER'].includes(part.type)) && !/\{\{|\}\}/.test(JSON.stringify(parts))
}
function followupEligible(job, {conversation,contact,agent,version,session}, now=Date.now()) {
  if(!conversation || !contact || !agent || !version || !session || !['active','expired'].includes(session.status)) return false
  const config=version.configuration?.configuration?.followups
  return config?.enabled===true && agent.lifecycle_status==='active' && agent.is_active===true && agent.deployment_mode==='live'
    && agent.whatsapp_number_id===job.whatsapp_number_id && version.version===job.agent_version
    && conversation.customer_id===job.customer_id && conversation.whatsapp_number_id===job.whatsapp_number_id
    && contact.customer_id===job.customer_id && contact.id===conversation.contact_id && contact.marketing_opted_out!==true
    && conversation.status==='open' && conversation.control_mode==='automation' && !conversation.assigned_user_id
    && Date.parse(conversation.last_inbound_at)===Date.parse(job.anchor_at)
    && (job.step===96 || now < Date.parse(job.anchor_at) + (HOURS[HOURS.indexOf(job.step)+1])*3600000)
}
function plannedJobs({customerId,conversation,agent,session,config,latestMessage = ""}) {
  if(!config?.enabled || agent.deployment_mode!=='live' || !conversation?.last_inbound_at || /^\s*(?:thanks|thank you|ok|okay|great|bye|all good|sorted|that.s all)[.!\s]*$/i.test(latestMessage) || /\b(not interested|no thanks|no thank you|stop messaging|do not contact|don.t contact|goodbye|unsubscribe)\b/i.test(latestMessage)) return []
  return HOURS.map(step=>({customer_id:customerId,conversation_id:conversation.id,contact_id:conversation.contact_id,
    whatsapp_number_id:agent.whatsapp_number_id,agent_id:agent.id,session_id:session.id,agent_version:session.agent_version,
    anchor_at:conversation.last_inbound_at,step,due_at:new Date(Date.parse(conversation.last_inbound_at)+step*3600000).toISOString(),
    template_id:step===24?config.template_24h_id:step===72?config.template_72h_id:null,state:'queued'}))
}
module.exports={HOURS,normalizeFollowups,eligibleTemplate,followupEligible,plannedJobs}
