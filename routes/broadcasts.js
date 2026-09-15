const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { sendTextMessage } = require('../lib/whatsapp')
const { transientRecipient, dedupeRecipients } = require('../lib/broadcastRecipients')

async function numberFor(workspace, id) {
  let query = supabase.from('whatsapp_numbers').select('*').eq('customer_id', workspace).eq('status', 'connected')
  if (id) query = query.eq('id', id)
  const { data, error } = await query
  if (error || !data || data.length !== 1) return null
  return data[0]
}

async function sendBroadcast(workspace, number, contacts, message) {
  const results = []
  for (const contact of contacts) {
    try {
      const body = message.replace(/{{name}}/gi, contact.name || '').replace(/{{phone}}/gi, contact.phone_number || '')
      await sendTextMessage(number.phone_number_id, contact.phone_number, body, number.access_token)
      await supabase.from('messages').insert({
        customer_id: workspace,
        whatsapp_number_id: number.id,
        direction: 'outbound',
        to_number: contact.phone_number,
        message_body: body,
        status: 'sent',
        contact_id: contact.id || null
      })
      results.push({ phone: contact.phone_number, status: 'sent' })
    } catch (error) {
      results.push({ phone: contact.phone_number, status: 'failed', error: error.message })
    }
  }
  return results
}

async function recipientsForWorkspace(workspace, requested) {
  if (!Array.isArray(requested) || !requested.length) {
    return { error: 'At least one recipient is required' }
  }

  const requestedIds = [...new Set(requested.map((contact) => contact?.id).filter(Boolean))]
  const { data: saved = [], error } = requestedIds.length
    ? await supabase.from('contacts').select('id,name,phone_number,custom_fields').eq('customer_id', workspace).in('id', requestedIds)
    : { data: [], error: null }
  if (error) throw error
  if (saved.length !== requestedIds.length) {
    return { error: 'One or more contacts do not belong to this workspace', status: 403 }
  }

  const transient = []
  for (const contact of requested.filter((item) => !item?.id)) {
    const normalized = transientRecipient(contact)
    if (!normalized) return { error: 'One or more phone numbers are invalid' }
    transient.push(normalized)
  }
  return { recipients: dedupeRecipients([...saved, ...transient]) }
}

router.post('/send', async (req, res) => {
  const { contacts, message, phoneNumberId } = req.body
  if (!Array.isArray(contacts) || !String(message || '').trim()) {
    return res.status(400).json({ error: 'contacts and message required' })
  }

  try {
    const number = await numberFor(req.workspace.customerId, phoneNumberId)
    if (!number) return res.status(404).json({ error: 'Connected WhatsApp number not found' })

    const resolved = await recipientsForWorkspace(req.workspace.customerId, contacts)
    if (resolved.error) return res.status(resolved.status || 400).json({ error: resolved.error })
    const results = await sendBroadcast(req.workspace.customerId, number, resolved.recipients, String(message).trim())
    return res.json({
      success: true,
      sent: results.filter((item) => item.status === 'sent').length,
      failed: results.filter((item) => item.status === 'failed').length,
      results
    })
  } catch {
    return res.status(502).json({ error: 'Broadcast could not be sent' })
  }
})

router.post('/schedule', async (req, res) => {
  const { contacts, message, phoneNumberId, scheduled_at, broadcast_name } = req.body
  if (!Array.isArray(contacts) || !message || !scheduled_at) return res.status(400).json({ error: 'contacts, message and scheduled_at required' })
  const number = await numberFor(req.workspace.customerId, phoneNumberId)
  if (!number) return res.status(404).json({ error: 'Connected WhatsApp number not found' })
  const { data, error } = await supabase.from('scheduled_broadcasts').insert({
    customer_id: req.workspace.customerId,
    broadcast_name: broadcast_name || 'Untitled Broadcast',
    contacts,
    message,
    phone_number_id: number.phone_number_id,
    scheduled_at,
    status: 'pending'
  }).select()
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true, broadcast: data[0] })
})

router.get('/scheduled', async (req, res) => {
  const { data, error } = await supabase.from('scheduled_broadcasts').select('*').eq('customer_id', req.workspace.customerId).order('scheduled_at')
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

router.post('/process', async (req, res) => {
  const { data: due, error } = await supabase.from('scheduled_broadcasts').select('*').eq('customer_id', req.workspace.customerId).eq('status', 'pending').lte('scheduled_at', new Date().toISOString())
  if (error) return res.status(500).json({ error: error.message })
  for (const broadcast of due || []) {
    const { data: number } = await supabase.from('whatsapp_numbers').select('*').eq('customer_id', req.workspace.customerId).eq('phone_number_id', broadcast.phone_number_id).eq('status', 'connected').maybeSingle()
    if (!number) continue
    const results = await sendBroadcast(req.workspace.customerId, number, broadcast.contacts, broadcast.message)
    await supabase.from('scheduled_broadcasts').update({
      status: 'completed',
      sent_count: results.filter((item) => item.status === 'sent').length,
      failed_count: results.filter((item) => item.status === 'failed').length,
      completed_at: new Date().toISOString()
    }).eq('id', broadcast.id).eq('customer_id', req.workspace.customerId)
  }
  res.json({ success: true, processed: (due || []).length })
})

module.exports = router
