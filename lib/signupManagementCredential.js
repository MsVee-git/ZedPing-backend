const crypto = require('node:crypto')

// Recover only from a completed, same-workspace Gupshup signup. Secrets stay
// within the server vault; re-check Meta ownership before giving a phone use.
async function recoverSignupManagementCredential(number, { db, vault, meta }) {
  const customerId = number.customer_id
  const mapping = await db.from('gupshup_connection_mappings').select('app_id,link_state')
    .eq('customer_id',customerId).eq('whatsapp_number_id',number.id).maybeSingle()
  if (mapping.error) throw new Error('Unable to verify provider mapping')
  if (!mapping.data?.app_id || mapping.data.link_state !== 'linked') return null
  const sessions = await db.from('whatsapp_connection_sessions').select('id')
    .eq('customer_id',customerId).eq('whatsapp_number_id',number.id)
    .eq('signup_phone_number_id',number.phone_number_id).eq('signup_waba_id',number.whatsapp_business_account_id)
    .eq('onboarding_provider','gupshup').not('completed_at','is',null)
    .order('completed_at',{ascending:false}).limit(1)
  if (sessions.error) throw new Error('Unable to verify signup session')
  const session = sessions.data?.[0]
  if (!session) return null
  const credentialKey = `signup_session_${crypto.createHash('sha256').update(session.id).digest('hex').slice(0,32)}`
  const token = await vault.get({customerId,integration:'meta_whatsapp',credentialKey})
  if (!token) return null
  const owned = await meta.validatePhoneOwnership({accessToken:token,phoneNumberId:number.phone_number_id,finishWabaId:number.whatsapp_business_account_id})
  if (owned.phoneNumberId !== number.phone_number_id || owned.wabaId !== number.whatsapp_business_account_id) throw new Error('Signup ownership mismatch')
  await vault.put({customerId,integration:'meta_whatsapp',credentialKey:`phone_${number.phone_number_id}`,plaintext:token})
  return token
}

// A bounded startup repair also verifies the live catalog, without sending a
// message or altering the subscription/allowance.
async function repairConnectedTemplateCredentials({db,resolveToken,createMeta,checkRegistration,diagnostic}) {
  const rows = await db.from('gupshup_connection_mappings').select('customer_id,whatsapp_numbers!inner(*)')
    .eq('link_state','linked').eq('whatsapp_numbers.status','connected').limit(20)
  if (rows.error) throw new Error('Unable to inspect template access')
  for (const row of rows.data || []) {
    const number = row.whatsapp_numbers
    if (number?.customer_id !== row.customer_id) continue
    try {
      const token = await resolveToken(number,{customerId:row.customer_id})
      if (checkRegistration) {
        try {
          const registration = await checkRegistration(number.phone_number_id,token)
          diagnostic({event:'meta_phone_registration',connection_id:number.id,connected:registration.connected===true,status:registration.status})
        } catch {diagnostic({event:'meta_phone_registration',connection_id:number.id,connected:null,status:'CHECK_FAILED'})}
      }
      const templates = await createMeta().listTemplates({wabaId:number.whatsapp_business_account_id,accessToken:token})
      diagnostic({event:'gupshup_template_access',connection_id:number.id,success:true,template_count:templates.length})
    } catch {diagnostic({event:'gupshup_template_access',connection_id:number.id,success:false})}
  }
}
module.exports = { recoverSignupManagementCredential, repairConnectedTemplateCredentials }
