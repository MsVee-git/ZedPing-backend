const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'aiAgents.js'), 'utf8')
const migrationSource = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260930093000_atomic_ai_agent_activation.sql'), 'utf8')

function routeBody(pathname) {
  const marker = `router.post('${pathname}'`
  const start = routeSource.indexOf(marker)
  assert.notEqual(start, -1, `route ${pathname} exists`)
  const next = routeSource.indexOf('\nrouter.', start + marker.length)
  return routeSource.slice(start, next === -1 ? routeSource.length : next)
}

test('Update Live is owner/admin-only and only permits an active agent', () => {
  const body = routeBody('/:id/update-live')
  assert.match(body, /requireAdmin/)
  assert.match(body, /agentForWorkspace\(req\.workspace\.customerId, req\.params\.id\)/)
  assert.match(body, /if \(!isActiveAgent\(agent\)\)/)
  assert.match(body, /allowActiveUpdate:true/)
})

test('activation finalizes a server-built immutable version atomically before reporting success', () => {
  const helperStart = routeSource.indexOf('async function activateCurrentConfiguration')
  const helperEnd = routeSource.indexOf('\nrouter.get(\'/:id/test-contacts\'', helperStart)
  const helper = routeSource.slice(helperStart, helperEnd)
  assert.match(helper, /activationReadiness\(customerId, agent, \{ allowActiveUpdate \}\)/)
  assert.match(helper, /knowledgeSnapshot\(knowledge\)/)
  assert.match(helper, /supabase\.rpc\('activate_ai_agent_version'/)
  assert.match(helper, /p_customer_id:customerId/)
  assert.match(helper, /p_agent_id:agent\.id/)
  assert.match(helper, /p_configuration:activatedConfiguration\(agent\)/)
  assert.match(helper, /p_knowledge_snapshot:snapshot/)
  assert.match(helper, /!activated\.activated_at/)
  assert.match(helper, /configuration_version',Number\(activated\.version\)/)
  assert.match(helper, /AI Agent activation did not finalize/)
  assert.doesNotMatch(helper, /\.insert\(\{[\s\S]*ai_agent_configuration_versions/)
})

test('an active update keeps its current deployment mode and is idempotent when nothing changed', () => {
  const helperStart = routeSource.indexOf('async function activateCurrentConfiguration')
  const helperEnd = routeSource.indexOf('\nrouter.get(\'/:id/test-contacts\'', helperStart)
  const helper = routeSource.slice(helperStart, helperEnd)
  assert.match(helper, /changesNotLiveYet\(agent, knowledge, existingActivated\)/)
  assert.match(helper, /alreadyCurrent:true/)
  assert.match(helper, /const targetMode = allowActiveUpdate && isActiveAgent\(agent\) \? deploymentMode\(agent\) : 'test'/)
  assert.match(helper, /allowActiveUpdate && error\.code === '40001'/)
  assert.match(helper, /const refreshed = await agentForWorkspace\(customerId, agent\.id\)/)
  assert.match(helper, /!changesNotLiveYet\(refreshed, refreshedKnowledge, refreshedVersion\)/)
})

test('the database promotion locks the scoped agent and commits version plus lifecycle together', () => {
  assert.match(migrationSource, /create or replace function public\.activate_ai_agent_version/)
  assert.match(migrationSource, /where id = p_agent_id\s+and customer_id = p_customer_id[\s\S]*?for update;/)
  assert.match(migrationSource, /insert into public\.ai_agent_configuration_versions/)
  assert.match(migrationSource, /knowledge_snapshot,\s+activated_at/)
  assert.match(migrationSource, /update public\.ai_agents\s+set lifecycle_status = 'active'/)
  assert.match(migrationSource, /configuration_version = next_version/)
  assert.doesNotMatch(migrationSource, /delete from public\.ai_agent_configuration_versions/i)
  assert.doesNotMatch(migrationSource, /update public\.ai_agent_configuration_versions/i)
  assert.match(migrationSource, /revoke all on function[\s\S]*from public, anon, authenticated/)
  assert.match(migrationSource, /grant execute on function[\s\S]*to service_role/)
})

test('activation responses expose a finalized version and timestamp rather than optimistic success', () => {
  const activate = routeBody('/:id/activate')
  const updateLive = routeBody('/:id/update-live')
  for (const body of [activate, updateLive]) {
    assert.match(body, /activation:\{version:result\.version,activated_at:result\.activatedAt/)
    assert.match(body, /activated_configuration_version:result\.version/)
    assert.match(body, /changes_not_live_yet:false/)
  }
})
