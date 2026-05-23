const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')

router.get('/', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  const expected = (process.env.VERIFY_TOKEN || 'zedping123').trim()
  const received = (token || '').trim()

  console.log('mode:', mode)
  console.log('received:', JSON.stringify(received))
  console.log('expected:', JSON.stringify(expected))
  console.log('match:', received === expected)

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
            const { error } = await supabase.from('messages').insert({
              direction: 'inbound',
              from_number: message.from,
              to_number: value.metadata.display_phone_number,
              message_body: message.text?.body || '',
              status: 'received'
            })
            if (error) console.error('Supabase error:', error)
            else console.log('Message saved:', message.from)
          }
        }
      }
    }
  }
  res.sendStatus(200)
})

module.exports = router
