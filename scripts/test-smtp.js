/**
 * Test script for Gmail SMTP
 * Run: node scripts/test-smtp.js <recipient-email>
 */
require('dotenv').config();
const dns = require('dns');
const nodemailer = require('nodemailer');

// Force IPv4 before outbound SMTP connections are created so hosts/containers
// without IPv6 support do not fail with ENETUNREACH during DNS resolution.
try {
  if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch (e) {
  // Ignore unsupported runtime behavior; the per-connection family option below still applies.
}

const host = process.env.SMTP_HOST || 'smtp.gmail.com';
const isGmail = host.includes('gmail') || (process.env.SMTP_USER || '').endsWith('@gmail.com');
const port = isGmail ? 465 : (Number(process.env.SMTP_PORT) || 587);
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;
const recipient = process.argv[2] || user || 'shreyahalder013@gmail.com';
const fromSender = process.env.SMTP_FROM || user;

if (!user || !pass || pass === 'your-app-password') {
  console.error('\x1b[31m%s\x1b[0m', '❌ Error: SMTP_USER or SMTP_PASS is missing in .env');
  console.log('Please set in .env:\n  EMAIL_PROVIDER="smtp"\n  SMTP_USER="your-email@gmail.com"\n  SMTP_PASS="your-16-char-app-password"\n');
  process.exit(1);
}

console.log(`Connecting to Gmail SMTP server (${host}:${port})...`);
console.log(`- From: ${fromSender}`);
console.log(`- To: ${recipient}`);

const transporter = nodemailer.createTransport({
  host,
  port,
  secure: port === 465,
  family: 4, // Force IPv4 to prevent ENETUNREACH in environments without IPv6
  auth: { user, pass },
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 20000,
  tls: {
    rejectUnauthorized: false,
  },
});

async function run() {
  try {
    const info = await transporter.sendMail({
      from: fromSender.includes('<') ? fromSender : `"iCash Banking" <${fromSender}>`,
      to: recipient,
      subject: 'iCash - Gmail SMTP Verification Test',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;border:1px solid #e2e8f0;border-radius:8px">
          <h2 style="color:#0ea5e9;margin-top:0">iCash Banking</h2>
          <p>Congrats! Your Gmail SMTP integration is working perfectly.</p>
          <p style="font-size:14px;color:#64748b">Sent via Gmail SMTP at ${new Date().toISOString()}</p>
        </div>
      `,
    });

    console.log('\x1b[32m%s\x1b[0m', `✅ Email sent successfully via Gmail SMTP! Message ID: ${info.messageId}`);
  } catch (err) {
    console.error('\x1b[31m%s\x1b[0m', `❌ Gmail SMTP failed: ${err.message}`);
    process.exit(1);
  }
}

run();