const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('workspace integrity migration uses table-specific trigger functions', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'migrations', '20260920100000_split_workspace_integrity_triggers.sql'),
    'utf8'
  )

  for (const table of [
    'automations',
    'chatbot_flows',
    'chatbot_steps',
    'chatbot_step_routes',
    'chatbot_sessions',
    'ai_agents',
    'ai_agent_sessions',
    'conversations',
    'messages',
    'inbound_webhook_events'
  ]) {
    assert.match(migration, new RegExp('drop trigger if exists ' + table + '_workspace_integrity on public\\.' + table + ';', 'i'))
  }

  assert.match(migration, /execute function public\.enforce_automation_workspace_integrity\(\)/i)
  assert.match(migration, /execute function public\.enforce_chatbot_flow_workspace_integrity\(\)/i)
  assert.match(migration, /execute function public\.enforce_chatbot_session_workspace_integrity\(\)/i)
  assert.match(migration, /execute function public\.enforce_ai_agent_workspace_integrity\(\)/i)
  assert.match(migration, /execute function public\.enforce_ai_agent_session_workspace_integrity\(\)/i)
  assert.match(migration, /execute function public\.enforce_conversation_workspace_integrity\(\)/i)
  assert.match(migration, /execute function public\.enforce_message_workspace_integrity\(\)/i)
  assert.match(migration, /execute function public\.enforce_inbound_webhook_event_workspace_integrity\(\)/i)
  assert.doesNotMatch(migration, /execute function public\.enforce_d2_workspace_integrity\(\)/i)
})
