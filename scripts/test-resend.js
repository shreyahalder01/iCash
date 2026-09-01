/**
 * Standalone test script for Resend API
 * Run: node scripts/test-resend.js <your-email@example.com>
 */
require('dotenv').config();
const { Resend } = require('resend');

const apiKey = process.env.RESEND_API_KEY;
const recipient = process.argv[2] || 'shreyahalder013@gmail.com';
const fromSender = process.env.RESEND_FROM || process.env.EMAIL_FROM || 'onboarding@resend.dev';

if (!apiKey || apiKey.startsWith('re_xxxxxxxxx')) {
  console.error('\x1b[31m%s\x1b[0m', '❌ Error: RESEND_API_KEY is not set or still has the placeholder in .env');
  console.log('Please set your real API key in .env:\n  RESEND_API_KEY="re_123456..."\n');
  process.exit(1);
}

console.log(`Sending test email via Resend...`);
console.log(`- From: ${fromSender}`);
console.log(`- To: ${recipient}`);

const resend = new Resend(apiKey);

async function run() {
  try {
    const { data, error } = await resend.emails.send({
      from: fromSender.includes('<') ? fromSender : `iCash Banking <${fromSender}>`,
      to: recipient,
      subject: 'iCash - Resend Verification Test',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;border:1px solid #e2e8f0;border-radius:8px">
          <h2 style="color:#0ea5e9;margin-top:0">iCash Banking</h2>
          <p>Congrats! Your Resend API integration is working perfectly.</p>
          <p style="font-size:14px;color:#64748b">Timestamp: ${new Date().toISOString()}</p>
        </div>
      `,
    });

    if (error) {
      console.error('\x1b[31m%s\x1b[0m', `❌ Resend error: ${error.message || JSON.stringify(error)}`);
      process.exit(1);
    }

    console.log('\x1b[32m%s\x1b[0m', `✅ Email sent successfully! Message ID: ${data.id}`);
  } catch (err) {
    console.error('\x1b[31m%s\x1b[0m', `❌ Failed: ${err.message}`);
    process.exit(1);
  }
}

run();
