const crypto = require('crypto');

const CSRF_SECRET =
  process.env.SESSION_SECRET ||
  process.env.JWT_SECRET ||
  'icash-secure-csrf-hmac-salt-key-2026';

const CSRF_COOKIE_NAME = '_icash_csrf';

/**
 * Generate a cryptographically signed CSRF token
 */
function createCsrfToken() {
  const salt = crypto.randomBytes(16).toString('hex');
  const hmac = crypto.createHmac('sha256', CSRF_SECRET).update(salt).digest('hex');
  return `${salt}.${hmac}`;
}

/**
 * Verify a cryptographically signed CSRF token
 */
function verifyCsrfToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [salt, receivedHmac] = parts;
  if (!salt || !receivedHmac) return false;

  const expectedHmac = crypto.createHmac('sha256', CSRF_SECRET).update(salt).digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(receivedHmac, 'hex'),
      Buffer.from(expectedHmac, 'hex')
    );
  } catch (e) {
    return false;
  }
}

/**
 * CSRF Protection Middleware
 * Defends all state-changing routes against Cross-Site Request Forgery.
 */
function csrfProtection(req, res, next) {
  // 1. Ensure client has a CSRF cookie
  let existingCookie = req.cookies ? req.cookies[CSRF_COOKIE_NAME] : null;
  if (!existingCookie || !verifyCsrfToken(existingCookie)) {
    const newToken = createCsrfToken();
    res.cookie(CSRF_COOKIE_NAME, newToken, {
      httpOnly: false, // Accessible by JavaScript client to send in X-CSRF-Token header
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });
    res.locals.csrfToken = newToken;
  } else {
    res.locals.csrfToken = existingCookie;
  }

  // 2. Safe HTTP methods skip token validation
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (safeMethods.includes(req.method.toUpperCase())) {
    return next();
  }

  // 3. Extract CSRF token from header or request body
  const submittedToken =
    req.headers['x-csrf-token'] ||
    req.headers['csrf-token'] ||
    req.headers['x-xsrf-token'] ||
    (req.body && req.body._csrf);

  // 4. Validate submitted token against cryptographic HMAC
  if (!submittedToken || !verifyCsrfToken(submittedToken)) {
    return res.status(403).json({
      ok: false,
      error: 'Forbidden',
      code: 'EBADCSRFTOKEN',
      message: 'Invalid or missing CSRF token. Please refresh your session.',
    });
  }

  next();
}

/**
 * Endpoint handler to explicitly fetch a fresh CSRF token
 */
function getCsrfTokenHandler(req, res) {
  let token = res.locals.csrfToken;
  if (!token || !verifyCsrfToken(token)) {
    token = createCsrfToken();
    res.cookie(CSRF_COOKIE_NAME, token, {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 24 * 60 * 60 * 1000,
    });
  }
  res.json({
    ok: true,
    csrfToken: token,
  });
}

module.exports = {
  csrfProtection,
  getCsrfTokenHandler,
  createCsrfToken,
  verifyCsrfToken,
};
