const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')
const { requireAdmin } = require('../middleware/auth')
const { createMetaTemplateClient, MetaTemplateError } = require('../lib/metaTemplates')
const { sendTemplateMessage } = require('../lib/whatsapp')

function safeRecipient(value) {
  const digits = String(value || '').replace(/\D/g, '')
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null
}

async function resolveConnectedNumber(customerId) {
  const { data, error } = await supabase
    .from('whatsapp_numbers')
    .select('id, customer_id, phone_number_id, whatsapp_business_account_id, access_token, display_name, status')
    .eq('customer_id', customerId)
    .eq('status', 'connected')

  if (error) throw error
  if (!data?.length) return { kind: 'none' }
  // Phase 2 presents one number per workspace. Do not make an arbitrary
  // choice if a future multi-number workspace is encountered.
  if (data.length !== 1) return { kind: 'ambiguous' }
  const number = data[0]
  if (!number.phone_number_id || !number.whatsapp_business_account_id) return { kind: 'invalid' }
  return { kind: 'ok', number }
}

async function loadTemplates(customerId) {
  const resolved = await resolveConnectedNumber(customerId)
  if (resolved.kind !== 'ok') return resolved
  const meta = createMetaTemplateClient()
  const templates = await meta.listTemplates({
    wabaId: resolved.number.whatsapp_business_account_id,
    accessToken: resolved.number.access_token
  })
  return { ...resolved, meta, templates }
}

router.get('/', async (req, res) => {
  try {
    const result = await loadTemplates(req.workspace.customerId)
    if (result.kind === 'none') return res.status(404).json({ error: 'No connected WhatsApp number is available for this workspace' })
    if (result.kind === 'ambiguous') return res.status(409).json({ error: 'Select a WhatsApp number before viewing templates' })
    if (result.kind === 'invalid') return res.status(409).json({ error: 'The connected WhatsApp number is incomplete' })

    return res.json({
      templates: result.templates.map(({ id, name, status, category, language, components }) => ({ id, name, status, category, language, components: components || [] })),
      connection: {
        display_name: result.number.display_name || null,
        phone_number_id: result.number.phone_number_id
      }
    })
  } catch (error) {
    return res.status(error instanceof MetaTemplateError ? 502 : 500).json({ error: 'Unable to load WhatsApp templates from Meta' })
  }
})


function readTemplateCreateBody(body) {
  const allowed = ['name', 'category', 'language', 'body', 'variable_examples']
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new MetaTemplateError('Invalid template create request')
  if (typeof body.name !== 'string' || body.name.length > 100) throw new MetaTemplateError('Template name is required')
  if (typeof body.category !== 'string' || body.category.length > 16) throw new MetaTemplateError('Template category is required')
  if (typeof body.language !== 'string' || body.language.length > 10) throw new MetaTemplateError('Template language is required')
  if (typeof body.body !== 'string' || body.body.length > 1024) throw new MetaTemplateError('Template body is required')
  if (!Array.isArray(body.variable_examples) || body.variable_examples.length > 10 || body.variable_examples.some((value) => typeof value !== 'string' || value.length > 128)) {
    throw new MetaTemplateError('Variable examples are invalid')
  }
  return {
    name: body.name,
    category: body.category,
    language: body.language,
    body: body.body,
    variable_examples: body.variable_examples
  }
}

router.post('/', requireAdmin, async (req, res) => {
  let templateInput
  try {
    templateInput = readTemplateCreateBody(req.body || {})
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Invalid template create request' })
  }

  try {
    // The browser provides only draft text. The owning WABA and credentials
    // are always resolved from the active, authorized workspace.
    const resolved = await resolveConnectedNumber(req.workspace.customerId)
    if (resolved.kind === 'none') return res.status(404).json({ error: 'No connected WhatsApp number is available for this workspace' })
    if (resolved.kind === 'ambiguous') return res.status(409).json({ error: 'Select a WhatsApp number before creating a template' })
    if (resolved.kind === 'invalid') return res.status(409).json({ error: 'The connected WhatsApp number is incomplete' })

    const meta = createMetaTemplateClient()
    const submitted = await meta.createTemplate({
      wabaId: resolved.number.whatsapp_business_account_id,
      accessToken: resolved.number.access_token,
      template: templateInput
    })
    const validated = meta.buildTemplateSubmission(templateInput)
    return res.status(201).json({
      submitted: true,
      template: {
        id: submitted.id,
        name: validated.name,
        category: submitted.category || validated.category,
        language: validated.language,
        status: submitted.status,
        components: validated.components
      },
      connection: {
        display_name: resolved.number.display_name || null,
        phone_number_id: resolved.number.phone_number_id
      }
    })
  } catch (error) {
    if (error instanceof MetaTemplateError) {
      const status = error.kind === 'rejected' ? 422 : error.kind === 'upstream' ? 502 : 400
      return res.status(status).json({
        error: error.kind === 'rejected' ? 'Meta rejected the template submission' : error.message,
        detail: error.kind === 'rejected' ? error.detail : null
      })
    }
    return res.status(502).json({ error: 'Meta could not submit this template' })
  }
})

router.post('/send', requireAdmin, async (req, res) => {
  const body = req.body || {}
  if (Object.keys(body).some((key) => !['template_id', 'to'].includes(key))) return res.status(400).json({ error: 'Invalid template send request' })
  if (typeof body.template_id !== 'string' || body.template_id.length < 1 || body.template_id.length > 64) return res.status(400).json({ error: 'A Meta template ID is required' })
  const recipient = safeRecipient(body.to)
  if (!recipient) return res.status(400).json({ error: 'Enter a valid recipient phone number with country code' })

  try {
    const result = await loadTemplates(req.workspace.customerId)
    if (result.kind === 'none') return res.status(404).json({ error: 'No connected WhatsApp number is available for this workspace' })
    if (result.kind === 'ambiguous') return res.status(409).json({ error: 'Select a WhatsApp number before sending a template' })
    if (result.kind === 'invalid') return res.status(409).json({ error: 'The connected WhatsApp number is incomplete' })

    // The ID is only a selector: its contents are reloaded from Meta for this
    // workspace-owned WABA before anything is sent.
    const template = result.templates.find((item) => String(item.id) === body.template_id)
    const approved = result.meta.approvedNoVariableTemplate(template)
    const metaResult = await sendTemplateMessage(
      result.number.phone_number_id,
      recipient,
      { name: approved.name, language: approved.language },
      result.number.access_token
    )
    const metaMessageId = metaResult?.messages?.[0]?.id || null
    const { error: insertError } = await supabase.from('messages').insert({
      customer_id: req.workspace.customerId,
      whatsapp_number_id: result.number.id,
      direction: 'outbound',
      to_number: recipient,
      message_body: '[Template] ' + approved.name + ' (' + approved.language + ')',
      status: 'sent',
      meta_message_id: metaMessageId
    })

    if (insertError) return res.status(500).json({ success: false, message_accepted: true, error: 'Template was accepted by WhatsApp but could not be recorded' })
    return res.json({ success: true, template: { id: approved.id, name: approved.name, language: approved.language }, meta_message_id: metaMessageId })
  } catch (error) {
    if (error instanceof MetaTemplateError) return res.status(422).json({ error: error.message })
    return res.status(502).json({ error: 'WhatsApp could not send this template' })
  }
})

module.exports = router
