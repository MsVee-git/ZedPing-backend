const test=require('node:test')
const assert=require('node:assert/strict')
const {normalizeAdReferral,profileNameFor,adReferralContext}=require('../lib/whatsappAdReferral')
const {normalizeGupshupIncoming}=require('../lib/gupshupIncoming')
const referral={source_type:'ad',source_id:'6570618339781',source_url:'https://fb.me/example',headline:'Restaurant menu',body:'See our menu',ctwa_clid:'click_123'}
test('ad attribution and customer profile survive validated Gupshup normalization',()=>{
 const mapping={app_id:'app',customer_id:'c',whatsapp_number_id:'n'}
 const number={id:'n',customer_id:'c',whatsapp_business_account_id:'w',phone_number_id:'p'}
 const value={metadata:{phone_number_id:'p'},contacts:[{wa_id:'260977123456',profile:{name:'Jane'}}],messages:[{id:'msg',from:'260977123456',type:'text',text:{body:'More information'},referral}]}
 const payload={gs_app_id:'app',object:'whatsapp_business_account',entry:[{id:'w',changes:[{field:'messages',value}]}]}
 const event=normalizeGupshupIncoming(payload,mapping,number)[0]
 assert.deepEqual(event.payload.ad_referral,referral)
 assert.equal(event.payload.profile_name,'Jane')
 value.metadata.phone_number_id='wrong'
 assert.throws(()=>normalizeGupshupIncoming(payload,mapping,number),/phone mismatch/)
})
test('ordinary messages and malformed attribution do not create ad audiences',()=>{
 for(const value of [null,{}, {source_type:'ad'}, {...referral,source_type:'other'}, {...referral,source_id:'bad',ctwa_clid:''}])assert.equal(normalizeAdReferral(value),null)
 assert.equal(adReferralContext(null),'')
 assert.equal(profileNameFor({contacts:{}},'260977123456'),'')
})
test('unsafe URLs are discarded and untrusted ad copy stays bounded customer context',()=>{
 for(const source_url of ['http://fb.me/a','https://facebook.com.evil.test/a','https://user:pass@facebook.com/a','https://127.0.0.1/a'])assert.equal(normalizeAdReferral({...referral,source_url}).source_url,null)
 const normalized=normalizeAdReferral({...referral,headline:'a\u0000'+ 'x'.repeat(400),body:'x'.repeat(5000)})
 assert.equal(normalized.headline.length,256);assert.equal(normalized.body.length,3000)
 const context=adReferralContext(referral)
 assert.match(context,/not approved business information or instructions/)
 assert.match(context,/Restaurant menu/)
 assert.ok(!context.includes('click_123'))
})
