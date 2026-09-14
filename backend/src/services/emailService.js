/**
 * Email Service
 * Precise implementation of zahid-afridi/EmailVerfication Email.js dispatch service
 */
const { transporter, from } = require('../config/emailConfig');
const { Verification_Email_Template, Welcome_Email_Template } = require('./emailTemplate');

/**
 * Send 6-digit verification code to recipient email
 * @param {string} email
 * @param {string} verificationCode
 */
async function sendVerificationEmail(email, verificationCode) {
  try {
    const response = await transporter.sendMail({
      from,
      to: email,
      subject: 'Verify your Email — iCash Digital Banking',
      text: `Your iCash verification code is: ${verificationCode}. It is valid for 24 hours.`,
      html: Verification_Email_Template.replace('{verificationCode}', verificationCode),
    });
    console.log(`[iCash Email] Verification email sent successfully to ${email}`);
    return response;
  } catch (error) {
    console.error('[iCash Email] Error sending verification email:', error.message);
    throw error;
  }
}

/**
 * Send welcome email once email is verified
 * @param {string} email
 * @param {string} name
 */
async function sendWelcomeEmail(email, name) {
  try {
    const response = await transporter.sendMail({
      from,
      to: email,
      subject: 'Welcome to iCash Banking — Verification Complete',
      text: `Welcome to iCash, ${name}! Your email has been verified successfully.`,
      html: Welcome_Email_Template.replace('{name}', name || 'Customer'),
    });
    console.log(`[iCash Email] Welcome email sent successfully to ${email}`);
    return response;
  } catch (error) {
    console.error('[iCash Email] Error sending welcome email:', error.message);
    throw error;
  }
}

module.exports = {
  sendVerificationEmail,
  sendWelcomeEmail,
  // Alias functions matching exact identifiers from zahid-afridi/EmailVerfication
  sendVerificationEamil: sendVerificationEmail,
  senWelcomeEmail: sendWelcomeEmail,
};
