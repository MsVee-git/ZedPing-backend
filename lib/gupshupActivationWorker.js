const { gupshupConfigForCustomer } = require('./gupshupConfig')
const { createGupshupPartnerClient } = require('./gupshupPartner')
const { reconcileWhatsAppConnection } = require('./whatsappConnectionReconciliation')

// Reconcile existing linked apps only. Never create an app or register a phone
// here. Activation must survive closing the signup browser window.
async function reconcilePendingGupshupConnections({ db, env = process.env,
  configForCustomer = gupshupConfigForCustomer, createPartner = createGupshupPartnerClient,
  reconcile = reconcileWhatsAppConnection, diagnostic = record => console.info(JSON.stringify(record)) }) {
  if (env.GUPSHUP_WORKER_ENABLED !== 'true' || env.GUPSHUP_ROUTING_ENABLED !== 'true') return
  const { data, error } = await db.from('gupshup_connection_mappings')
    .select('*,whatsapp_numbers!inner(*)').eq('link_state','linked')
    .eq('whatsapp_numbers.status','provisioning').not('app_id','is',null)
    .order('updated_at',{ascending:true}).limit(5)
  if (error) throw new Error('Unable to load pending activations')
  for (const row of data || []) {
    const { whatsapp_numbers: connection, ...mapping } = row
    if (!connection || connection.customer_id !== mapping.customer_id || connection.id !== mapping.whatsapp_number_id) continue
    try {
      const config = configForCustomer(mapping.customer_id,env)
      if (!config) continue
      const result = await reconcile({db,customerId:mapping.customer_id,connection,mapping,
        partner:createPartner(config),callbackUrl:config.callbackUrl,webhookSecret:env.GUPSHUP_WEBHOOK_SECRET,
        routingReady:Boolean(configForCustomer(mapping.customer_id,env,'messaging') && env.GUPSHUP_WEBHOOK_ENABLED==='true' && env.GUPSHUP_WEBHOOK_SECRET?.length>=32)})
      diagnostic({event:'gupshup_activation_check',connection_id:connection.id,phase:result.phase})
    } catch (error) {
      diagnostic({event:'gupshup_activation_check',connection_id:connection.id,phase:'pending',
        stage:typeof error.stage==='string'?error.stage:'reconciliation',http_status:Number.isInteger(error.status)?error.status:null})
    }
  }
}

module.exports = { reconcilePendingGupshupConnections }
