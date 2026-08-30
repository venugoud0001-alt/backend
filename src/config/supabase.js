const { createClient } = require('@supabase/supabase-js');
const env = require('./env');

// Node 20 WebSocket polyfill stub for Supabase Realtime client
if (typeof global.WebSocket === 'undefined') {
  global.WebSocket = class {};
}

const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

module.exports = {
  supabase,
  SUPABASE_URL,
  SUPABASE_KEY,
  CASHFREE_CLIENT_ID: env.CASHFREE_CLIENT_ID,
  CASHFREE_CLIENT_SECRET: env.CASHFREE_CLIENT_SECRET,
  CASHFREE_ENV: env.CASHFREE_ENV,
  CASHFREE_WEBHOOK_URL: env.CASHFREE_WEBHOOK_URL,
  JWT_SECRET: env.JWT_SECRET
};
