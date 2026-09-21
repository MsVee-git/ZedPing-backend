const test = require('node:test')
const assert = require('node:assert/strict')
const { getTemplate, recommend, validateProvenance } = require('../lib/automationLibrary')

test('Automation Library only recommends available recipes with deterministic scoring', () => {
  const first = recommend({ industry: 'education', goals: ['customer_support'] })
  const second = recommend({ industry: 'education', goals: ['customer_support'] })
  assert.deepEqual(first.map((item) => item.id), second.map((item) => item.id))
  assert.ok(first.every((item) => item.availability === 'available'))
  assert.equal(first[0].id, 'school_fees')
})

test('Automation Library provenance must match the server catalogue and capability', () => {
  const template = getTemplate('welcome_message', 1)
  assert.equal(validateProvenance({ id: template.id, version: template.version, automation_type: 'welcome' }).id, 'welcome_message')
  assert.throws(() => validateProvenance({ id: 'welcome_message', version: 1, automation_type: 'keyword' }))
  assert.throws(() => validateProvenance({ id: 'unknown', version: 1, automation_type: 'keyword' }))
})