const express = require('express')
const db = require('../lib/supabase')
const { loadLifetimeReport } = require('../lib/lifetimeReport')
const router = express.Router()
router.get('/lifetime', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  try {
    const report = await loadLifetimeReport(db, req.workspace.customerId, { start: req.query.start, end: req.query.end })
    res.json(report)
  } catch (error) {
    console.error('Lifetime report failed', { workspaceId: req.workspace.customerId, message: error.message })
    if (error.status === 400) return res.status(400).json({ error: error.message })
    res.status(503).json({ error: 'The complete lifetime report could not be generated. Please try again. No partial totals were returned.' })
  }
})
module.exports = router
