function safeInt(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

async function recordAiExecutionEvent(supabase, event) {
  const row = {
    customer_id: event.customerId,
    whatsapp_number_id: event.whatsappNumberId,
    agent_id: event.agentId || null,
    ai_session_id: event.sessionId || null,
    agent_version: safeInt(event.agentVersion),
    model: String(event.model || 'gpt-4o-mini').slice(0, 100),
    outcome: event.outcome,
    error_category: event.errorCategory ? String(event.errorCategory).slice(0, 100) : null,
    duration_ms: safeInt(event.durationMs),
    input_tokens: safeInt(event.inputTokens),
    output_tokens: safeInt(event.outputTokens),
    estimated_cost_usd: Number.isFinite(event.estimatedCostUsd) ? event.estimatedCostUsd : null,
    retrieval_item_ids: Array.isArray(event.retrievalItemIds) ? event.retrievalItemIds : [],
    retrieval_item_count: Array.isArray(event.retrievalItemIds) ? event.retrievalItemIds.length : 0
  }
  const { error } = await supabase.from('ai_execution_events').insert(row)
  if (error) throw error
}

module.exports = { recordAiExecutionEvent }
