const express = require('express');
const router = express.Router();
const {
  issueContactOtp,
  verifyContactOtp,
} = require('../services/contactOtpService');
const { authLimiter } = require('../middleware/rateLimitMiddleware');

/**
 * POST /api/otp/contact/send
 * Body: { contact }   — email address OR 10-digit mobile number
 *
 * `contact` must be the value the client just read from the form field at
 * submit-time. The server sends the OTP to exactly this value — there is no
 * server-side fallback to a stored/previous contact for the session or user.
 */
router.post('/send', authLimiter, async (req, res) => {
  const { contact } = req.body || {};

  if (!contact || typeof contact !== 'string' || !contact.trim()) {
    return res.status(400).json({ ok: false, error: 'An email address or mobile number is required.' });
  }

  try {
    const result = await issueContactOtp(contact);
    const response = {
      ok: true,
      contact: result.contact,
      type: result.type,
      expiresAt: result.expiresAt,
    };
    if (process.env.NODE_ENV === 'test' && result.devCode) {
      response.devCode = result.devCode;
    }
    return res.json(response);
  } catch (err) {
    console.error('[Contact OTP] Send failed:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message || 'Could not send verification code.',
    });
  }
});

/**
 * POST /api/otp/contact/verify
 * Body: { contact, code }
 *
 * Validates `code` against the OTP record keyed by `contact` — the same
 * value the client submitted to /send. Returns an opaque ticket bound to
 * that contact for use in /api/auth/register.
 */
router.post('/verify', authLimiter, (req, res) => {
  const { contact, code } = req.body || {};

  if (!contact || typeof contact !== 'string' || !contact.trim()) {
    return res.status(400).json({ ok: false, error: 'An email address or mobile number is required.' });
  }
  if (!code || String(code).trim().length !== 6) {
    return res.status(400).json({ ok: false, error: 'A 6-digit verification code is required.' });
  }

  const result = verifyContactOtp(contact, code);
  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.reason });
  }

  return res.json({ ok: true, ticket: result.ticket, contact: result.contact, type: result.type });
});

module.exports = router;
