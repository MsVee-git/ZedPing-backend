const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { sendTemplateMessage } = require('../lib/whatsapp')

router.post('/send', async (req, res) => {
  const { contacts, templateName, variables, phoneNumberId } = req.body

  const results = []

  for (const contact of contacts) {
    try {
      const personalised = variables.map(v =>
        v.replace(/{{name}}/g, contact.name)
         .replace(/{{phone}}/g, contact.phone_number)
      )

      await sendTemplateMessage(phoneNumberId, contact.phone_number, templateName, personalised)

      await supabase.from('messages').insert({
        direction: 'outbound',
        to_number: contact.phone_number,
        message_body: templateName,
        status: 'sent'
      })

      results.push({ contact: contact.phone_number, status: 'sent' })

      await new Promise(resolve => setTimeout(resolve, 50))

    } catch (error) {
      results.push({ contact: contact.phone_number, status: 'failed', error: error.message })
    }
  }

  res.json({ success: true, results })
})

module.exports = router
