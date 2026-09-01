/**
 * Email provider adapter. Picks an implementation based on EMAIL_PROVIDER in .env.
 * Supported providers: console (default/dev), smtp, resend.
 *
 * Every send*() function must return a Promise and throw on failure.
 */

const PROVIDER = process.env.EMAIL_PROVIDER || 'console';
const FROM_ADDRESS = process.env.SMTP_FROM || process.env.EMAIL_FROM || 'noreply@icash.bank';

// ---------------------------------------------------------------------------
// console — development / fallback
// ---------------------------------------------------------------------------
async function sendViaConsole(to, code) {
  console.log(
    `\n[EMAIL GATEWAY - DEV MODE] OTP for ${to}: [ ${code} ] — Valid 5 minutes.\n`
  );
  return { devMode: true };
}

// ---------------------------------------------------------------------------
// smtp — nodemailer (requires SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS)
// ---------------------------------------------------------------------------
async function sendViaSmtp(to, code) {
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (e) {
    throw new Error('nodemailer is not installed. Run: npm install nodemailer');
  }

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    throw new Error('SMTP_HOST / SMTP_USER / SMTP_PASS must be set in .env for SMTP provider.');
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  await transporter.sendMail({
    from: `"iCash Banking" <${FROM_ADDRESS}>`,
    to,
    subject: 'Your iCash Verification Code',
    text: `Your iCash email verification code is: ${code}\n\nThis code expires in 5 minutes.\n\nIf you did not request this, please ignore this email.`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#0ea5e9">iCash Email Verification</h2>
        <p>Your one-time verification code is:</p>
        <p style="font-size:32px;font-weight:700;letter-spacing:8px;color:#0ea5e9;text-align:center">${code}</p>
        <p style="color:#888;font-size:12px">Valid for 5 minutes. Do not share this code with anyone.</p>
      </div>
    `,
  });

  return { delivered: true };
}

// ---------------------------------------------------------------------------
// resend — Resend.com API (requires RESEND_API_KEY)
// ---------------------------------------------------------------------------
async function sendViaResend(to, code) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set in .env');

  let fetch;
  try {
    fetch = require('node-fetch');
  } catch (e) {
    fetch = globalThis.fetch;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `iCash Banking <${FROM_ADDRESS}>`,
      to: [to],
      subject: 'Your iCash Verification Code',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
          <h2 style="color:#0ea5e9">iCash Email Verification</h2>
          <p>Your one-time verification code is:</p>
          <p style="font-size:32px;font-weight:700;letter-spacing:8px;color:#0ea5e9;text-align:center">${code}</p>
          <p style="color:#888;font-size:12px">Valid for 5 minutes. Do not share this code with anyone.</p>
        </div>
      `,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error('Resend send failed: ' + JSON.stringify(data));
  return data;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const providers = {
  console: sendViaConsole,
  smtp: sendViaSmtp,
  resend: sendViaResend,
};

async function sendOtpEmail(to, code) {
  const send = providers[PROVIDER];
  if (!send) throw new Error(`Unknown EMAIL_PROVIDER "${PROVIDER}". Valid options: console, smtp, resend`);
  return send(to, code);
}

function isDevMode() {
  return PROVIDER === 'console';
}

module.exports = { sendOtpEmail, isDevMode, PROVIDER };
