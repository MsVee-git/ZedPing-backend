const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { sendTextMessage } = require('../lib/whatsapp')

// Get all automations
router.get('/', async (req, res) => {
  const { customer_id } = req.query
  let query = supabase.from('automations').select('*').order('created_at', { ascending: false })
  if (customer_id) query = query.eq('customer_id', customer_id)
  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Create automation
router.post('/', async (req, res) => {
  const { trigger_type, trigger_value, message_template, customer_id, chatbot_flow_id } = req.body
  const { data, error } = await supabase
    .from('automations')
    .insert({ trigger_type, trigger_value, message_template, is_active: true, customer_id, chatbot_flow_id })
    .select()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Toggle automation on/off
router.patch('/:id', async (req, res) => {
  const { is_active } = req.body
  const { data, error } = await supabase
    .from('automations')
    .update({ is_active })
    .eq('id', req.params.id)
    .select()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// ── AIRTABLE WEBHOOK TRIGGER ───────────────────────────────────────────────
router.post('/airtable-webhook', async (req, res) => {
  try {
    console.log('Airtable webhook received:', JSON.stringify(req.body))

    const payload = req.body

    // Airtable sends different payload formats
    // Support both direct field access and nested createdRecords/changedRecords
    let records = []

    if (payload.createdRecords) {
      records = payload.createdRecords
    } else if (payload.changedRecords) {
      records = payload.changedRecords
    } else if (payload.fields) {
      records = [payload]
    } else if (Array.isArray(payload)) {
      records = payload
    }

    if (records.length === 0) {
      console.log('No records found in Airtable webhook payload')
      return res.sendStatus(200)
    }

    for (const record of records) {
      const fields = record.fields || record

      // Extract phone number -- try common field names
      const phone = fields['Phone'] ||
        fields['phone'] ||
        fields['Phone Number'] ||
        fields['Mobile'] ||
        fields['WhatsApp'] ||
        fields['Contact'] ||
        null

      if (!phone) {
        console.log('No phone number found in record:', JSON.stringify(fields))
        continue
      }

      // Extract name -- try common field names
      const name = fields['Name'] ||
        fields['name'] ||
        fields['Customer Name'] ||
        fields['Client Name'] ||
        fields['Full Name'] ||
        'Customer'

      // Find matching automation for this webhook trigger
      const { data: automations } = await supabase
        .from('automations')
        .select('*')
        .eq('trigger_type', 'webhook')
        .eq('is_active', true)

      if (!automations || automations.length === 0) {
        console.log('No active webhook automations found')
        continue
      }

      for (const automation of automations) {
        // Personalise the message template
        let message = automation.message_template
        message = message.replace(/{{name}}/gi, name)
        message = message.replace(/{{phone}}/gi, phone)

        // Replace any other field variables
        Object.entries(fields).forEach(([key, value]) => {
          message = message.replace(new RegExp(`{{${key}}}`, 'gi'), value || '')
        })

        // Get the phone number ID from whatsapp_numbers table
        const { data: numbers } = await supabase
          .from('whatsapp_numbers')
          .select('phone_number_id, access_token')
          .eq('status', 'connected')
          .limit(1)

        if (!numbers || numbers.length === 0) {
          console.log('No connected WhatsApp numbers found')
          continue
        }

        const phoneNumberId = numbers[0].phone_number_id ||
          process.env.META_PHONE_NUMBER_ID

        // Send the WhatsApp message
        await sendTextMessage(phoneNumberId, phone, message)

        // Log it
        await supabase.from('messages').insert({
          direction: 'outbound',
          to_number: phone,
          message_body: message,
          status: 'sent'
        })

        console.log('Airtable webhook message sent to:', phone)
      }
    }

    res.sendStatus(200)
  } catch (err) {
    console.error('Airtable webhook error:', err)
    res.sendStatus(200)
  }
})

module.exports = router
