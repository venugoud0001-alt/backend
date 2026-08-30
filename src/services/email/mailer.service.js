const mailerLegacy = require('../../../services/mailer');

module.exports = {
  transporter: mailerLegacy.transporter,
  sendOtpEmail: mailerLegacy.sendOtpEmail,
  sendWelcomeEmail: mailerLegacy.sendWelcomeEmail,
  sendPaymentReceiptEmail: mailerLegacy.sendPaymentReceiptEmail
};
