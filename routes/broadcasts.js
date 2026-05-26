const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { sendTextMessage } = require('../lib/whatsapp')

async function sendBroadcast(contacts, message, phoneNumberId) {
  const results = []
  for (const contact of contacts) {
    try {
      let msg = message
      msg = msg.replace(/{{name}}/gi, contact.name || '')
      msg = msg.replace(/{{phone}}/gi, contact.phone_number || '')
      if (contact.custom_fields) {
        Object.entries(contact.custom_fields).forEach(([k, v]) => {
          msg = msg.replace(new RegExp(`{{${k}}}`, 'gi'), v || '')
        })
      }
      await sendTextMessage(phoneNumberId, contact.phone_number, msg)
      await supabase.from('messages').insert({
        direction: 'outbound',
        to_number: contact.phone_number,
        message_body: msg,
        status: 'sent'
      })
      results.push({ phone: contact.phone_number, status: 'sent' })
      await new Promise(r => setTimeout(r, 50))
    } catch (err) {
      results.push({ phone: contact.phone_number, status: 'failed', error: err.message })
    }
  }
  return results
}

router.post('/send', async (req, res) => {
  const { contacts, message, phoneNumberId } = req.body
  if (!contacts || !message) return res.status(400).json({ error: 'contacts and message required' })
  const pid = phoneNumberId || process.env.META_PHONE_NUMBER_ID
  const results = await sendBroadcast(contacts, message, pid)
  const sent = results.filter(r => r.status === 'sent').
