const capture = (key, label, type, required = true) => ({
  key, label, type, required,
  validation: type === 'choice' ? { options: [] } : {},
  failure_action: 'handoff', max_attempts: 2
})
const option = (id, label, next_step_id) => ({ id, label, aliases: [], next_step_id, outcome: null })

const definitions = {
  lead_qualification: () => ({ entry_step_key: 'welcome', steps: [
    { id: 'welcome', type: 'send_message', text: 'Hi 👋 We would love to learn how we can help.', next_step_id: 'name' },
    { id: 'name', type: 'ask_capture', text: 'What is your name?', next_step_id: 'need', capture: capture('name', 'Name', 'name') },
    { id: 'need', type: 'ask_capture', text: 'What can we help you with?', next_step_id: 'team', capture: capture('interest', 'What they need', 'text') },
    { id: 'team', type: 'human_handoff', reason: 'New lead qualification' }
  ] }),
  customer_details: () => ({ entry_step_key: 'intro', steps: [
    { id: 'intro', type: 'send_message', text: 'Thanks for getting in touch. We will collect a few details to help our team assist you.', next_step_id: 'name' },
    { id: 'name', type: 'ask_capture', text: 'What is your name?', next_step_id: 'email', capture: capture('name', 'Name', 'name') },
    { id: 'email', type: 'ask_capture', text: 'What is your email address?', next_step_id: 'team', capture: capture('email', 'Email', 'email') },
    { id: 'team', type: 'human_handoff', reason: 'Customer details captured' }
  ] }),
  vehicle_service: () => ({ entry_step_key: 'intro', steps: [
    { id: 'intro', type: 'send_message', text: 'Hi 👋 We would like to get a few details about your vehicle.', next_step_id: 'vehicle' },
    { id: 'vehicle', type: 'ask_capture', text: 'What vehicle do you have?', next_step_id: 'service', capture: capture('vehicle', 'Vehicle', 'text') },
    { id: 'service', type: 'choose_option', text: 'What do you need help with?', choices: [
      option('service', 'Vehicle Service', 'team'), option('repairs', 'Repairs', 'team'), option('diagnostics', 'Diagnostics', 'team')
    ] },
    { id: 'team', type: 'human_handoff', reason: 'Vehicle service enquiry' }
  ] }),
  quote: () => ({ entry_step_key: 'intro', steps: [
    { id: 'intro', type: 'send_message', text: 'We can help with a quote. Please share a few details.', next_step_id: 'request' },
    { id: 'request', type: 'ask_capture', text: 'What would you like a quote for?', next_step_id: 'budget', capture: capture('quote_request', 'Quote requirement', 'text') },
    { id: 'budget', type: 'ask_capture', text: 'Do you have a budget in mind? You can reply with a number or say not sure.', next_step_id: 'team', capture: capture('budget', 'Budget', 'text', false) },
    { id: 'team', type: 'human_handoff', reason: 'Quote request' }
  ] }),
  admissions: () => ({ entry_step_key: 'intro', steps: [
    { id: 'intro', type: 'send_message', text: 'Welcome. We can help with your admissions enquiry.', next_step_id: 'name' },
    { id: 'name', type: 'ask_capture', text: 'What is your name?', next_step_id: 'question', capture: capture('name', 'Name', 'name') },
    { id: 'question', type: 'ask_capture', text: 'What would you like to know about admissions?', next_step_id: 'team', capture: capture('admissions_question', 'Admissions question', 'text') },
    { id: 'team', type: 'human_handoff', reason: 'Admissions enquiry' }
  ] }),
  appointment: () => ({ entry_step_key: 'intro', steps: [
    { id: 'intro', type: 'send_message', text: 'We can help with your appointment enquiry.', next_step_id: 'date' },
    { id: 'date', type: 'ask_capture', text: 'What date would you prefer? Please use YYYY-MM-DD.', next_step_id: 'time', capture: capture('preferred_date', 'Preferred date', 'date') },
    { id: 'time', type: 'ask_capture', text: 'What time would you prefer?', next_step_id: 'team', capture: capture('preferred_time', 'Preferred time', 'text') },
    { id: 'team', type: 'human_handoff', reason: 'Appointment enquiry' }
  ] }),
  support: () => ({ entry_step_key: 'intro', steps: [
    { id: 'intro', type: 'send_message', text: 'We are here to help. Please tell us a little about your issue.', next_step_id: 'issue' },
    { id: 'issue', type: 'ask_capture', text: 'What do you need help with?', next_step_id: 'team', capture: capture('support_issue', 'Support issue', 'text') },
    { id: 'team', type: 'human_handoff', reason: 'Support request' }
  ] }),
  product_order: () => ({ entry_step_key: 'intro', steps: [
    { id: 'intro', type: 'send_message', text: 'Thanks for your interest. We will collect a few details.', next_step_id: 'product' },
    { id: 'product', type: 'ask_capture', text: 'Which product or order do you need help with?', next_step_id: 'team', capture: capture('product_or_order', 'Product or order', 'text') },
    { id: 'team', type: 'human_handoff', reason: 'Product or order enquiry' }
  ] })
}

const titles = {
  lead_qualification: 'Lead Qualification',
  customer_details: 'Capture Customer Details',
  vehicle_service: 'Vehicle Service Enquiry',
  quote: 'Request a Quote',
  admissions: 'Admissions Enquiry',
  appointment: 'Appointment Enquiry',
  support: 'Support Triage',
  product_order: 'Product / Order Enquiry'
}

function libraryTemplate(id) {
  const build = definitions[id]
  if (!build) return null
  return { id, title: titles[id], definition: build() }
}

module.exports = { libraryTemplate, templateIds: Object.freeze(Object.keys(definitions)) }
