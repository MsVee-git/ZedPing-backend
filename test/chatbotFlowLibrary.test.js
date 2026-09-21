const test = require('node:test')
const assert = require('node:assert/strict')
const { libraryTemplate, templateIds } = require('../lib/chatbotFlowLibrary')
const { validateDefinition } = require('../lib/chatbotRuntime')

test('server-known Chatbot Flow recipes are whitelisted and complete', () => {
  assert.equal(templateIds.length, 8)
  for (const id of templateIds) {
    const recipe = libraryTemplate(id)
    assert.ok(recipe?.title)
    assert.ok(recipe?.definition?.entry_step_key)
    assert.ok(recipe.definition.steps.some((step) => step.id === recipe.definition.entry_step_key))
  }
  assert.equal(libraryTemplate('browser-supplied-definition'), null)
})

test('library definitions are fresh mutable drafts, not shared objects', () => {
  const first = libraryTemplate('lead_qualification')
  const second = libraryTemplate('lead_qualification')
  first.definition.steps[0].text = 'changed locally'
  assert.notEqual(second.definition.steps[0].text, 'changed locally')
})


test('every server-owned Chatbot Flow template satisfies D2.4 publication validation', () => {
  for (const id of templateIds) {
    const recipe = libraryTemplate(id)
    const definition = validateDefinition(recipe.definition)
    assert.equal(definition.entry_step_key, recipe.definition.entry_step_key)
  }
})
