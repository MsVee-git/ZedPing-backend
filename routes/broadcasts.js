const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { sendTextMessage } = require('../lib/whatsapp')

// Send broadcast immediately
router.post('/send', async (req, res) => {
  const { contacts, message, phoneNumberId, broadcast_name } = req.body

  if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: 'contacts array is required' })
  }

  if (!message) {
    return res.status(400).json({ error: 'message is required' })
  }

  const results = []
  const pid = phoneNumberId || process.env.META_PHONE_NUMBER_ID

  for (const contact of contacts) {
    try {
      let personalised = message
      personalised = personalised.replace(/{{name}}/gi, contact.name || '')
      personalised = personalised.replace(/{{phone}}/gi, contact.phone_number || '')
      personalised = personalised.replace(/{{tag}}/gi, contact.tag || '')

      if (contact.custom_fields) {
        Object.entries(contact.custom_fields).forEach(([key, value]) => {
          personalised = personalised.replace(new RegExp(`{{${key}}}`, 'gi'), value || '')
        })
      }

      await sendTextMessage(pid, contact.phone_number, personalised)

      await supabase.from('messages').insert({
        direction: 'outbound',
        to_number: contact.phone_number,
        message_body: personalised,
        status: 'sent'
      })

      results.push({ phone: contact.phone_number, status: 'sent' })
      console.log('Broadcast sent to:', contact.phone_number)

      // Rate limiting -- 50ms between each message
      await new Promise(resolve => setTimeout(resolve, 50))

    } catch (error) {
      console.error('Broadcast error for:', contact.phone_number, error.message)
      results.push({ phone: contact.phone_number, status: 'failed', error: error.message })
    }
  }

  const sent = results.filter(r => r.status === 'sent').length
  const failed = results.filter(r => r.status === 'failed').length

  res.json({ success: true, sent, failed, results })
})

// Schedule a broadcast for later
router.post('/schedule', async (req, res) => {
  const { contacts, message, phoneNumberId, scheduled_at, broadcast_name } = req.body

  if (!contacts || !message
