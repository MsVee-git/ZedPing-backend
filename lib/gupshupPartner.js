// Server-only adapter. Deliberately not enabled in the existing Meta flow.
class GupshupError extends Error {
  constructor(stage, status = null) {
    super(`Gupshup ${stage} failed`)
    this.name = 'GupshupError'
    this.stage = stage
    this.status = status
  }
}

function createGupshupPartnerClient({ email, secret, universalToken, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  let cachedToken = null
  let expiresAt = 0
  let pendingLogin = null
  const base = 'https://partner.gupshup.io'
  async function request(stage, path, { method = 'GET', token, form, json, multipart, bearer = false } = {}) {
    try {
      const headers = { Accept: 'application/json' }
      if (token) headers.Authorization = (bearer || universalToken) ? `Bearer ${token}` : token
      if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded'
      if (json) headers['Content-Type'] = 'application/json'
      const response = await fetchImpl(`${base}${path}`, {
        method, headers, body: multipart || (form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : undefined),
        signal: AbortSignal.timeout(15000), redirect: 'error'
      })
      if (!response.ok) throw new GupshupError(stage, response.status)
      const data = await response.json()
      if (!data || data.status === 'error') throw new GupshupError(stage, response.status)
      return data
    } catch (error) {
      // Never propagate HTTP bodies or errors that could contain credentials.
      if (error instanceof GupshupError) throw error
      throw new GupshupError(stage)
    }
  }
  async function getPartnerToken() {
    if (universalToken) return universalToken
    if (cachedToken && now() < expiresAt) return cachedToken
    if (!email || !secret) throw new GupshupError('configuration')
    if (!pendingLogin) pendingLogin = (async () => {
      const started = now()
      const data = await request('authentication', '/partner/account/login', {
        method: 'POST', form: { email, secret }
      })
      if (typeof data.token !== 'string' || !data.token) throw new GupshupError('authentication')
      cachedToken = data.token
      // Documentation specifies 24 hours; renew five minutes early.
      expiresAt = started + 24 * 60 * 60 * 1000 - 5 * 60 * 1000
      return cachedToken
    })().finally(() => { pendingLogin = null })
    return pendingLogin
  }
  function appPath(appId, suffix) {
    if (typeof appId !== 'string' || !/^[a-zA-Z0-9-]+$/.test(appId)) throw new GupshupError('app_id_validation')
    return `/partner/app/${encodeURIComponent(appId)}/${suffix}`
  }
  async function getAppToken(appId) {
    const path = appPath(appId, 'token')
    if (universalToken) return universalToken
    const data = await request('app_token', path, { token: await getPartnerToken() })
    const token = typeof data.token === 'string' ? data.token : data.token?.token
    if (data.token?.active === false || typeof token !== 'string' || !token) throw new GupshupError('app_token')
    return token
  }
  async function getAppStatus(appId) {
    const path = appPath(appId, 'pipeline')
    const data = await request('app_status', path, { token: await getAppToken(appId) })
    const wa = data.whatsapp || {}
    return {
      creationStage: wa.creationStage || null,
      pipelineStage: wa.pipeLineStage || null,
      verificationStatus: wa.whatsappVerificationStatus || null,
      provisioned: wa.creationStage === 'WHATSAPP_PROVISIONING_DONE' &&
        wa.whatsappVerificationStatus === 'WHATSAPP_VERIFICATION_DONE'
    }
  }
  async function linkApp({ name, wabaId, phone, walletId, callbackUrl } = {}) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9]{6,150}$/.test(name) ||
        typeof wabaId !== 'string' || !/^[0-9]{5,32}$/.test(wabaId) ||
        typeof phone !== 'string' || !/^[1-9][0-9]{6,14}$/.test(phone) ||
        typeof walletId !== 'string' || !/^[A-Za-z0-9-]+$/.test(walletId)) {
      throw new GupshupError('link_validation')
    }
    if (callbackUrl) {
      let url
      try { url = new URL(callbackUrl) } catch { throw new GupshupError('callback_validation') }
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new GupshupError('callback_validation')
    }
    const form = { name, wabaId, phone, walletId }
    if (callbackUrl) form.callbackUrl = callbackUrl
    const data = await request('app_link', '/partner/tpp/app', {
      method: 'POST', token: await getPartnerToken(), bearer: true, form
    })
    if (data.status !== 'success' || typeof data.appId !== 'string' || !/^[A-Za-z0-9-]+$/.test(data.appId)) {
      throw new GupshupError('app_link')
    }
    return { appId: data.appId }
  }
  async function subscribeApp(appId, { callbackUrl, webhookSecret } = {}) {
    const path = appPath(appId, 'subscription')
    let url
    try { url = new URL(callbackUrl) } catch { throw new GupshupError('subscription_validation') }
    if (url.protocol !== 'https:' || url.username || url.password ||
        typeof webhookSecret !== 'string' || webhookSecret.length < 32) throw new GupshupError('subscription_validation')
    const data = await request('subscription', path, { method: 'POST', token: await getAppToken(appId), form: {
      modes: 'ALL', tag: 'ZedPing', showOnUI: 'false', version: '3', url: callbackUrl,
      meta: JSON.stringify({ 'X-Gupshup-Webhook-Secret': webhookSecret })
    } })
    if (data.status !== 'success' || data.subscription?.active !== true || data.subscription?.appId !== appId) {
      throw new GupshupError('subscription')
    }
    return { subscriptionId: data.subscription.id }
  }
  async function sendText(appId, { to, body, replyToMessageId } = {}) {
    const path = appPath(appId, 'v3/message')
    if (typeof to !== 'string' || !/^[1-9][0-9]{6,14}$/.test(to) ||
        typeof body !== 'string' || !body.trim() || body.length > 4096 ||
        (replyToMessageId != null && (typeof replyToMessageId !== 'string' || !replyToMessageId || replyToMessageId.length > 512))) {
      throw new GupshupError('message_validation')
    }
    const json = { messaging_product: 'whatsapp', recipient_type: 'individual', to,
      type: 'text', text: { body }, ...(replyToMessageId ? { context: { message_id: replyToMessageId } } : {}) }
    const data = await request('text_message', path, { method: 'POST', token: await getAppToken(appId), json })
    const messageId = data.messages?.[0]?.id
    if (typeof messageId !== 'string' || !messageId) throw new GupshupError('text_message')
    // Accepted is not delivered. Caller must reserve usage and reconcile events.
    return { messageId, status: 'accepted' }
  }
  async function sendTemplate(appId, { to, template, category } = {}) {
    if (!/^[1-9][0-9]{6,14}$/.test(to || '') ||
        typeof template?.name !== 'string' || !/^[a-z0-9_]+$/.test(template.name) ||
        typeof template?.language !== 'string' || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(template.language) ||
        !['MARKETING','UTILITY','AUTHENTICATION'].includes(category)) throw new GupshupError('template_validation')
    const path = appPath(appId, category === 'MARKETING' ? 'onboarding/marketing/msg' : 'v3/message')
    const json = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template',
      template: { name: template.name, language: { code: template.language },
        ...(template.components ? { components: template.components } : {}) } }
    const data = await request('template_message', path, { method: 'POST', token: await getAppToken(appId), json })
    const messageId = data.messages?.[0]?.id
    if (typeof messageId !== 'string' || !messageId) throw new GupshupError('template_message')
    return { messageId, status: 'accepted' }
  }
  async function sendMedia(appId, { to, type, mediaId, caption, filename, replyToMessageId } = {}) {
    if (!/^[1-9][0-9]{6,14}$/.test(to || '') || !['image','document'].includes(type) ||
        !/^[0-9]{5,64}$/.test(mediaId || '') || (caption != null && (typeof caption !== 'string' || caption.length > 1024))) throw new GupshupError('media_validation')
    const media = { id: mediaId, ...(caption ? { caption } : {}) }
    if (type === 'document' && filename) {
      if (typeof filename !== 'string' || filename.length > 180) throw new GupshupError('media_validation')
      media.filename = filename
    }
    const data = await request('media_message', appPath(appId, 'v3/message'), { method: 'POST', token: await getAppToken(appId), json: {
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type, [type]: media,
      ...(replyToMessageId ? { context: { message_id: replyToMessageId } } : {})
    } })
    const messageId = data.messages?.[0]?.id
    if (typeof messageId !== 'string' || !messageId) throw new GupshupError('media_message')
    return { messageId, status: 'accepted' }
  }
  async function uploadMedia(appId, file) {
    const path = appPath(appId, 'media')
    if (!Buffer.isBuffer(file?.buffer) || !file.buffer.length || file.buffer.length > 16 * 1024 * 1024 ||
        typeof file.mimetype !== 'string' || !/^(image\/(jpeg|png)|application\/pdf)$/.test(file.mimetype)) throw new GupshupError('upload_validation')
    const form = new FormData()
    form.append('file_type', file.mimetype)
    form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname || 'attachment')
    const data = await request('media_upload', path, { method: 'POST', token: await getAppToken(appId), multipart: form })
    if (data.status !== 'success' || !/^[0-9]{5,64}$/.test(data.mediaId || '')) throw new GupshupError('media_upload')
    return data.mediaId
  }
  return { getPartnerToken, getAppToken, getAppStatus, linkApp, subscribeApp, sendText, sendTemplate, sendMedia, uploadMedia }
}

module.exports = { createGupshupPartnerClient, GupshupError }
