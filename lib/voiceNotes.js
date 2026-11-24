const axios = require('axios')
const { randomUUID } = require('node:crypto')
const { safeGupshupAudioUrl } = require('./inboundMedia')
const { fetchWhatsAppMedia } = require('./whatsappMedia')
const { resolveWhatsAppAccessToken } = require('./whatsappCredentials')
const { shouldSuppressAutomation } = require('./conversationState')
const { cancelFollowups } = require('./leadFollowups')
const { isActiveAgent } = require('./aiDeploymentMode')

const BUCKET = 'whatsapp-voice-notes'
const MAX_BYTES = 16 * 1024 * 1024
const FORMATS = {
  'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr',
  'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/x-m4a': 'm4a'
}

function audioFormat(value) {
  const mimeType = String(value || '').split(';')[0].trim().toLowerCase()
  if (!Object.hasOwn(FORMATS, mimeType)) throw new Error('Unsupported audio format')
  return { mimeType, extension: FORMATS[mimeType] }
}

function voicePath(message) {
  return [message.customer_id, message.conversation_id, message.id].join('/')
}

async function retrieveAudio(media, number) {
  const url = media.provider === 'gupshup' && safeGupshupAudioUrl(media.provider_url)
  if (url) {
    const response = await axios.get(url, {
      responseType: 'arraybuffer', timeout: 15000, maxContentLength: MAX_BYTES, maxRedirects: 0
    })
    const contentType = response.headers['content-type']
    return {
      buffer: Buffer.from(response.data),
      mimeType: contentType?.startsWith('audio/') ? contentType : media.mime_type
    }
  }
  const accessToken = await resolveWhatsAppAccessToken(number, { customerId: number.customer_id })
  return fetchWhatsAppMedia({ mediaId: media.media_id, accessToken, expectedType: 'audio' })
}

async function loadScoped(db, table, id, customerId) {
  let query = db.from(table).select('*').eq('id', id)
  if (table !== 'customers') query = query.eq('customer_id', customerId)
  const { data, error } = await query.single()
  if (error || !data) throw Error('Voice note context unavailable')
  return data
}

async function processVoiceNotes({ db, transcribe, runAutomation }) {
  const token = randomUUID()
  const { data: jobs, error } = await db.rpc('claim_whatsapp_voice_note', { lease_token: token })
  if (error) throw error
  const job = jobs?.[0]
  if (!job) return

  const message = await loadScoped(db, 'messages', job.message_id, job.customer_id)
  const media = { ...message.inbound_media }
  const path = voicePath(message)
  const storage = db.storage.from(BUCKET)
  const save = async (state, nextAttempt = new Date()) => {
    const { data, error } = await db.rpc('update_whatsapp_voice_note', {
      job_message_id: message.id, lease_token: token, next_state: state,
      next_attempt: nextAttempt.toISOString(), audio_metadata: media
    })
    if (error || !data) throw Error('Voice note lease unavailable')
  }

  if (job.state === 'dispatching') {
    media.response_status = 'attention'
    await save('complete')
    return
  }

  let dispatching = false
  try {
    const number = await loadScoped(db, 'whatsapp_numbers', message.whatsapp_number_id, message.customer_id)
    if (media.audio_status !== 'ready') {
      const audio = await retrieveAudio({ ...media, provider_url: job.provider_url }, number)
      const { mimeType } = audioFormat(audio.mimeType)
      if (!audio.buffer.length || audio.buffer.length > MAX_BYTES) throw Error('Invalid voice note size')
      const upload = await storage.upload(path, audio.buffer, { contentType: mimeType, upsert: true })
      if (upload.error) throw upload.error
      media.mime_type = mimeType
      media.audio_status = 'ready'
      await save('processing')
    }

    await cancelFollowups(db, message.customer_id, message.conversation_id)
    const workspace = await loadScoped(db, 'customers', message.customer_id, message.customer_id)
    const paid = ['business', 'pro'].includes(workspace.subscription_plan) &&
      ['active', 'trial'].includes(workspace.subscription_status)
    const agents = paid ? await db.from('ai_agents').select('*').eq('customer_id', message.customer_id)
      .eq('whatsapp_number_id', number.id).eq('is_active', true).eq('lifecycle_status', 'active')
      .is('legacy_contained_at', null) : { data: [] }
    if (agents.error) throw agents.error
    if (!agents.data.some(isActiveAgent)) {
      media.transcription_status = 'skipped'
      await save('complete')
      return
    }

    if (!media.transcript) {
      const { data: blob, error } = await storage.download(path)
      if (error || !blob) throw Error('Stored audio unavailable')
      const { extension } = audioFormat(media.mime_type)
      const transcript = await transcribe(Buffer.from(await blob.arrayBuffer()), extension)
      if (!transcript?.trim()) throw Error('Transcription was empty')
      media.transcript = transcript.trim().slice(0, 16000)
      media.transcription_status = 'complete'
      await save('processing')
    }

    const [conversation, contact] = await Promise.all([
      loadScoped(db, 'conversations', message.conversation_id, message.customer_id),
      loadScoped(db, 'contacts', message.contact_id, message.customer_id)
    ])
    if (conversation.status === 'resolved' || shouldSuppressAutomation(conversation) || number.status !== 'connected') {
      await save('complete')
      return
    }

    let replyToMessage = null
    if (message.reply_to_message_id) {
      const reply = await db.from('messages').select('message_body,inbound_media,outbound_media')
        .eq('id', message.reply_to_message_id).eq('customer_id', message.customer_id)
        .eq('conversation_id', conversation.id).maybeSingle()
      if (reply.error) throw reply.error
      replyToMessage = reply.data
    }

    await save('dispatching')
    dispatching = true
    await runAutomation({
      customerId: message.customer_id, number, contact, conversation, from: message.from_number,
      body: media.transcript, media, metaId: message.meta_message_id, adReferral: message.ad_referral,
      replyContextMetaId: message.reply_context_meta_id, replyToMessage
    })
    await save('complete')
  } catch {
    if (!dispatching && job.attempts < 4) {
      await save('pending', new Date(Date.now() + 5000 * 2 ** job.attempts))
    } else {
      if (dispatching) media.response_status = 'attention'
      else if (media.audio_status === 'ready') media.transcription_status = 'failed'
      else {
        media.audio_status = 'failed'
        media.transcription_status = 'skipped'
      }
      await save('complete')
    }
  }
}

module.exports = { BUCKET, voicePath, audioFormat, processVoiceNotes }
