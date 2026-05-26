const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')

// Get all contacts
router.get('/', async (req, res) => {
  const { customer_id } = req.query

  let query = supabase.from('contacts').select('*').order('created_at', { ascending: false })
  if (customer_id) query = query.eq('customer_id', customer_id)

  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Add single contact
router.post('/', async (req, res) => {
  const { name, phone_number, tag, custom_fields, customer_id } = req.body

  const { data, error } = await supabase
    .from('contacts')
    .insert({ name, phone_number, tag, custom_fields, customer_id })
    .select()

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Upload contacts from CSV data
router.post('/upload', async (req, res) => {
  const { contacts, customer_id } = req.body

  if (!contacts || !Array.isArray(contacts)) {
    return res.status(400).json({ error: 'contacts must be an array' })
  }

  const formatted = contacts.map(c => ({
    customer_id: customer_id || null,
    name: c.name || c.Name || '',
    phone_number: c.phone_number || c.Phone || c.phone || '',
    tag: c.tag || c.Tag || null,
    custom_fields: {
      ...Object.fromEntries(
        Object.entries(c).filter(([k]) =>
          !['name', 'Name', 'phone_number', 'Phone', 'phone', 'tag', 'Tag'].includes(k)
        )
      )
    }
  }))

  // Preview mode -- return first 5 personalised examples
  if (req.query.preview === 'true') {
    return res.json({ preview: formatted.slice(0, 5), total: formatted.length })
  }

  // Validate -- flag missing names or invalid phone numbers
  const errors = []
  formatted.forEach((c, i) => {
    if (!c.name) errors.push(`Row ${i + 1}: missing name`)
    if (!c.phone_number) errors.push(`Row ${i + 1}: missing phone number`)
    else if (!/^\+?[0-9]{9,15}$/.test(c.phone_number.replace(/\s/g, ''))) {
      errors.push(`Row ${i + 1}: invalid phone number format -- ${c.phone_number}`)
    }
  })

  if (errors.length > 0) {
    return res.status(400).json({ errors })
  }

  const { data, error } = await supabase
    .from('contacts')
    .upsert(formatted, { onConflict: 'phone_number' })
    .select()

  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true, imported: data.length, contacts: data })
})

// Delete contact
router.delete('/:id', async (req, res) => {
  const { error } = await supabase
    .from('contacts')
    .delete()
    .eq('id', req.params.id)

  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

// Personalise a template with
