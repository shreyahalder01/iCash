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

  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) {
    throw new Error('SMTP_USER and SMTP_PASS environment variables are not set on the server.');
  }

  const fromSender = process.env.SMTP_FROM || user;

  const isGmail = host.includes('gmail') || user.endsWith('@gmail.com');
  const targetPort = isGmail ? 465 : port;

  const transportOptions = isGmail
    ? {
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        family: 4, // Force IPv4 to prevent ENETUNREACH in cloud containers without IPv6
        auth: { user, pass },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 20000,
        tls: {
          rejectUnauthorized: false,
        },
      }
    : {
        host,
        port: targetPort,
        secure: targetPort === 465,
        family: 4,
        auth: { user, pass },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 20000,
        tls: {
          rejectUnauthorized: false,
        },
      };

  const transporter = nodemailer.createTransport(transportOptions);

  await transporter.sendMail({
    from: fromSender.includes('<') ? fromSender : `"iCash Banking" <${fromSender}>`,
    to,
    subject: 'Your iCash Verification Code',
    text: `Your iCash email verification code is: ${code}\n\nThis code expires in 5 minutes.\n\nIf you did not request this, please ignore this email.`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;border:1px solid #e2e8f0;border-radius:8px">
        <h2 style="color:#0ea5e9;margin-top:0">iCash Email Verification</h2>
        <p style="color:#334155;font-size:15px">Your one-time verification code is:</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#0ea5e9;text-align:center;padding:16px 0;background:#f0f9ff;border-radius:6px;margin:16px 0">
          ${code}
        </div>
        <p style="color:#64748b;font-size:13px;margin-bottom:0">Valid for 5 minutes. Do not share this code with anyone.</p>
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

  const fromSender = process.env.RESEND_FROM || process.env.EMAIL_FROM || 'onboarding@resend.dev';

  // Try official Resend SDK first
  try {
    const { Resend } = require('resend');
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send({
      from: fromSender.includes('<') ? fromSender : `iCash Banking <${fromSender}>`,
      to: [to],
      subject: 'Your iCash Verification Code',
      text: `Your iCash email verification code is: ${code}\n\nThis code expires in 5 minutes.\n\nIf you did not request this, please ignore this email.`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;border:1px solid #e2e8f0;border-radius:8px">
          <h2 style="color:#0ea5e9;margin-top:0">iCash Email Verification</h2>
          <p style="color:#334155;font-size:15px">Your one-time verification code is:</p>
          <div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#0ea5e9;text-align:center;padding:16px 0;background:#f0f9ff;border-radius:6px;margin:16px 0">
            ${code}
          </div>
          <p style="color:#64748b;font-size:13px;margin-bottom:0">Valid for 5 minutes. Do not share this code with anyone.</p>
        </div>
      `,
    });

    if (error) {
      throw new Error(`Resend send failed: ${error.message || JSON.stringify(error)}`);
    }

    return { delivered: true, id: data?.id };
  } catch (sdkErr) {
    if (sdkErr.message && sdkErr.message.startsWith('Resend send failed:')) {
      throw sdkErr;
    }

    // Fallback to fetch if Resend SDK is missing
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
        from: fromSender.includes('<') ? fromSender : `iCash Banking <${fromSender}>`,
        to: [to],
        subject: 'Your iCash Verification Code',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;border:1px solid #e2e8f0;border-radius:8px">
            <h2 style="color:#0ea5e9;margin-top:0">iCash Email Verification</h2>
            <p style="color:#334155;font-size:15px">Your one-time verification code is:</p>
            <div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#0ea5e9;text-align:center;padding:16px 0;background:#f0f9ff;border-radius:6px;margin:16px 0">
              ${code}
            </div>
            <p style="color:#64748b;font-size:13px;margin-bottom:0">Valid for 5 minutes. Do not share this code with anyone.</p>
          </div>
        `,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error('Resend send failed: ' + JSON.stringify(data));
    return data;
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const providers = {
  console: sendViaConsole,
  smtp: sendViaSmtp,
  resend: sendViaResend,
};

function getProvider() {
  if (process.env.NODE_ENV === 'test') return 'console';
  return (process.env.EMAIL_PROVIDER || 'console').toLowerCase().trim();
}

async function sendOtpEmail(to, code) {
  const providerName = getProvider();
  const send = providers[providerName];
  if (!send) throw new Error(`Unknown EMAIL_PROVIDER "${providerName}". Valid options: console, smtp, resend`);
  return send(to, code);
}

function isDevMode() {
  return getProvider() === 'console';
}

module.exports = {
  sendOtpEmail,
  isDevMode,
  getProvider,
  get PROVIDER() {
    return getProvider();
  },
};

