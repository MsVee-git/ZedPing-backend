const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { sendTextMessage } = require('../lib/whatsapp')

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'zedping123'

router.get('/', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  const expected = (VERIFY_TOKEN).trim()
  const received = (token || '').trim()

  if (mode === 'subscribe' && received === expected) {
    res.status(200).send(challenge)
  } else {
    res.sendStatus(403)
  }
})

router.post('/', async (req, res) => {
  const body = req.body

  if (body.object === 'whatsapp_business_account') {
    for (const entry of body.entry) {
      for (const change of entry.changes) {
        const value = change.value

        if (value.messages) {
          for (const message of value.messages) {
            const fromNumber = message.from
            const messageBody = message.text?.body || ''
            const toNumber = value.metadata.display_phone_number
            const phoneNumberId = value.metadata.phone_number_id

            await supabase.from('messages').insert({
              direction: 'inbound',
              from_number: fromNumber,
              to_number: toNumber,
              message_body: messageBody,
              status: 'received'
            })

            console.log('Message received from:', fromNumber, ':', messageBody)

            await checkAutomations(fromNumber, messageBody, phoneNumberId)
          }
        }
      }
    }
  }

  res.sendStatus(200)
})

async function checkAutomations(fromNumber, messageBody, phoneNumberId) {
  try {
    const keyword = messageBody.trim().toUpperCase()

    const { data: automations, error } = await supabase
      .from('automations')
      .select('*')
      .eq('trigger_type', 'keyword')
      .eq('is_active', true)

    if (error || !automations || automations.length === 0) return

    for (const automation of automations) {
      const triggerValue = (automation.trigger_value || '').toUpperCase()

      if (keyword === triggerValue) {
        console.log('Automation matched:', automation.trigger_value)

        await sendTextMessage(phoneNumberId, fromNumber, automation.message_template)

        await supabase.from('messages').insert({
          direction: 'outbound',
          to_number: fromNumber,
          message_body: automation.message_template,
          status: 'sent'
        })

        console.log('Auto-reply sent to:', fromNumber)
        break
      }
    }
  } catch (err) {
    console.error('Automation error:', err)
  }
}

module.exports = router
