/**
 * InternNetra Express Backend HTTP Server
 */

const app = require('./app');
const env = require('./config/env');

const PORT = env.PORT || 5000;

const HOST = '0.0.0.0';

const server = app.listen(PORT, HOST, () => {
  console.log(`🚀 InternNetra NLS Modular Backend running on http://${HOST}:${PORT}`);
});

module.exports = server;
