const test = require('node:test')
const assert = require('node:assert/strict')
const { createGupshupPartnerClient } = require('../lib/gupshupPartner')
const ok = data => ({ ok: true, status: 200, json: async () => data })

test('concurrent login is shared and cached token renews before 24 hours', async () => {
  let clock = 0, calls = 0
  const client = createGupshupPartnerClient({ email: 'partner@example.com', secret: 'private', now: () => clock,
    fetchImpl: async (url, options) => {
      calls++
      assert.equal(url, 'https://partner.gupshup.io/partner/account/login')
      assert.equal(new URLSearchParams(options.body).get('secret'), 'private')
      return ok({ token: `token${calls}` })
    } })
  assert.deepEqual(await Promise.all([client.getPartnerToken(), client.getPartnerToken()]), ['token1', 'token1'])
  assert.equal(calls, 1)
  clock = 24 * 60 * 60 * 1000
  assert.equal(await client.getPartnerToken(), 'token2')
})

test('status uses app token and does not treat HTTP success as provisioned', async () => {
  const calls = []
  const client = createGupshupPartnerClient({ email: 'e', secret: 's', fetchImpl: async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith('/login')) return ok({ token: 'partner-token' })
    if (url.endsWith('/token')) return ok({ token: 'app-token' })
    return ok({ status: 'success', whatsapp: { creationStage: 'ERROR' } })
  } })
  assert.equal((await client.getAppStatus('app-123')).provisioned, false)
  assert.equal(calls[1].options.headers.Authorization, 'partner-token')
  assert.equal(calls[2].options.headers.Authorization, 'app-token')
  assert.ok(calls.every(call => call.options.method === 'GET' || call.url.endsWith('/login')))
})

test('failures do not expose response bodies or underlying secret-bearing errors', async () => {
  const client = createGupshupPartnerClient({ email: 'e', secret: 's', fetchImpl: async () => { throw new Error('SECRET_TOKEN') } })
  await assert.rejects(client.getPartnerToken(), error => error.message === 'Gupshup authentication failed' && !error.cause)
})

test('invalid app IDs and missing configuration fail before HTTP calls', async () => {
  const client = createGupshupPartnerClient({ fetchImpl: async () => { throw new Error('must not call') } })
  await assert.rejects(client.getAppStatus('../other'), /app_id_validation/)
  await assert.rejects(client.getPartnerToken(), /configuration/)
})

test('app linking sends Bearer partner token and wallet mapping once', async () => {
  const calls = []
  const client = createGupshupPartnerClient({ email: 'e', secret: 's', fetchImpl: async (url, options) => {
    calls.push({ url, options })
    return ok(url.endsWith('/login') ? { token: 'partner' } : { status: 'success', appId: 'app-123' })
  } })
  assert.deepEqual(await client.linkApp({ name: 'ZedPing123', wabaId: '123456', phone: '260977123456', walletId: 'wallet-1' }), { appId: 'app-123' })
  assert.equal(calls[1].options.headers.Authorization, 'Bearer partner')
  assert.equal(new URLSearchParams(calls[1].options.body).get('walletId'), 'wallet-1')
  assert.equal(calls[1].url, 'https://partner.gupshup.io/partner/tpp/app')
})

test('unsafe callback and noninternational phone fail before authentication', async () => {
  const client = createGupshupPartnerClient({ fetchImpl: async () => { throw Error('no HTTP') } })
  const input = { name: 'ZedPing123', wabaId: '123456', phone: '260977123456', walletId: 'wallet-1' }
  await assert.rejects(client.linkApp({ ...input, callbackUrl: 'http://example.com' }), /callback_validation/)
  await assert.rejects(client.linkApp({ ...input, phone: '+260977123456' }), /link_validation/)
})

test('subscription configures a secret header and validates provider confirmation', async () => {
 const calls = []
 const client = createGupshupPartnerClient({ email: 'e', secret: 's', fetchImpl: async (url, options) => {
  calls.push({url, options})
  if (url.endsWith('/subscription')) return ok({ status: 'success', subscription: { appId: 'app1', active: true, id: 'sub1' } })
  return ok({ token: 'token' })
 } })
 assert.deepEqual(await client.subscribeApp('app1', { callbackUrl: 'https://example.com/hook', webhookSecret: 'x'.repeat(48) }), { subscriptionId: 'sub1' })
 const form = new URLSearchParams(calls.at(-1).options.body)
 assert.equal(JSON.parse(form.get('meta'))['X-Gupshup-Webhook-Secret'], 'x'.repeat(48))
 assert.equal(form.get('version'), '3')
})

test('text sends preserve reply context and return accepted, not delivered', async () => {
 let sent
 const client = createGupshupPartnerClient({ email: 'e', secret: 's', fetchImpl: async (url, options) => {
  if (url.endsWith('/v3/message')) { sent = JSON.parse(options.body); return ok({ messages: [{ id: 'msg1' }] }) }
  return ok({ token: 'token' })
 } })
 assert.deepEqual(await client.sendText('app1', { to: '260977123456', body: 'Hello', replyToMessageId: 'original' }), { messageId: 'msg1', status: 'accepted' })
 assert.equal(sent.context.message_id, 'original')
 await assert.rejects(client.sendText('app1', { to: '260977123456', body: 'x'.repeat(4097) }), /message_validation/)
})

test('marketing uses MM Lite while utility uses v3; media never accepts arbitrary URLs', async () => {
 const paths = []
 const client = createGupshupPartnerClient({ email: 'e', secret: 's', fetchImpl: async (url) => {
  if (url.endsWith('/login') || url.endsWith('/token')) return ok({ token: 'token' })
  paths.push(url); return ok({ messages: [{ id: 'message1' }] })
 } })
 const request = { to: '260977123456', template: { name: 'notice', language: 'en' } }
 await client.sendTemplate('app1', { ...request, category: 'MARKETING' })
 await client.sendTemplate('app1', { ...request, category: 'UTILITY' })
 assert.ok(paths[0].endsWith('/onboarding/marketing/msg'))
 assert.ok(paths[1].endsWith('/v3/message'))
 await client.sendMedia('app1', { to: request.to, type: 'image', mediaId: '123456' })
 await assert.rejects(client.sendMedia('app1', { to: request.to, type: 'image', mediaId: 'https://private-host' }), /media_validation/)
})

test('upload uses multipart app authorization without setting a broken content-type boundary', async () => {
 let upload
 const client = createGupshupPartnerClient({ email:'e',secret:'s',fetchImpl:async(url,options)=>{
  if(url.endsWith('/media')){upload=options;return ok({status:'success',mediaId:'123456'})}return ok({token:'token'})
 } })
 assert.equal(await client.uploadMedia('app1',{buffer:Buffer.from('image'),mimetype:'image/png',originalname:'image.png'}),'123456')
 assert.equal(upload.headers['Content-Type'],undefined)
 assert.equal(upload.body.get('file_type'),'image/png')
 await assert.rejects(client.uploadMedia('app1',{buffer:Buffer.from('x'),mimetype:'text/html'}),/upload_validation/)
})
