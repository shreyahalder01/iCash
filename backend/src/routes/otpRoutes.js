const express = require('express');
const router = express.Router();
const { issueOtp, verifyOtp, isDevMode, PROVIDER } = require('../services/otpService');
const { authLimiter } = require('../middleware/rateLimitMiddleware');

function isValidMobile(mobile) {
  return typeof mobile === 'string' && /^\d{10}$/.test(mobile);
}
function isValidPurpose(purpose) {
  return purpose === 'register' || purpose === 'login';
}

router.post('/send', authLimiter, async (req, res) => {
  const { mobile, purpose } = req.body || {};
  if (!isValidMobile(mobile)) return res.status(400).json({ ok: false, error: 'Mobile must be a 10-digit number.' });
  if (!isValidPurpose(purpose)) return res.status(400).json({ ok: false, error: 'Purpose must be "register" or "login".' });

  try {
    const result = await issueOtp(purpose, mobile);
    res.json({
      ok: true,
      expiresAt: result.expiresAt,
      devMode: result.devMode,
      code: result.code,
      devCode: result.code
    });
  } catch (err) {
    if (err.code === 'COOLDOWN') {
      return res.status(429).json({ ok: false, error: err.message, retryAfterMs: err.retryAfterMs });
    }
    console.error('OTP send failed:', err.message);
    res.status(502).json({ ok: false, error: 'Could not send OTP. Try again shortly.' });
  }
});

router.post('/verify', authLimiter, (req, res) => {
  const { mobile, purpose, code } = req.body || {};
  if (!isValidMobile(mobile)) return res.status(400).json({ ok: false, error: 'Mobile must be a 10-digit number.' });
  if (!isValidPurpose(purpose)) return res.status(400).json({ ok: false, error: 'Purpose must be "register" or "login".' });
  if (!code) return res.status(400).json({ ok: false, error: 'Code is required.' });

  const result = verifyOtp(purpose, mobile, code);
  if (!result.ok) return res.status(400).json(result);
  res.json({ ok: true });
});

router.get('/health', (req, res) => {
  res.json({ ok: true, provider: PROVIDER, devMode: isDevMode() });
});

module.exports = router;
