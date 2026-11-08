const test = require('node:test')
const assert = require('node:assert/strict')
const { commercialTurn, commercialMetadata } = require('../lib/zoeCommercial')
const { handoffConfirmation } = require('../lib/zoeGrounding')

const quotation = { commercial_action:{ type:'quotation', qualification_fields:['product_or_service'] } }
const request = 'Can I book a table for 4 this Saturday at 7pm?'

test('restaurant booking retains the details and overrides even an ongoing quotation', () => {
  const old = commercialTurn(quotation, 'Can you quote me?', [], null).context
  for (const [config, existing] of [[{},null],[quotation,old]]) {
    const first = commercialTurn(config, request, [], existing)
    assert.equal(first.context.pending_field, 'name')
    assert.equal(first.reply, 'What name should I put on the request?')
    assert.deepEqual(first.context.collected, {date:'this Saturday',time:'7pm',party_size:'4'})
    const final = commercialTurn(config, 'Veronica Phiri', [], first.context)
    assert.equal(final.reason, 'booking_requested')
    assert.match(final.reply, /table for 4.*this Saturday at 7pm/)
    assert.doesNotMatch(final.reply, /confirmed|quotation/)
    assert.equal(commercialMetadata(final.context).collected.name, 'Veronica Phiri')
    assert.equal(handoffConfirmation('Braai House', final.reason), 'The Braai House team will check availability and follow up here on WhatsApp.')
  }
})

test('appointments collect only outstanding details and send a request for confirmation', () => {
  const first = commercialTurn({}, 'I’d like to book an appointment for a haircut tomorrow.', [], null)
  assert.equal(first.context.pending_field,'time')
  const second = commercialTurn({}, '3:30 PM', [], first.context)
  assert.equal(second.context.pending_field,'name')
  assert.deepEqual(second.context.collected, {date:'tomorrow',service:'a haircut',time:'3:30 PM'})
  const final = commercialTurn({}, 'My name is Chika', [], second.context)
  assert.equal(final.reason,'booking_requested')
  assert.match(final.reply,/appointment for a haircut.*tomorrow at 3:30 PM/)
})

test('a standalone date is not read as a party size', () => {
  const first = commercialTurn({}, 'Can I reserve a table for 14 November at 7pm?', [], null)
  assert.equal(first.context.pending_field,'party_size')
  assert.equal(commercialTurn({}, 'four', [], first.context).context.pending_field, 'name')
})

test('the draft test can resume a booking from prior turns', () => {
  const first = commercialTurn({}, request, [], null)
  const history = [{role:'user',content:request}, {role:'assistant',content:first.reply}]
  const final = commercialTurn({}, 'Chika', history, null)
  assert.equal(final.reason,'booking_requested')
  assert.equal(final.context.collected.party_size,'4')
})

test('booking FAQs, changes and unrelated enquiries stay outside booking intake', () => {
  for (const message of ['How do I book a table?', 'Do I need to book a table?', 'Can I cancel my appointment?', 'What is your reservation policy?', 'Can I speak to a person about my booking?']) {
    assert.equal(commercialTurn(quotation, message, [], null), null, message)
  }
  const active = commercialTurn(quotation, request, [], null)
  assert.equal(commercialTurn(quotation, 'Where are you located?', [], active.context), null)
  assert.equal(commercialTurn(quotation, 'Please send me the menu', [], active.context), null)
  assert.equal(commercialTurn(quotation, 'Please quote me for catering.', [], active.context).reason, 'quotation_requested')
})

test('a generic booking and a compact guest count lead to a table handoff', () => {
  const config = { ...quotation, booking_enabled:true }
  const first = commercialTurn(config, 'No, I would like to make a booking', [], null)
  assert.equal(first.reply, 'What would you like to book?')
  const second = commercialTurn(config, '14 November, 7pm', [], first.context)
  const third = commercialTurn(config, '3guests', [], second.context)
  assert.equal(third.context.pending_field, 'name')
  const last = commercialTurn(config, 'Chika', [], third.context)
  assert.equal(last.reason, 'booking_requested')
  assert.deepEqual(commercialMetadata(last.context).collected, {date:'14 November',time:'7pm',party_size:'3',name:'Chika'})
})

test('a generic request can become an appointment and the booking toggle is independent', () => {
  const first = commercialTurn({}, 'Can I book?', [], null)
  const second = commercialTurn({}, 'An appointment for a haircut', [], first.context)
  assert.equal(second.context.booking_type, 'appointment')
  assert.equal(second.context.collected.service, 'a haircut')
  assert.equal(second.context.pending_field, 'date')
  const disabled = { ...quotation, booking_enabled:false }
  assert.equal(commercialTurn(disabled, request, [], null), null)
  assert.equal(commercialTurn(disabled, 'Can I make a booking?', [], null), null)
  assert.equal(commercialTurn(disabled, 'Please quote me for catering.', [], null).reason, 'quotation_requested')
  for (const message of ['How do I make a booking?', 'I do not want to make a booking.', 'I want to buy a book.']) {
    assert.equal(commercialTurn({}, message, [], null), null, message)
  }
})
