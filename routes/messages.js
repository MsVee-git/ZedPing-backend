const { sendWorkspaceText } = require('../lib/whatsappRuntime')
const { resolveWhatsAppAccessToken } = require('../lib/whatsappCredentials')
const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { sendTextMessage } = require('../lib/whatsapp')

router.post('/send', async (req, res) => {
  const { to, message, phoneNumberId } = req.body
  if (!to || !message || !phoneNumberId) return res.status(400).json({ error: 'to, message and phoneNumberId are required' })
  const { data: number } = await supabase.from('whatsapp_numbers').select('*').eq('id', phoneNumberId).eq('customer_id', req.workspace.customerId).eq('status', 'connected').maybeSingle()
  if (!number) return res.status(404).json({ error: 'Connected WhatsApp number not found' })
  try {
    const result = await sendWorkspaceText({ number, customerId: req.workspace.customerId, to, body: message })
    await supabase.from('messages').insert({ customer_id:req.workspace.customerId, whatsapp_number_id:number.id, direction:'outbound', to_number:to, message_body:message, status:'accepted', meta_message_id:result?.messages?.[0]?.id || null })
    res.json({ success:true, result })
  } catch (error) { res.status(500).json({ success:false, error:error.message }) }
})
router.get('/', async (req,res) => {
 const {data,error}=await supabase.from('messages').select('*').eq('customer_id',req.workspace.customerId).order('created_at',{ascending:false}).limit(50)
 if(error) return res.status(500).json({error:error.message}); res.json(data)
})
module.exports=router

