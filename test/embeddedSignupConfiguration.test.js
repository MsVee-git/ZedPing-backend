const test = require('node:test')
const assert = require('node:assert/strict')
const { publicEmbeddedSignupConfiguration: config } = require('../lib/embeddedSignupConfiguration')

test('signup preflight exposes only public IDs, including the existing config_id alias', () => {
  assert.deepEqual(config({ META_APP_ID: ' 123456 ', config_id: '654321', META_APP_SECRET: 'private', GUPSHUP_UNIVERSAL_TOKEN: 'private' }), {
    meta_app_id: '123456', meta_config_id: '654321'
  })
  assert.deepEqual(config({ META_APP_ID: '123456' }), { meta_app_id: '123456' })
  assert.equal(config({ META_APP_ID: '123456', META_EMBEDDED_SIGNUP_CONFIG_ID: '765432', config_id: '654321' }).meta_config_id, '765432')
})

test('invalid public configuration fails before preparing an unusable signup', () => {
  for (const env of [{}, { META_APP_ID: 'bad' }, { META_APP_ID: '123456', config_id: 'bad' }]) {
    assert.throws(() => config(env), /Invalid Meta signup configuration/)
  }
})
