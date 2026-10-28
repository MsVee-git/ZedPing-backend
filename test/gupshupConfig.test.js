const test = require('node:test')
const assert = require('node:assert/strict')
const { gupshupConfigForCustomer } = require('../lib/gupshupConfig')
const env = { GUPSHUP_ONBOARDING_ENABLED: 'true', GUPSHUP_TEST_CUSTOMER_IDS: 'test-workspace', GUPSHUP_PARTNER_EMAIL: 'partner@example.com', GUPSHUP_PARTNER_SECRET: 'private', GUPSHUP_SOLUTION_ID: '123456', GUPSHUP_WALLET_ID: 'wallet1', GUPSHUP_CALLBACK_URL: 'https://example.com/gupshup/webhook' }
test('Gupshup is off by default and isolated to allowlisted workspaces', () => {
 assert.equal(gupshupConfigForCustomer('test-workspace', {}), null)
 assert.equal(gupshupConfigForCustomer('existing-client', env), null)
 assert.equal(gupshupConfigForCustomer('test-workspace', env).solutionId, '123456')
})
test('selected workspaces fail closed with incomplete or unsafe configuration', () => {
 assert.throws(() => gupshupConfigForCustomer('test-workspace', { ...env, GUPSHUP_PARTNER_SECRET: '' }), /incomplete/)
 assert.throws(() => gupshupConfigForCustomer('test-workspace', { ...env, GUPSHUP_CALLBACK_URL: 'http://example.com' }), /invalid/)
})
test('production onboarding permits paid client setup while explicit switches still fail closed',()=>{
 const production={...env,GUPSHUP_PRODUCTION_ONBOARDING:'true',GUPSHUP_ROUTING_ENABLED:'true'}
 assert.equal(gupshupConfigForCustomer('new-client',production).solutionId,'123456')
 assert.ok(gupshupConfigForCustomer('new-client',production,'messaging'))
 assert.equal(gupshupConfigForCustomer('new-client',{...production,GUPSHUP_ONBOARDING_ENABLED:'false'}),null)
 assert.equal(gupshupConfigForCustomer('new-client',{...production,GUPSHUP_ROUTING_ENABLED:'false'},'messaging'),null)
})
