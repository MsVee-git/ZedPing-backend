const { randomUUID } = require('node:crypto')
const BUCKET = 'campaign-media'
function scheduledTime(value, now = Date.now()) {
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('Choose a date and time in Zambia time.')
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || timestamp < now + 60000 || timestamp > now + 90 * 86400000) throw new Error('Schedule between one minute and 90 days from now.')
  return new Date(timestamp).toISOString()
}
async function saveScheduledCampaign({db,req,res,review}) {
  let at
  try { at=scheduledTime(req.body.scheduled_at) } catch(error) {return res.status(400).json({error:error.message})}
  const id=req.body.schedule_request_id
  if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))return res.status(400).json({error:'Refresh the page before scheduling.'})
  const customer=req.workspace.customerId
  const existing=await db.from('campaign_schedule_jobs').select('id,state,scheduled_at').eq('id',id).eq('customer_id',customer).maybeSingle()
  if(existing.error)throw existing.error
  if(existing.data)return res.status(200).json({success:true,status:existing.data.state==='queued'?'scheduled':existing.data.state,activity_id:id,scheduled_at:existing.data.scheduled_at})
  let mediaPath=null,activitySaved=false,jobSaved=false
  try {
    if(req.file){
      mediaPath=customer+'/'+id+'/'+randomUUID()
      const upload=await db.storage.from(BUCKET).upload(mediaPath,req.file.buffer,{contentType:req.file.mimetype,upsert:false})
      if(upload.error)throw upload.error
    }
    const contacts=review.recipients.map(({id,name,phone_number})=>({id,name,phone_number}))
    const activity=await db.from('scheduled_broadcasts').insert({id,customer_id:customer,broadcast_name:String(req.body.broadcast_name||review.template.name).trim().slice(0,160),contacts,message:'[Template] '+review.template.name+' ('+review.template.language+')',phone_number_id:review.number.phone_number_id,scheduled_at:at,status:'pending'})
    if(activity.error)throw activity.error
    activitySaved=true
    const job=await db.from('campaign_schedule_jobs').insert({id,customer_id:customer,scheduled_at:at,state:'queued',spec:{whatsapp_number_id:review.number.id,template_id:req.body.template_id,variable_mappings:req.body.variable_mappings||{}},recipients:contacts,media_path:mediaPath,media_type:req.file?.mimetype||null,media_name:req.file?.originalname||null})
    if(job.error)throw job.error
    jobSaved=true
    return res.status(202).json({success:true,status:'scheduled',activity_id:id,scheduled_at:at,total_recipients:contacts.length})
  } catch(error) {
    if(!jobSaved){
      if(activitySaved)await db.from('scheduled_broadcasts').update({status:'failed',failure_reason:'Scheduling could not be saved.'}).eq('id',id).eq('customer_id',customer)
      if(mediaPath)await db.storage.from(BUCKET).remove([mediaPath])
    }
    throw error
  }
}
async function runScheduledCampaigns({db,execute,now=()=>new Date(),onEvent=()=>{}}) {
  // A lost worker is surfaced as failed, never automatically resent after an uncertain send.
  const stale=await db.from('campaign_schedule_jobs').select('id,customer_id').eq('state','running').lte('heartbeat_at',new Date(now().getTime()-30*60000).toISOString()).limit(10)
  if(stale.error)throw stale.error
  for(const item of stale.data||[]){
    const reason='Sending was interrupted. Check campaign delivery before creating another campaign.'
    const lost=await db.from('campaign_schedule_jobs').update({state:'failed',finished_at:now().toISOString(),failure_reason:reason}).eq('id',item.id).eq('state','running').lte('heartbeat_at',new Date(now().getTime()-30*60000).toISOString()).select('id').maybeSingle()
    if(lost.error)throw lost.error
    if(lost.data){const result=await db.from('scheduled_broadcasts').update({status:'failed',failure_reason:reason,completed_at:now().toISOString()}).eq('id',item.id).eq('customer_id',item.customer_id).eq('status','sending');if(result.error)throw result.error}
  }
  // Atomic compare-and-set claims prevent replicas or cancellation from racing.
  // Never retry a claimed job after an uncertain provider outcome.
  const due=await db.from('campaign_schedule_jobs').select('id,customer_id').eq('state','queued').lte('scheduled_at',now().toISOString()).order('scheduled_at').limit(10)
  if(due.error)throw due.error
  for(const item of due.data||[]){
    const claimed=await db.from('campaign_schedule_jobs').update({state:'running',started_at:now().toISOString(),heartbeat_at:now().toISOString()}).eq('id',item.id).eq('customer_id',item.customer_id).eq('state','queued').select('*').maybeSingle()
    if(claimed.error)throw claimed.error
    const job=claimed.data
    if(!job)continue
    const heartbeat=setInterval(()=>{Promise.resolve(db.from('campaign_schedule_jobs').update({heartbeat_at:now().toISOString()}).eq('id',job.id).eq('state','running')).catch(()=>{})},30000)
    heartbeat.unref?.()
    let completed=false,failure='Scheduled campaign could not be submitted. Check the connection, template and allowance.'
    try {
      const activity=await db.from('scheduled_broadcasts').update({status:'sending'}).eq('id',job.id).eq('customer_id',job.customer_id).eq('status','pending').select('*').maybeSingle()
      if(activity.error||!activity.data)throw new Error('Campaign no longer pending')
      let file
      if(job.media_path){
        const download=await db.storage.from(BUCKET).download(job.media_path)
        if(download.error)throw download.error
        const buffer=Buffer.from(await download.data.arrayBuffer())
        file={buffer,mimetype:job.media_type,originalname:job.media_name,size:buffer.length}
      }
      // Keep the reviewed audience fixed, but refresh current contact details and consent.
      const ids=job.recipients.filter(r=>r.id).map(r=>r.id)
      let recipients=[]
      for(let offset=0;offset<ids.length;offset+=200){
        const page=await db.from('contacts').select('id,name,phone_number,email,custom_fields,marketing_opted_out').eq('customer_id',job.customer_id).in('id',ids.slice(offset,offset+200))
        if(page.error)throw page.error
        recipients.push(...page.data||[])
      }
      recipients.push(...job.recipients.filter(r=>!r.id))
      const response={statusCode:200,headersSent:false,status(code){this.statusCode=code;return this},json(body){this.headersSent=true;this.body=body;return this}}
      await execute({workspace:{customerId:job.customer_id},body:job.spec,headers:{},file,scheduledActivity:activity.data,scheduledRecipients:recipients},response)
      completed=response.statusCode<400&&response.body?.success===true
      if(!completed&&typeof response.body?.error==='string')failure=response.body.error.slice(0,300)
    } catch (_) { /* no speculative retry of provider sends */ }
    finally {clearInterval(heartbeat)}
    if(!completed){
      const result=await db.from('scheduled_broadcasts').update({status:'failed',failure_reason:failure,completed_at:now().toISOString()}).eq('id',job.id).eq('customer_id',job.customer_id)
      if(result.error)throw result.error
    }
    const result=await db.from('campaign_schedule_jobs').update({state:completed?'done':'failed',finished_at:now().toISOString(),failure_reason:completed?null:failure}).eq('id',job.id).eq('state','running')
    if(result.error)throw result.error
    if(job.media_path)await db.storage.from(BUCKET).remove([job.media_path])
    onEvent({event:'campaign_schedule_processed',id:job.id,success:completed})
  }
}
module.exports={scheduledTime,saveScheduledCampaign,runScheduledCampaigns}
