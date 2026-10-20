const CORELINE_WORKSPACE = '3b25fffa-f0c4-4d98-a69c-fbbeb7afe6c3'
function validateLead(body) {
 if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Enter your contact details.')
 if (body.website) return null // Honeypot: never save or send spam submissions.
 const text = (key, min, max) => {
  if (typeof body[key] !== 'string') throw new Error('Complete your name, business and WhatsApp number.')
  const value=body[key].trim()
  if(value.length<min||value.length>max)throw new Error('Check the length of your contact details.')
  return value
 }
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.submission_id||''))throw new Error('Refresh the page and try again.')
 if(body.consent!==true)throw new Error('Please allow us to contact you about this enquiry.')
 const phone=text('phone',7,30).replace(/[\s()+-]/g,'')
 if(!/^[1-9][0-9]{6,14}$/.test(phone))throw new Error('Enter your WhatsApp number with its country code, for example +260977123456.')
 const email=typeof body.email==='string'?body.email.trim().toLowerCase():''
 if(email&&(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))throw new Error('Enter a valid email address.')
 if(!['demo','starter','business','pro','help'].includes(body.interest))throw new Error('Choose what you are interested in.')
 const lead={submission_id:body.submission_id,name:text('name',2,100),business_name:text('business_name',2,160),phone,email:email||null,interest:body.interest,message:text('message',0,2000)}
 for(const key of ['utm_source','utm_medium','utm_campaign'])lead[key]=typeof body[key]==='string'?body[key].trim().slice(0,100):null
 return lead
}
function createCaptureHandler(db) {
 return async(req,res)=>{
  res.set('Cache-Control','no-store')
  if(!['https://zedping.app','https://www.zedping.app'].includes(req.get('origin')))return res.status(403).json({error:'Submit this form from zedping.app.'})
  let lead
  try{lead=validateLead(req.body)}catch(error){return res.status(400).json({error:error.message})}
  if(!lead)return res.status(202).json({received:true})
  let result
  try { result=await db.rpc('capture_landing_lead',{p_lead:lead}) } catch { result={error:true} }
  if(result.error)return res.status(503).json({error:'We could not save your enquiry. Please try again or contact us on WhatsApp.'})
  if(!result.data)return res.status(429).json({error:'Too many enquiries. Please try again later or contact us on WhatsApp.'})
  return res.status(201).json({received:true})
 }
}
module.exports={CORELINE_WORKSPACE,validateLead,createCaptureHandler}
