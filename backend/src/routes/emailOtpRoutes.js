const express = require('express');
const router = express.Router();
const { issueEmailOtp, verifyEmailOtp, isDevMode, PROVIDER } = require('../services/emailOtpService');
const { authLimiter } = require('../middleware/rateLimitMiddleware');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_REGEX.test(email) && email.length <= 254;
}

/**
 * POST /api/otp/email/send
 * Body: { email }
 * Sends a 6-digit OTP to the provided email address.
 */
router.post('/send', authLimiter, async (req, res) => {
  const { email } = req.body || {};

  if (!isValidEmail(email)) {
    return res.status(400).json({ ok: false, error: 'A valid email address is required.' });
  }

  try {
    const result = await issueEmailOtp(email);
    const response = {
      ok: true,
      expiresAt: result.expiresAt,
    };
    // Only exposed during automated test suite execution (Jest)
    if (process.env.NODE_ENV === 'test' && result.devCode) {
      response.devCode = result.devCode;
    }
    return res.json(response);
  } catch (err) {
    console.error('[Email OTP] Send failed:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message || 'Could not send verification email. Please check server SMTP configuration.',
    });
  }
});

/**
 * POST /api/otp/email/verify
 * Body: { email, code }
 * Returns { ok: true, ticket } on success — the ticket must be passed to /api/auth/register.
 */
router.post('/verify', authLimiter, (req, res) => {
  const { email, code } = req.body || {};

  if (!isValidEmail(email)) {
    return res.status(400).json({ ok: false, error: 'A valid email address is required.' });
  }
  if (!code || String(code).trim().length !== 6) {
    return res.status(400).json({ ok: false, error: 'A 6-digit verification code is required.' });
  }

  const result = verifyEmailOtp(email, code);
  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.reason });
  }

  // Return the opaque ticket — the client must pass this to /api/auth/register
  return res.json({ ok: true, ticket: result.ticket });
});

/**
 * GET /api/otp/email/health
 * Diagnostic check for email provider configuration on deployment
 */
router.get('/health', (req, res) => {
  const provider = (process.env.EMAIL_PROVIDER || 'console').toLowerCase().trim();
  const isSmtp = provider === 'smtp';
  const isResend = provider === 'resend';
  res.json({
    ok: true,
    provider,
    configured: isSmtp
      ? Boolean(process.env.SMTP_USER && process.env.SMTP_PASS)
      : isResend
        ? Boolean(process.env.RESEND_API_KEY)
        : true,
    smtpUserConfigured: Boolean(process.env.SMTP_USER),
    smtpPassConfigured: Boolean(process.env.SMTP_PASS),
  });
});

module.exports = router;
