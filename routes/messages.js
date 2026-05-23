const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { sendTextMessage } = require('../lib/whatsapp')

router.post('/send', async (req, res) => {
  const { to, message, phoneNumberId } = req.body

  try {
    const result = await sendTextMessage(phoneNumberId, to, message)

    await supabase.from('messages').insert({
      direction: 'outbound',
      to_number: to,
      message_body: message,
      status: 'sent'
    })

    res.json({ success: true, result })
  } catch (error) {
    console.error('Send error:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

module.exports = router
