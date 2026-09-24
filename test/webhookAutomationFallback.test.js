const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhook.js'), 'utf8')

test('non-AI inbound messages retain deterministic automation fallback', () => {
  assert.match(source, /async function checkAutomations\(ctx\)/)
  assert.match(source, /const explicit = selectExplicitAutomation/)
  assert.match(source, /const away = selectAwayAutomation/)
  assert.match(source, /const welcome = selectWelcomeAutomation/)
  assert.match(source, /const fallback = selectDefaultAutomation/)
  assert.ok(source.indexOf('shouldSuppressAutomation(conversation)') < source.indexOf('checkAISession(ctx)'))
  assert.ok(source.indexOf('if (await continueFlow(ctx, outgoing)) return') < source.indexOf('await checkAutomations(ctx)'))
})

test('runtime loads the latest activated immutable version after a paused draft edit', () => {
  const start = source.indexOf('async function loadLiveVersion(ctx, agent)')
  const end = source.indexOf('\nasync function startLiveZoeSession', start)
  const body = source.slice(start, end)
  assert.match(body, /not\('activated_at', 'is', null\)/)
  assert.match(body, /order\('version', \{ ascending: false \}\)/)
  assert.doesNotMatch(body, /eq\('version', agent\.configuration_version\)/)
  assert.match(source, /agent_version: version\.version/)
})

