const env = require('./env');

module.exports = {
  CLIENT_ID: env.CASHFREE_CLIENT_ID,
  CLIENT_SECRET: env.CASHFREE_CLIENT_SECRET,
  ENV: env.CASHFREE_ENV,
  WEBHOOK_URL: env.CASHFREE_WEBHOOK_URL
};
