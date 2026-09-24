const supabase = require('./supabase')
const { createMetaTemplateClient, MetaTemplateError } = require('./metaTemplates')

// A Meta template is never accepted from the browser as an authority.  This
// small catalog is the single workspace/WABA-scoped source used by both the
// WhatsApp Templates screen and Broadcasts.
async function resolveConnectedNumber(customerId, selectedId = null) {
  let query = supabase
    .from('whatsapp_numbers')
    .select('id, customer_id, phone_number_id, whatsapp_business_account_id, access_token, display_name, status')
    .eq('customer_id', customerId)
    .eq('status', 'connected')
  if (selectedId) query = query.eq('id', selectedId)

  const { data, error } = await query
  if (error) throw error
  if (!data?.length) return { kind: 'none' }
  if (data.length !== 1) return { kind: 'ambiguous' }
  const number = data[0]
  if (!number.phone_number_id || !number.whatsapp_business_account_id) return { kind: 'invalid' }
  return { kind: 'ok', number }
}

async function loadWorkspaceTemplates(customerId, selectedNumberId = null) {
  const resolved = await resolveConnectedNumber(customerId, selectedNumberId)
  if (resolved.kind !== 'ok') return resolved
  const meta = createMetaTemplateClient()
  const templates = await meta.listTemplates({
    wabaId: resolved.number.whatsapp_business_account_id,
    accessToken: resolved.number.access_token
  })
  return { ...resolved, meta, templates }
}

function safeTemplate(template) {
  return {
    id: String(template.id),
    name: template.name,
    status: String(template.status || '').toUpperCase(),
    category: template.category || null,
    language: template.language || null,
    components: Array.isArray(template.components) ? template.components : []
  }
}

module.exports = { resolveConnectedNumber, loadWorkspaceTemplates, safeTemplate, MetaTemplateError }

