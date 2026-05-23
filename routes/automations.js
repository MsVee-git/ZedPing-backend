const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')

router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('automations')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

router.post('/', async (req, res) => {
  const { trigger_type, trigger_value, message_template } = req.body

  const { data, error } = await supabase
    .from('automations')
    .insert({ trigger_type, trigger_value, message_template, is_active: true })
    .select()

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

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

module.exports = router
