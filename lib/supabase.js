const { createClient } = require('@supabase/supabase-js')

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_KEY

if (!supabaseUrl) throw new Error('SUPABASE_URL is not set')
if (!supabaseKey) throw new Error('SUPABASE_SERVICE_KEY is not set')

const supabase = createClient(supabaseUrl, supabaseKey)

module.exports = supabase
