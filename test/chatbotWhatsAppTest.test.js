const test = require('node:test')
const assert = require('node:assert/strict')
const { handleWhatsAppTest } = require('../lib/chatbotWhatsAppTest')

function fixture() {
  let row = {
    id: 'test', customer_id: 'workspace', whatsapp_number_id: 'business',
    sender: '+260971234567', start_code: 'AB12CD34', inputs: null,
    expires_at: '2099-01-01T00:00:00Z', content_items: {},
    definition: {
      entry_step_key: 'question',
      steps: [
        { id: 'question', type: 'ask_capture', text: 'What would you like to ask sales?',
          next_step_id: 'handoff', capture: { key: 'enquiry', label: 'Enquiry', type: 'text' } },
        { id: 'handoff', type: 'human_handoff', reason: 'Contact sales' }
      ]
    }
  }
  const db = {
    from(table) {
      assert.equal(table, 'chatbot_whatsapp_tests')
      const predicates = []
      let action = current => current
      return {
        select() { return this },
        eq(key, value) {
          predicates.push(current => key === 'inputs' ? JSON.stringify(current.inputs) === value : current[key] === value)
          return this
        },
        gt(key, value) { predicates.push(current => current[key] > value); return this },
        is(key, value) { predicates.push(current => current[key] === value); return this },
        update(changes) { action = current => (row = { ...current, ...changes }); return this },
        delete() { action = current => { row = null; return current }; return this },
        async maybeSingle() { return { data: row && predicates.every(matches => matches(row)) ? action(row) : null } }
      }
    }
  }
  const messages = []
  return {
    messages,
    receive: (body, context = {}) => handleWhatsAppTest(db, {
      number: { id: 'business' }, customerId: 'workspace', from: '260971234567', body, ...context
    }, async message => messages.push(message))
  }
}

test('only the approved sender on the correct business line and workspace can start a test', async () => {
  const { receive, messages } = fixture()
  const command = 'ZEDPING TEST AB12CD34'
  assert.equal(await receive(command, { from: '260971234568' }), false)
  assert.equal(await receive(command, { customerId: 'other' }), false)
  assert.equal(await receive(command, { number: { id: 'other' } }), false)
  assert.equal(await receive('hello'), false)
  assert.equal(await receive('ZEDPING TEST WRONG'), false)
  assert.deepEqual(messages, [])
})

test('a matched test continues in WhatsApp and simulates handoff before releasing the sender', async () => {
  const { receive, messages } = fixture()
  assert.equal(await receive('ZEDPING TEST AB12CD34'), true)
  assert.match(messages.at(-1), /What would you like to ask sales/)
  assert.equal(await receive('Do you have this model?'), true)
  assert.match(messages.at(-1), /would hand this conversation to the team/)
  assert.equal(await receive('hello'), false)
})

test('END TEST releases the sender without executing the next step', async () => {
  const { receive, messages } = fixture()
  await receive('ZEDPING TEST AB12CD34')
  assert.equal(await receive('END TEST'), true)
  assert.equal(messages.at(-1), 'ZedPing WhatsApp test ended.')
  assert.equal(await receive('hello'), false)
})
