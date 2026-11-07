const HOURS = [1, 24, 72, 96]
const DEFAULT_TEMPLATE_NAMES = { 24:'zedping_ai_followup_24h', 72:'zedping_ai_followup_72h' }

function templateSelector(step, config) {
  if (!DEFAULT_TEMPLATE_NAMES[step]) return null
  const saved = config?.enabled === true ? config[`template_${step}h_id`] : null
  return saved || `auto:${step}`
}

function eligibleTemplate(template) {
  const parts=template?.components || []
  return String(template?.status).toUpperCase()==='APPROVED' && template?.category==='MARKETING' && Boolean(template?.id && template?.name && template?.language)
    && parts.some(part=>part.type==='BODY' && part.text)
    && parts.every(part=>['BODY','FOOTER'].includes(part.type)) && !/\{\{|\}\}/.test(JSON.stringify(parts))
}
function resolveFollowupTemplate(templates, job) {
  const available = templates.filter(eligibleTemplate)
  if (job.template_id !== `auto:${job.step}`) {
    return available.find(template => String(template.id) === job.template_id)
  }
  const matches = available.filter(template => template.name === DEFAULT_TEMPLATE_NAMES[job.step])
  if (matches.length === 1) return matches[0]
  return matches.find(template => template.language === 'en') || matches.find(template => template.language === 'en_US')
}

function followupEligible(job, {conversation,contact,agent,version,session}, now=Date.now()) {
  if(!conversation || !contact || !agent || !version || !session || !['active','expired'].includes(session.status)) return false
  return agent.lifecycle_status==='active' && agent.is_active===true && agent.deployment_mode==='live'
    && agent.whatsapp_number_id===job.whatsapp_number_id && version.version===job.agent_version
    && conversation.customer_id===job.customer_id && conversation.whatsapp_number_id===job.whatsapp_number_id
    && contact.customer_id===job.customer_id && contact.id===conversation.contact_id && contact.marketing_opted_out!==true
    && conversation.status==='open' && conversation.control_mode==='automation' && !conversation.assigned_user_id
    && Date.parse(conversation.last_inbound_at)===Date.parse(job.anchor_at)
    && (job.step===96 || now < Date.parse(job.anchor_at) + (HOURS[HOURS.indexOf(job.step)+1])*3600000)
}
function plannedJobs({customerId,conversation,agent,session,config,latestMessage = ""}) {
  if(agent.deployment_mode!=='live' || !conversation?.last_inbound_at || /^\s*(?:thanks|thank you|ok|okay|great|bye|all good|sorted|that.s all)[.!\s]*$/i.test(latestMessage) || /\b(not interested|no thanks|no thank you|stop messaging|do not contact|don.t contact|goodbye|unsubscribe)\b/i.test(latestMessage)) return []
  return HOURS.map(step=>({customer_id:customerId,conversation_id:conversation.id,contact_id:conversation.contact_id,
    whatsapp_number_id:agent.whatsapp_number_id,agent_id:agent.id,session_id:session.id,agent_version:session.agent_version,
    anchor_at:conversation.last_inbound_at,step,due_at:new Date(Date.parse(conversation.last_inbound_at)+step*3600000).toISOString(),
    template_id:templateSelector(step,config),state:'queued'}))
}
module.exports={HOURS,eligibleTemplate,resolveFollowupTemplate,followupEligible,plannedJobs}
