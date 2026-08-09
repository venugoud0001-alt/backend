/**
 * InternNetra Executive HTML Email Templates
 * Styled with Official Brand Colors (#00458A Navy & #E96B01 Orange)
 */

const BRAND_NAVY = "#00458A";
const BRAND_ORANGE = "#E96B01";
const BRAND_LIGHT_BG = "#f4f7fb";
const SITE_URL = process.env.FRONTEND_URL || "https://internnetra.com";

/**
 * Clean & Format Student Display Name (Avoids Raw Hex / Alpha-Numeric Username IDs)
 */
function formatStudentDisplayName(rawName = "", email = "") {
  let cleaned = String(rawName || "").trim();
  const isAlphaNumericId = /^[a-f0-9]{8,16}$/i.test(cleaned) || cleaned.includes("@") || !cleaned;

  if (isAlphaNumericId && email && email.includes("@")) {
    const handle = email.split("@")[0];
    if (!/^[a-f0-9]{8,16}$/i.test(handle)) {
      cleaned = handle.replace(/[._-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    } else {
      cleaned = "Student";
    }
  }

  return cleaned || "Student";
}

/**
 * Standard Header Component
 */
function renderHeader(subtitle = "OFFICIAL COMMUNICATION") {
  return `
    <tr>
      <td style="background-color: ${BRAND_NAVY}; padding: 36px 36px 30px 36px; border-top-left-radius: 20px; border-top-right-radius: 20px; text-align: center;">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td align="center">
              <h1 style="margin: 0; font-size: 28px; font-weight: 900; color: #ffffff; letter-spacing: 1px; font-family: 'Segoe UI', Arial, sans-serif;">
                Intern<span style="color: ${BRAND_ORANGE};">Netra</span>
              </h1>
              <p style="margin: 6px 0 0 0; font-size: 11px; font-weight: 800; color: #93c5fd; text-transform: uppercase; letter-spacing: 2.5px; font-family: 'Segoe UI', Arial, sans-serif;">
                ${subtitle}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `;
}

/**
 * Standard Footer Component
 */
function renderFooter() {
  return `
    <tr>
      <td style="background-color: #f8fafc; padding: 28px 36px; border-top: 1px solid #e2e8f0; text-align: center; border-bottom-left-radius: 20px; border-bottom-right-radius: 20px;">
        <p style="margin: 0 0 6px 0; font-size: 12px; font-weight: 800; color: ${BRAND_NAVY}; font-family: 'Segoe UI', Arial, sans-serif;">
          InternNetra Academic & Live Mentorship Labs
        </p>
        <p style="margin: 0 0 12px 0; font-size: 11px; color: #64748b; font-family: 'Segoe UI', Arial, sans-serif;">
          Official Portal: <a href="${SITE_URL}/login" style="color: ${BRAND_NAVY}; font-weight: 700; text-decoration: none;">${SITE_URL}/login</a> &nbsp;|&nbsp; Support: <a href="mailto:info@internnetra.com" style="color: ${BRAND_ORANGE}; font-weight: 700; text-decoration: none;">info@internnetra.com</a>
        </p>
        <p style="margin: 0; font-size: 10px; color: #94a3b8; font-family: 'Segoe UI', Arial, sans-serif;">
          © ${new Date().getFullYear()} InternNetra. All rights reserved. Industrial Upskilling & Verified Credentials.
        </p>
      </td>
    </tr>
  `;
}

/**
 * 1. Professional Email OTP Verification Template
 */
function getOtpEmailTemplate({ fullName = "Student", otp = "123456", expireMinutes = 10 }) {
  const displayName = formatStudentDisplayName(fullName);

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verification Code - InternNetra</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${BRAND_LIGHT_BG}; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b;">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: ${BRAND_LIGHT_BG}; padding: 40px 12px;">
    <tr>
      <td align="center">
        <!-- Main Container -->
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 580px; background-color: #ffffff; border-radius: 20px; box-shadow: 0 12px 32px rgba(0, 69, 138, 0.08); border: 1px solid #e2e8f0;">
          
          ${renderHeader("ACCOUNT VERIFICATION CODE")}

          <!-- Body -->
          <tr>
            <td style="padding: 40px 36px;">
              <h2 style="margin: 0 0 12px 0; font-size: 24px; font-weight: 800; color: ${BRAND_NAVY}; font-family: 'Segoe UI', Arial, sans-serif;">
                Verify Your Email Address
              </h2>
              <p style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.6; color: #475569;">
                Hello <strong style="color: #0f172a;">${displayName}</strong>,<br>
                Welcome to <strong>InternNetra</strong>. Please use the 6-digit One-Time Password (OTP) below to verify your email address:
              </p>

              <!-- OTP Container -->
              <div style="background-color: #fafbfc; border: 2px solid ${BRAND_ORANGE}; border-radius: 16px; padding: 26px 20px; text-align: center; margin: 28px 0; box-shadow: inset 0 2px 4px rgba(233,107,1,0.04);">
                <span style="font-size: 11px; font-weight: 800; text-transform: uppercase; color: ${BRAND_ORANGE}; letter-spacing: 2px; display: block; margin-bottom: 8px;">
                  SECURITY VERIFICATION CODE
                </span>
                <span style="font-size: 40px; font-weight: 900; letter-spacing: 10px; color: ${BRAND_NAVY}; font-family: 'Courier New', Courier, monospace; display: inline-block; padding-left: 10px;">
                  ${otp}
                </span>
                <span style="font-size: 12px; color: #64748b; display: block; margin-top: 12px; font-weight: 600;">
                  ⏱️ Valid for ${expireMinutes} minutes &nbsp;|&nbsp; Confidential & Single-Use
                </span>
              </div>

              <!-- Security Notice -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f0f7ff; border-radius: 12px; border-left: 4px solid ${BRAND_NAVY}; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 14px 18px; font-size: 13px; color: #1e3a8a; line-height: 1.5;">
                    🔒 <strong>Security Tip:</strong> InternNetra staff will never contact you asking for this OTP code. Do not share it with anyone.
                  </td>
                </tr>
              </table>

              <p style="margin: 0; font-size: 13px; color: #64748b; line-height: 1.5;">
                If you did not request this verification, you can safely disregard this message or notify our security team at <a href="mailto:info@internnetra.com" style="color: ${BRAND_NAVY}; font-weight: 700; text-decoration: underline;">info@internnetra.com</a>.
              </p>
            </td>
          </tr>

          ${renderFooter()}

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

/**
 * 2. Professional Welcome Email Template for New Students
 */
function getWelcomeEmailTemplate({ fullName = "Student", email = "" }) {
  const displayName = formatStudentDisplayName(fullName, email);

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to InternNetra</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${BRAND_LIGHT_BG}; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b;">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: ${BRAND_LIGHT_BG}; padding: 40px 12px;">
    <tr>
      <td align="center">
        <!-- Main Container -->
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 20px; box-shadow: 0 12px 32px rgba(0, 69, 138, 0.08); border: 1px solid #e2e8f0;">
          
          ${renderHeader("WELCOME TO INTERNNETRA")}

          <!-- Body -->
          <tr>
            <td style="padding: 40px 36px;">
              <h1 style="margin: 0 0 12px 0; font-size: 26px; font-weight: 900; color: ${BRAND_NAVY}; text-align: center;">
                Welcome Aboard, <span style="color: ${BRAND_ORANGE};">${displayName}</span>! 🚀
              </h1>
              <p style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.6; color: #475569; text-align: center;">
                Your InternNetra Student Account is officially active. You now have access to live mentorship, industry-level projects, and verified credentials.
              </p>

              <!-- Detailed Portal Login Credentials & Instructions Box -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f8fafc; border-radius: 16px; border: 1.5px solid #cbd5e1; margin: 24px 0; overflow: hidden;">
                <tr>
                  <td style="background-color: ${BRAND_NAVY}; padding: 14px 20px;">
                    <span style="color: #ffffff; font-size: 14px; font-weight: 800; font-family: 'Segoe UI', Arial, sans-serif; letter-spacing: 0.5px;">
                      🔑 HOW TO SIGN IN TO YOUR STUDENT PORTAL
                    </span>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 20px 24px;">
                    <p style="margin: 0 0 14px 0; font-size: 13.5px; color: #334155; line-height: 1.6;">
                      <strong>Student LMS Portal URL:</strong> <a href="${SITE_URL}/login" style="color: ${BRAND_NAVY}; font-weight: 800; text-decoration: underline;">${SITE_URL}/login</a><br>
                      <strong>Your Registered Email:</strong> <span style="color: ${BRAND_ORANGE}; font-weight: 800;">${email || "Your Registered Email"}</span>
                    </p>

                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top: 12px; font-size: 13px; color: #475569;">
                      <tr>
                        <td style="padding-bottom: 10px; vertical-align: top; width: 24px; font-weight: 800; color: ${BRAND_NAVY};">1.</td>
                        <td style="padding-bottom: 10px; line-height: 1.5;">
                          <strong>Password Sign-In:</strong> If you have already set your permanent password, select <em>Password Login</em>, enter your registered email & password, and click <em>Sign In</em>.
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-bottom: 10px; vertical-align: top; width: 24px; font-weight: 800; color: ${BRAND_ORANGE};">2.</td>
                        <td style="padding-bottom: 10px; line-height: 1.5;">
                          <strong>First-Time OTP Activation:</strong> If you have not set a password yet, select <em>First-Time OTP Activation</em>, enter your email to receive a 6-digit OTP code, and set your password to activate your account.
                        </td>
                      </tr>
                      <tr>
                        <td style="vertical-align: top; width: 24px; font-weight: 800; color: #047857;">3.</td>
                        <td style="line-height: 1.5;">
                          <strong>NLS Student LMS Dashboard:</strong> Once logged in, your dashboard will display your enrolled course schedules, live Zoom class links, assignments, and certificates.
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Features Container -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #fafbfc; border-radius: 16px; border: 1px solid #e2e8f0; margin: 24px 0; padding: 24px;">
                <tr>
                  <td style="padding-bottom: 16px;">
                    <strong style="font-size: 15px; color: ${BRAND_NAVY}; text-transform: uppercase; letter-spacing: 1px;">🌟 Included Program Benefits:</strong>
                  </td>
                </tr>
                <tr>
                  <td style="padding-bottom: 12px; font-size: 14px; color: #334155; line-height: 1.5;">
                    🔹 <strong>Live Interactive Upskilling:</strong> 2.5-hour daily intensive sessions guided by tech leads.
                  </td>
                </tr>
                <tr>
                  <td style="padding-bottom: 12px; font-size: 14px; color: #334155; line-height: 1.5;">
                    🔹 <strong>Verified Industry Credentials:</strong> Shareable ISO-certified certificates & official letters.
                  </td>
                </tr>
                <tr>
                  <td style="padding-bottom: 12px; font-size: 14px; color: #334155; line-height: 1.5;">
                    🔹 <strong>NLS LMS Dashboard:</strong> Access session recordings, code repositories, and project submission hubs.
                  </td>
                </tr>
                <tr>
                  <td style="font-size: 14px; color: #334155; line-height: 1.5;">
                    🔹 <strong>Dedicated Mentorship:</strong> 1-on-1 assistance and weekly Q&A guidance.
                  </td>
                </tr>
              </table>

              <!-- Action CTA Button -->
              <div style="text-align: center; margin: 32px 0;">
                <a href="${SITE_URL}/login" style="background-color: ${BRAND_NAVY}; color: #ffffff; padding: 16px 36px; border-radius: 14px; text-decoration: none; font-weight: 800; font-size: 15px; display: inline-block; box-shadow: 0 6px 18px rgba(0,69,138,0.3);">
                  Click Here to Login to NLS Student Portal →
                </a>
              </div>

              <p style="margin: 0; font-size: 13px; color: #64748b; text-align: center; line-height: 1.5;">
                Have questions? Our support team is available at <a href="mailto:info@internnetra.com" style="color: ${BRAND_NAVY}; font-weight: 700; text-decoration: underline;">info@internnetra.com</a>.
              </p>
            </td>
          </tr>

          ${renderFooter()}

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

/**
 * 3. Professional Payment Receipt & Admission Confirmation Email Template
 */
function getPaymentReceiptTemplate({
  studentName = "Student",
  email = "student@internnetra.com",
  mobile = "",
  courseName = "Full Stack Web Development",
  amountPaid = 2000,
  totalFee = 10000,
  remainingBalance = 8000,
  dueDate = "5 days",
  batchStartDate = "October 1, 2026",
  txnId = "CF-TXN-1001",
}) {
  const displayName = formatStudentDisplayName(studentName, email);
  const isPaidFull = Number(remainingBalance) <= 0;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Official Payment Receipt - InternNetra</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${BRAND_LIGHT_BG}; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b;">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: ${BRAND_LIGHT_BG}; padding: 40px 12px;">
    <tr>
      <td align="center">
        <!-- Main Container -->
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 20px; box-shadow: 0 12px 32px rgba(0, 69, 138, 0.08); border: 1px solid #e2e8f0;">
          
          ${renderHeader("PAYMENT CONFIRMATION & ADMISSION RECEIPT")}

          <!-- Body -->
          <tr>
            <td style="padding: 40px 36px;">
              <!-- Status Pill -->
              <div style="text-align: center; margin-bottom: 20px;">
                <span style="background-color: #ecfdf5; color: #047857; font-size: 12px; font-weight: 800; padding: 8px 18px; border-radius: 50px; border: 1px solid #a7f3d0; text-transform: uppercase; letter-spacing: 1px; display: inline-block;">
                  ✓ PAYMENT VERIFIED & ADMISSION CONFIRMED
                </span>
              </div>

              <h2 style="margin: 0 0 8px 0; font-size: 22px; font-weight: 800; color: ${BRAND_NAVY}; text-align: center;">
                Admission Receipt
              </h2>
              <p style="margin: 0 0 24px 0; font-size: 14px; color: #475569; line-height: 1.6; text-align: center;">
                Dear <strong>${displayName}</strong>, thank you for your payment. Your enrollment in <strong>${courseName}</strong> has been processed successfully.
              </p>

              <!-- Payment Summary Table -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #fafbfc; border-radius: 16px; border: 1px solid #e2e8f0; margin-bottom: 24px; font-size: 14px;">
                <tr>
                  <td style="padding: 14px 18px; border-bottom: 1px solid #e2e8f0; font-weight: 700; color: #64748b;">Transaction ID</td>
                  <td style="padding: 14px 18px; border-bottom: 1px solid #e2e8f0; font-weight: 800; color: ${BRAND_NAVY}; text-align: right; font-family: monospace;">${txnId}</td>
                </tr>
                <tr>
                  <td style="padding: 14px 18px; border-bottom: 1px solid #e2e8f0; font-weight: 700; color: #64748b;">Enrolled Program</td>
                  <td style="padding: 14px 18px; border-bottom: 1px solid #e2e8f0; font-weight: 800; color: #0f172a; text-align: right;">${courseName}</td>
                </tr>
                <tr>
                  <td style="padding: 14px 18px; border-bottom: 1px solid #e2e8f0; font-weight: 700; color: #64748b;">Amount Paid Today</td>
                  <td style="padding: 14px 18px; border-bottom: 1px solid #e2e8f0; font-weight: 900; color: #047857; font-size: 16px; text-align: right;">₹${Number(amountPaid).toLocaleString()}</td>
                </tr>
                <tr>
                  <td style="padding: 14px 18px; border-bottom: 1px solid #e2e8f0; font-weight: 700; color: #64748b;">Total Program Fee</td>
                  <td style="padding: 14px 18px; border-bottom: 1px solid #e2e8f0; font-weight: 800; color: #0f172a; text-align: right;">₹${Number(totalFee).toLocaleString()}</td>
                </tr>
                <tr>
                  <td style="padding: 14px 18px; border-bottom: 1px solid #e2e8f0; font-weight: 700; color: #64748b;">Installment Balance</td>
                  <td style="padding: 14px 18px; border-bottom: 1px solid #e2e8f0; font-weight: 800; color: ${isPaidFull ? "#047857" : BRAND_ORANGE}; text-align: right;">
                    ${isPaidFull ? "FULL PAYMENT COMPLETE" : `₹${Number(remainingBalance).toLocaleString()} (Due: ${dueDate})`}
                  </td>
                </tr>
                <tr>
                  <td style="padding: 14px 18px; font-weight: 700; color: #64748b;">Batch Start Date</td>
                  <td style="padding: 14px 18px; font-weight: 800; color: ${BRAND_NAVY}; text-align: right;">${batchStartDate}</td>
                </tr>
              </table>

              <!-- Detailed Portal Login Credentials & Instructions Box -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f8fafc; border-radius: 16px; border: 1.5px solid #cbd5e1; margin: 24px 0; overflow: hidden;">
                <tr>
                  <td style="background-color: ${BRAND_NAVY}; padding: 14px 20px;">
                    <span style="color: #ffffff; font-size: 14px; font-weight: 800; font-family: 'Segoe UI', Arial, sans-serif; letter-spacing: 0.5px;">
                      🔑 HOW TO ACCESS YOUR STUDENT LMS PORTAL
                    </span>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 20px 24px;">
                    <p style="margin: 0 0 14px 0; font-size: 13.5px; color: #334155; line-height: 1.6;">
                      <strong>Portal Login Link:</strong> <a href="${SITE_URL}/login" style="color: ${BRAND_NAVY}; font-weight: 800; text-decoration: underline;">${SITE_URL}/login</a><br>
                      <strong>Your Registered Email:</strong> <span style="color: ${BRAND_ORANGE}; font-weight: 800;">${email}</span>
                    </p>

                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top: 12px; font-size: 13px; color: #475569;">
                      <tr>
                        <td style="padding-bottom: 8px; vertical-align: top; width: 24px; font-weight: 800; color: ${BRAND_NAVY};">1.</td>
                        <td style="padding-bottom: 8px; line-height: 1.5;">
                          <strong>Password Login:</strong> Enter your email & password to sign in.
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-bottom: 8px; vertical-align: top; width: 24px; font-weight: 800; color: ${BRAND_ORANGE};">2.</td>
                        <td style="padding-bottom: 8px; line-height: 1.5;">
                          <strong>First Time Login:</strong> If you haven't created a password, select <em>First-Time OTP Activation</em>, enter your email to receive a 6-digit OTP code, and set your password.
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Login CTA Button -->
              <div style="text-align: center; margin: 28px 0 20px 0;">
                <a href="${SITE_URL}/login" style="background-color: ${BRAND_NAVY}; color: #ffffff; padding: 14px 32px; border-radius: 14px; text-decoration: none; font-weight: 800; font-size: 15px; display: inline-block; box-shadow: 0 4px 14px rgba(0,69,138,0.28);">
                  Access Student NLS Portal →
                </a>
              </div>
            </td>
          </tr>

          ${renderFooter()}

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

module.exports = {
  getOtpEmailTemplate,
  getWelcomeEmailTemplate,
  getPaymentReceiptTemplate,
};
