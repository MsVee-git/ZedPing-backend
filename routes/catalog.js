const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')

router.get('/', async (req, res) => {
  const { customer_id, search, in_stock } = req.query
  let query = supabase.from('product_catalog').select('*')
  if (customer_id) query = query.eq('customer_id', customer_id)
  if (in_stock === 'true') query = query.eq('in_stock', true)
  if (search) query = query.ilike('product_name', `%${search}%`)
  query = query.order('product_name', { ascending: true })
  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

router.get('/:code', async (req, res) => {
  const { data, error } = await supabase
    .from('product_catalog')
    .select('*')
    .eq('product_code', req.params.code.toUpperCase())
    .single()
  if (error) return res.status(404).json({ error: 'Product not found' })
  res.json(data)
})

router.post('/', async (req, res) => {
  const { product_code, product_name, description, price, sizes, colors, stock_quantity, category, catalog_url, image_url, customer_id } = req.body
  const { data, error } = await supabase
    .from('product_catalog')
    .upsert({
      product_code: product_code.toUpperCase(),
      product_name, description, price, sizes, colors,
      stock_quantity, in_stock: stock_quantity > 0,
      category, catalog_url, image_url, customer_id,
      updated_at: new Date().toISOString()
    }, { onConflict: 'customer_id,product_code' })
    .select()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

router.patch('/:code/stock', async (req, res) => {
  const { stock_quantity, customer_id } = req.body
  const { data, error } = await supabase
    .from('product_catalog')
    .update({
      stock_quantity,
      in_stock: stock_quantity > 0,
      updated_at: new Date().toISOString()
    })
    .eq('product_code', req.params.code.toUpperCase())
    .eq('customer_id', customer_id)
    .select()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

module.exports = router
