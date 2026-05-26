const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')

router.get('/', async (req, res) => {
  const { customer_id } = req.query
  let query = supabase.from('contacts').select('*').order('created_at', { ascending: false })
  if (customer_id) query = query.eq('customer_id', customer_id)
  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

router.post('/', async (req, res) => {
  const { name, phone_number, tag, custom_fields, customer_id } = req.body
  const { data, error } = await supabase
    .from('contacts')
    .insert({ name, phone_number, tag, custom_fields, customer_id })
    .select()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

router.post('/upload', async (req, res) => {
  const { contacts, customer_id } = req.body
  if (!contacts || !Array.isArray(contacts)) {
    return res.status(400).json({ error: 'contacts must be an array' })
  }
  const formatted = contacts.map(c => ({
    customer
