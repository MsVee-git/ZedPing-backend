const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveWorkspaceSelection } = require('../middleware/workspaceSelection')

const phiri = '3b25fffa-f0c4-4d98-a69c-fbbeb7afe6c3'
const autoguard = '33ca423d-9813-4e5b-86d5-a3d99fe86a43'
const unauthorized = '30a82e9a-e7e5-44b2-b2ff-dc9d6b187d09'

test('accepts an explicitly selected authorized workspace', () => {
  const result = resolveWorkspaceSelection(new Map([[phiri, 'owner'], [autoguard, 'member']]), autoguard)
  assert.deepEqual(result, { kind: 'authorized', customerId: autoguard, role: 'member' })
})

test('rejects a forged unauthorized workspace header', () => {
  const result = resolveWorkspaceSelection(new Map([[phiri, 'owner']]), unauthorized)
  assert.deepEqual(result, { kind: 'unauthorized', customerId: unauthorized })
})

test('requires a selection for a multi-workspace account without a header', () => {
  const result = resolveWorkspaceSelection(new Map([[phiri, 'owner'], [autoguard, 'admin']]))
  assert.deepEqual(result, { kind: 'selection_required' })
})

test('uses the only authorized workspace for a single-workspace account', () => {
  const result = resolveWorkspaceSelection(new Map([[phiri, 'owner']]))
  assert.deepEqual(result, { kind: 'authorized', customerId: phiri, role: 'owner' })
})

test('revoked membership is rejected even when a stale workspace ID is supplied', () => {
  const result = resolveWorkspaceSelection(new Map([[phiri, 'owner']]), autoguard)
  assert.deepEqual(result, { kind: 'unauthorized', customerId: autoguard })
})
