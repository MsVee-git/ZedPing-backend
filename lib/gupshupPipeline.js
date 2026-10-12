const { processGupshupInboxBatch } = require('./gupshupInboxWorker')
const { processGupshupAutomationBatch } = require('./gupshupAutomationWorker')
async function processGupshupPipeline({ db, runAutomation, enabled = false }) {
 if (!enabled) return { disabled:true }
 const inbox = await processGupshupInboxBatch(db)
 const delivery = await processGupshupInboxBatch(db,20,'status')
 const automation = await processGupshupAutomationBatch({db,runAutomation})
 return {inbox,delivery,automation}
}
// Explicit execution entry point. No scheduler is enabled before live acceptance.
async function runConfiguredGupshupPipeline() {
 return processGupshupPipeline({ db:require('./supabase'), runAutomation:require('../routes/webhook').runInboundAutomation,
  enabled:process.env.GUPSHUP_WORKER_ENABLED==='true' && process.env.GUPSHUP_ROUTING_ENABLED==='true' })
}
module.exports={processGupshupPipeline,runConfiguredGupshupPipeline}
