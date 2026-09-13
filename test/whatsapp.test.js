const test = require('node:test')
const assert = require('node:assert/strict')
const axios = require('axios')
const { sendTemplateMessage } = require('../lib/whatsapp')

test('sends the Meta-selected language using the configured Graph API version', async () => {
  const original = axios.post
  const calls = []
  axios.post = async (...args) => { calls.push(args); return { data: { messages: [{ id: 'wamid.test' }] } } }
  const previous = process.env.META_GRAPH_API_VERSION
  process.env.META_GRAPH_API_VERSION = 'v25.0'
  try {
    await sendTemplateMessage('1197262023469653', '260700000000', { name: 'review_demo', language: 'en_ZM' }, 'workspace-token')
    assert.match(calls[0][0], /\/v25\.0\/1197262023469653\/messages$/)
    assert.deepEqual(calls[0][1].template, { name: 'review_demo', language: { code: 'en_ZM' } })
  } finally {
    axios.post = original
    if (previous === undefined) delete process.env.META_GRAPH_API_VERSION
    else process.env.META_GRAPH_API_VERSION = previous
  }
})
