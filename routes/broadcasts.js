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
  const sent = results.filter(r => r.status === 'sent').length
  const failed = results.filter(r => r.status === 'failed').length
  res.json({ success: true, sent, failed, results })
})

router.post('/schedule', async (req, res) => {
  const { contacts, message, phoneNumberId, scheduled_at, broadcast_name } = req.body
  if (!contacts || !message || !scheduled_at) {
    return res.status(400).json({ error: 'contacts, message and scheduled_at required' })
  }
  const { data, error } = await supabase
    .from('scheduled_broadcasts')
    .insert({
      broadcast_name: broadcast_name || 'Untitled Broadcast',
      contacts,
      message,
      phone_number_id: phoneNumberId || process.env.META_PHONE_NUMBER_ID,
      scheduled_at,
      status: 'pending'
    })
    .select()
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true, broadcast: data[0] })
})

router.get('/scheduled', async (req, res) => {
  const { data, error } = await supabase
    .from('scheduled_broadcasts')
    .select('*')
    .order('scheduled_at', { ascending: true })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

router.post('/process', async (req, res) => {
  const now = new Date().toISOString()
  const { data: due, error } = await supabase
    .from('scheduled_broadcasts')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_at', now)
  if (error) return res.status(500).json({ error: error.message })
  if (!due || due.length === 0) return res.json({ processed: 0 })
  for (const broadcast of due) {
    await supabase.from('scheduled_broadcasts').update({ status: 'sending' }).eq('id', broadcast.id)
    const results = await sendBroadcast(broadcast.contacts, broadcast.message, broadcast.phone_number_id)
    const sent = results.filter(r => r.status === 'sent').length
    const failed = results.filter(r => r.status === 'failed').length
    await supabase.from('scheduled_broadcasts').update({
      status: 'completed', sent_count: sent, failed_count: failed,
      completed_at: new Date().toISOString()
    }).eq('id', broadcast.id)
  }
  res.json({ success: true, processed: due.length })
})

module.exports = router
