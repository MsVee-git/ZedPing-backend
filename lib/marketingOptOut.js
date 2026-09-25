const COMMANDS = new Set(['STOP', 'STOP ALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'])
function isMarketingOptOutCommand(value) { return COMMANDS.has(String(value || '').trim().replace(/\s+/g, ' ').toUpperCase()) }
function splitMarketingRecipients(recipients) {
  const eligible = []; const optedOut = []
  for (const recipient of recipients || []) (recipient?.marketing_opted_out ? optedOut : eligible).push(recipient)
  return { eligible, optedOut }
}
// A manual recipient can omit its saved contact ID. Resolve suppression by
// canonical phone as well as the server-loaded flag, always within a workspace.
const { normalizePhone } = require('./broadcastRecipients')

async function filterWorkspaceMarketingRecipients(supabase, workspace, recipients) {
  if (!recipients.length) return { eligible: [], optedOut: [] }
  const suppressedPhones = new Set()
  const pageSize = 500
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.from('contacts')
      .select('phone_number,phone_e164').eq('customer_id', workspace)
      .eq('marketing_opted_out', true).order('id').range(offset, offset + pageSize - 1)
    if (error) throw error
    for (const contact of data || []) {
      for (const value of [contact.phone_e164, contact.phone_number]) {
        const phone = normalizePhone(value)
        if (phone) suppressedPhones.add(phone)
      }
    }
    if ((data || []).length < pageSize) break
  }
  return splitMarketingRecipients(recipients.map(recipient => ({
    ...recipient,
    marketing_opted_out: Boolean(recipient.marketing_opted_out) || suppressedPhones.has(normalizePhone(recipient.phone_number))
  })))
}

module.exports = { isMarketingOptOutCommand, splitMarketingRecipients, filterWorkspaceMarketingRecipients }
