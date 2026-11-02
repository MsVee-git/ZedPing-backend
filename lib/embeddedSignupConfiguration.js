// Only public Meta identifiers may cross this boundary. Never spread env or
// partner configuration into the signup response.
function publicEmbeddedSignupConfiguration(env = process.env) {
  const appId = String(env.META_APP_ID || '').trim()
  const configId = String(env.META_EMBEDDED_SIGNUP_CONFIG_ID || env.config_id || '').trim()
  if (!/^[0-9]{5,32}$/.test(appId) || (configId && !/^[0-9]{5,32}$/.test(configId))) {
    throw new Error('Invalid Meta signup configuration')
  }
  return { meta_app_id: appId, ...(configId ? { meta_config_id: configId } : {}) }
}

module.exports = { publicEmbeddedSignupConfiguration }
