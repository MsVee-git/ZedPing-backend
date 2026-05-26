const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { sendTextMessage } = require('../lib/whatsapp')

router.get('/', async (req, res) => {
  const { customer_id, status } = req.query
  let query = supabase.from('orders').select('*').order('created_at', { ascending: false })
  if (customer_id) query = query.eq('customer_id', customer_id)
  if (status) query = query.eq('status', status)
  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

router.post('/', async (req, res) => {
  const { contact_phone, contact_name, product_code, product_name, size, quantity, price, payment_method, agent_id, customer_id, notes } = req.body
  const { data, error } = await supabase
    .from('orders')
    .insert({ contact_phone, contact_name, product_code, product_name, size, quantity, price, payment_method, agent_id, customer_id, notes, status: 'pending' })
    .select()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

router.patch('/:id/payment', async (req, res) => {
  const { payment_reference, phoneNumberId, notify_phone } = req.body
  const { data, error } = await supabase
    .from('orders')
    .update({ payment_confirmed: true, payment_reference, status: 'payment_received', updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
  if (error) return res.status(500).json({ error: error.message })

  if (notify_phone && phoneNumberId) {
    const order = data[0]
    const msg = `New order received! 🛍️\n\nCustomer: ${order.contact_name || order.contact_phone}\nProduct: ${order.product_name}\nSize: ${order.size || 'N/A'}\nQty: ${order.quantity}\nPayment Ref: ${payment_reference}\n\nPlease arrange delivery.`
    await sendTextMessage(phoneNumberId, notify_phone, msg)
  }

  res.json(data)
})

router.patch('/:id/status', async (req, res) => {
  const { status } = req.body
  const { data, error } = await supabase
    .from('orders')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

module.exports = router
