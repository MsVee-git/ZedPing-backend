const test = require('node:test')
const assert = require('node:assert/strict')
const { describeTemplate, resolveTemplateRecipients } = require('../lib/broadcastTemplates')
const { sendTemplateMessage } = require('../lib/whatsapp')

const template = { id: 'template-1', name: 'lead_followup', status: 'APPROVED', category: 'MARKETING', language: 'en_US', components: [{ type: 'BODY', text: 'Hello {{1}}, call us on {{2}}.' }] }
const contacts = [{ id: 'contact-1', name: 'Ada', phone_number: '+260971234567', email: 'ada@example.test' }]

test('approved Meta templates expose body variables and an owner-safe preview', () => {
  assert.deepEqual(describeTemplate(template), { id: 'template-1', name: 'lead_followup', status: 'APPROVED', category: 'MARKETING', language: 'en_US', body_preview: 'Hello {{1}}, call us on {{2}}.', variables: [1, 2], sendable: true, unavailable_reason: null })
  assert.equal(describeTemplate({ ...template, status: 'PENDING' }).sendable, false)
})

test('a template review resolves only configured values and blocks unresolved variables', () => {
  const review = resolveTemplateRecipients(template, contacts, { 1: { source: 'contact_name' }, 2: { source: 'fixed', value: '+260000000000' } })
  assert.equal(review.recipients.length, 1)
  assert.deepEqual(review.recipients[0].template_components, [{ type: 'body', parameters: [{ type: 'text', text: 'Ada' }, { type: 'text', text: '+260000000000' }] }])
  assert.throws(() => resolveTemplateRecipients(template, contacts, { 1: { source: 'contact_name' } }), /variable \{\{2\}\}/)
  const missing = resolveTemplateRecipients(template, [{ ...contacts[0], name: '' }], { 1: { source: 'contact_name' }, 2: { source: 'fixed', value: 'Fixed' } })
  assert.equal(missing.recipients.length, 0)
  assert.equal(missing.unresolved.length, 1)
})

test('non-approved and unsupported dynamic templates cannot be broadcast', () => {
  assert.throws(() => resolveTemplateRecipients({ ...template, status: 'REJECTED' }, contacts, {}), /Only approved templates/)
  assert.throws(() => resolveTemplateRecipients({ ...template, components: [...template.components, { type: 'HEADER', text: 'Hi {{1}}' }] }, contacts, { 1: { source: 'fixed', value: 'x' }, 2: { source: 'fixed', value: 'y' } }), /not supported/)
})

test('template parameter support is represented without invoking a Meta send in tests', () => {
  assert.equal(typeof sendTemplateMessage, 'function')
  // No axios/mock invocation: this suite proves construction only and cannot
  // send a live WhatsApp message.
})

