const nodemailer = require('nodemailer');

const host = process.env.SMTP_HOST || 'smtp.gmail.com';
const port = Number(process.env.SMTP_PORT) || 587;
const secure = process.env.SMTP_SECURE === 'true' || port === 465;
const user = process.env.SMTP_USER || process.env.EMAIL_USER;
const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS;
const from = process.env.EMAIL_FROM || '"iCash Digital Banking" <noreply@icash.bank>';

let transporter;

if (user && pass && process.env.NODE_ENV !== 'test') {
  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass,
    },
  });
} else {
  // Graceful fallback for local development and test environments
  transporter = {
    sendMail: async (options) => {
      console.log(`\n============================================================`);
      console.log(`📧 [EMAIL DISPATCH] To: ${options.to}`);
      console.log(`   Subject: ${options.subject}`);
      if (options.text) {
        console.log(`   Message: ${options.text}`);
      }
      console.log(`============================================================\n`);
      return {
        messageId: `mock-${Date.now()}@icash.local`,
        accepted: [options.to],
        response: '250 Mock Email Dispatched OK',
      };
    },
  };
}

module.exports = {
  transporter,
  from,
};
