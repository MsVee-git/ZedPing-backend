const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'aiAgents.js'), 'utf8')
const webhookSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhook.js'), 'utf8')

function routeBody(pathname) {
  const start = routeSource.indexOf(`router.post('${pathname}'`)
  assert.notEqual(start, -1, `missing ${pathname} route`)
  const end = routeSource.indexOf('\nrouter.', start + 1)
  return routeSource.slice(start, end === -1 ? undefined : end)
}

test('Go Live promotes only an active Test agent using its activated immutable version', () => {
  const body = routeBody('/:id/go-live')
  assert.match(body, /requireAdmin/)
  assert.match(body, /mayGoLive\(agent\)/)
  assert.match(body, /deploymentMode\(agent\) === 'live'/)
  assert.match(body, /ai_agent_configuration_versions/)
  assert.match(body, /knowledge_snapshot/)
  assert.match(body, /activatedVersionReadiness\(req\.workspace\.customerId, agent, version\)/)
  assert.doesNotMatch(body, /liveReadiness\(/)
  assert.match(body, /update\(\{ deployment_mode:'live' \}\)/)
  assert.match(body, /eq\('deployment_mode','test'\)/)
  assert.doesNotMatch(body, /\.insert\(/)
  assert.doesNotMatch(body, /ai_agent_sessions/)
})

test('Resume and Go Live validate immutable snapshots rather than mutable draft associations', () => {
  const resume = routeBody('/:id/resume')
  const goLive = routeBody('/:id/go-live')
  for (const body of [resume, goLive]) {
    assert.match(body, /ai_agent_configuration_versions/)
    assert.match(body, /knowledge_snapshot/)
    assert.match(body, /activatedVersionReadiness/)
    assert.doesNotMatch(body, /knowledgeForAgent\(/)
    assert.doesNotMatch(body, /replaceKnowledge\(/)
  }
  assert.match(routeSource, /function assertActivatedSnapshot/)
  assert.match(routeSource, /!knowledge\.length/)
  assert.match(routeSource, /config\.configuration\?\.handoff/)
})

test('Test and Live routing use server-side deployment mode and preserve human-control precedence', () => {
  assert.match(webhookSource, /mayExecute\(agent, await isApprovedTestContact\(ctx, agent\.id\)\)/)
  assert.ok(webhookSource.indexOf('shouldSuppressAutomation(conversation)') < webhookSource.indexOf('checkAISession(ctx)'))
})

test('returning an agent to Test Mode terminalizes live sessions before later inbound routing', () => {
  const body = routeBody('/:id/test-mode')
  assert.match(body, /requireAdmin/)
  assert.match(body, /update\(\{ deployment_mode:'test' \}\)/)
  assert.match(body, /ai_agent_sessions/)
  assert.match(body, /status:'cancelled'/)
  assert.match(body, /completion_reason:'agent_returned_to_test_mode'/)
})

test('Pause and Resume preserve deployment mode without starting sessions or sending messages', () => {
  const pause = routeBody('/:id/pause')
  const resume = routeBody('/:id/resume')
  assert.match(pause, /update\(\{lifecycle_status:'paused',is_active:false\}\)/)
  assert.doesNotMatch(pause, /deployment_mode/)
  assert.match(resume, /status:deploymentMode\(data\)/)
  assert.doesNotMatch(resume, /\.insert\(/)
  assert.doesNotMatch(resume, /sendWhatsApp/)
})

test('all lifecycle mutations remain owner/admin-only and workspace-scoped', () => {
  for (const name of ['/:id/go-live', '/:id/test-mode', '/:id/pause', '/:id/resume']) {
    const body = routeBody(name)
    assert.match(body, /requireAdmin/)
    assert.match(body, /req\.workspace\.customerId/)
  }
})
