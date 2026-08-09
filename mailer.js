/**
 * Nodemailer Email Transporter & Dispatcher
 * Configured via Environment Variables for Hostinger Managed Node.js
 */

const nodemailer = require("nodemailer");
const { getOtpEmailTemplate, getWelcomeEmailTemplate, getPaymentReceiptTemplate } = require("./emailTemplates");

// Create Reusable SMTP Transporter with Environment Credentials
function createTransporter() {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER || "";
  const pass = process.env.SMTP_PASS ? process.env.SMTP_PASS.replace(/\s+/g, "") : "";

  if (!user || !pass) {
    console.warn("⚠️ SMTP_USER or SMTP_PASS missing from environment. Email dispatch will fail.");
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true for 465 SSL
    auth: {
      user,
      pass,
    },
  });
}

const transporter = createTransporter();
const FROM_EMAIL = process.env.SMTP_FROM || `"InternNetra Team" <${process.env.SMTP_USER || "info@internnetra.com"}>`;

/**
 * Send 6-Digit Email OTP Verification Code
 */
async function sendOtpEmail({ to, fullName = "Student", otp, expireMinutes = 10 }) {
  if (!to || !otp) {
    throw new Error("Recipient email and OTP code are required.");
  }

  const html = getOtpEmailTemplate({ fullName, otp, expireMinutes });

  const mailOptions = {
    from: FROM_EMAIL,
    to,
    subject: `${otp} is your InternNetra Verification OTP Code`,
    html,
  };

  const info = await transporter.sendMail(mailOptions);
  console.log(`✉️ OTP Email dispatched to ${to} (MessageId: ${info.messageId || "sent"})`);
  return info;
}

/**
 * Send Professional Welcome Email upon Account Creation
 */
async function sendWelcomeEmail({ to, fullName = "Student" }) {
  if (!to) {
    throw new Error("Recipient email is required.");
  }

  const html = getWelcomeEmailTemplate({ fullName, email: to });

  const mailOptions = {
    from: FROM_EMAIL,
    to,
    subject: `Welcome to InternNetra! 🎓 Your Learning Portal Access`,
    html,
  };

  const info = await transporter.sendMail(mailOptions);
  console.log(`✉️ Welcome Email dispatched to ${to} (MessageId: ${info.messageId || "sent"})`);
  return info;
}

/**
 * Send Official Admission Payment Receipt Email
 */
async function sendPaymentReceiptEmail({ to, paymentDetails }) {
  if (!to || !paymentDetails) {
    throw new Error("Recipient email and payment details are required.");
  }

  const html = getPaymentReceiptTemplate({
    studentName: paymentDetails.studentName || "Student",
    email: to,
    mobile: paymentDetails.mobile || "",
    courseName: paymentDetails.courseName || "Live Upskilling Program",
    amountPaid: paymentDetails.amountPaid || 2000,
    totalFee: paymentDetails.totalFee || 10000,
    remainingBalance: paymentDetails.remainingBalance || 0,
    dueDate: paymentDetails.dueDate || "5 Days",
    batchStartDate: paymentDetails.batchStartDate || "2026-10-01",
    txnId: paymentDetails.txnId || `CF-${Date.now()}`,
  });

  const mailOptions = {
    from: FROM_EMAIL,
    to,
    subject: `✓ Payment Confirmation & Admission Receipt - InternNetra (${paymentDetails.courseName})`,
    html,
  };

  const info = await transporter.sendMail(mailOptions);
  console.log(`✉️ Payment Receipt Email dispatched to ${to} (MessageId: ${info.messageId || "sent"})`);
  return info;
}

module.exports = {
  transporter,
  sendOtpEmail,
  sendWelcomeEmail,
  sendPaymentReceiptEmail,
};
