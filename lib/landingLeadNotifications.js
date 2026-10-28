const RECIPIENT = 'hello@zedping.app'
function emailFor(lead, from) {
 return {
  from, to: [RECIPIENT], ...(lead.email ? {reply_to:lead.email} : {}),
  subject: `New ZedPing website enquiry: ${lead.business_name.replace(/[\r\n]/g,' ')}`,
  text: [`New website enquiry`, `Name: ${lead.name}`, `Business: ${lead.business_name}`, `WhatsApp: +${lead.phone}`, `Email: ${lead.email || 'Not provided'}`, `Interested in: ${lead.interest}`, `Message: ${lead.message || 'Not provided'}`, `Source: ${lead.utm_source || 'Website'}`, `Campaign: ${lead.utm_campaign || 'Not specified'}`, '', 'View and manage: https://app.zedping.app', 'Open the Coreline Systems workspace → Overview → Website enquiries.'].join('\n')
 }
}
async function sendNotification(lead,{env=process.env,fetchImpl=globalThis.fetch}={}) {
 if(!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) throw new Error('Enquiry email configuration missing')
 const response=await fetchImpl('https://api.resend.com/emails',{
  method:'POST',signal:AbortSignal.timeout(10000),
  headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`website-enquiry/${lead.id}`},
  body:JSON.stringify(emailFor(lead,env.RESEND_FROM_EMAIL))
 })
 if(!response.ok)throw new Error(`Enquiry email rejected (${response.status})`)
 const result=await response.json()
 if(!result.id)throw new Error('Enquiry email response missing ID')
 return result.id
}
function startLeadNotifications({db,send=sendNotification,onError=()=>{},intervalMs=15000}) {
 let busy=false,stopped=false
 async function tick(){
  if(busy||stopped)return
  busy=true
  try{
   const now=new Date()
   const result=await db.from('landing_page_leads').select('*').is('notification_sent_at',null).lte('notification_next_at',now.toISOString()).gt('created_at',new Date(now-23*3600000).toISOString()).order('created_at').limit(10)
   if(result.error)throw new Error('Cannot load enquiry email queue')
   for(const lead of result.data||[]){
    if(stopped)break
    const attempts=(lead.notification_attempts||0)+1
    // Compare-and-set lease prevents parallel containers claiming the same row.
    const claimed=await db.from('landing_page_leads').update({notification_attempts:attempts,notification_next_at:new Date(Date.now()+120000).toISOString()}).eq('id',lead.id).eq('notification_next_at',lead.notification_next_at).is('notification_sent_at',null).select('id').maybeSingle()
    if(claimed.error)throw new Error('Cannot claim enquiry email')
    if(!claimed.data)continue
    try{
     const providerId=await send(lead)
     const saved=await db.from('landing_page_leads').update({notification_sent_at:new Date().toISOString(),notification_next_at:null,notification_provider_id:providerId}).eq('id',lead.id)
     if(saved.error)throw new Error('Cannot record enquiry email acceptance')
     console.info('Website enquiry email accepted',lead.id)
    }catch{
     const saved=await db.from('landing_page_leads').update({notification_next_at:new Date(Date.now()+Math.min(3600000,60000*2**Math.min(attempts,6))).toISOString()}).eq('id',lead.id)
     onError(saved.error?'Enquiry email retry could not be recorded':'Enquiry email pending retry')
    }
   }
  }catch{onError('Enquiry notification worker failed')}finally{busy=false}
 }
 const timer=setInterval(tick,intervalMs);timer.unref?.();void tick()
 return ()=>{stopped=true;clearInterval(timer)}
}
module.exports={emailFor,sendNotification,startLeadNotifications}
