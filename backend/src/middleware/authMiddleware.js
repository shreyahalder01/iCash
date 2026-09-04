const { verifyToken, COOKIE_NAME } = require('../utils/token');
const prisma = require('../prisma');

/**
 * Authentication middleware that verifies JWT from HTTP-only cookie or Authorization header.
 * Attaches the authenticated user database record to req.user.
 */
async function authenticate(req, res, next) {
  try {
    let token = null;

    // Check HTTP-only cookie first
    if (req.cookies && req.cookies[COOKIE_NAME]) {
      token = req.cookies[COOKIE_NAME];
    }
    // Fall back to Authorization: Bearer <token>
    else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        ok: false,
        error: 'Unauthorized',
        message: 'Your secure session has expired. Please authenticate again.',
      });
    }

    const decoded = verifyToken(token);
    if (!decoded || !decoded.userId) {
      return res.status(401).json({
        ok: false,
        error: 'Unauthorized',
        message: 'Your secure session has expired. Please authenticate again.',
      });
    }

    // Verify the backing session when present. Tokens issued by this backend always
    // carry a session reference; accepting old tokens without one preserves
    // compatibility with already-issued tokens while they naturally expire.
    if (decoded.sessionReference) {
      const session = await prisma.loginSession.findUnique({
        where: { session_reference: decoded.sessionReference },
      });
      if (!session || session.user_id !== decoded.userId || session.revoked_at || session.expires_at <= new Date()) {
        return res.status(401).json({
          ok: false,
          error: 'Unauthorized',
          message: 'Your secure session has expired. Please authenticate again.',
        });
      }
      req.sessionReference = session.session_reference;
    }

    // Verify user exists and check lock status
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: {
        accounts: {
          where: { status: 'ACTIVE' },
          orderBy: { is_primary: 'desc' },
        },
        biometric_profile: true,
        merchant_profile: true,
      },
    });

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: 'Unauthorized',
        message: 'Account not found. Please log in again.',
      });
    }

    // Check account status
    if (user.status === 'LOCKED' || (user.locked_until && user.locked_until > new Date())) {
      return res.status(403).json({
        ok: false,
        error: 'AccountLocked',
        message: 'For your protection, access to this account has been temporarily restricted.',
      });
    }

    if (user.status === 'SUSPENDED') {
      return res.status(403).json({
        ok: false,
        error: 'AccountSuspended',
        message: 'This account is currently suspended. Please contact bank support.',
      });
    }

    // Attach user (without sensitive password hashes) to request object
    req.user = user;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    return res.status(500).json({
      ok: false,
      error: 'ServerError',
      message: "We're unable to connect to banking services right now. Please try again.",
    });
  }
}

module.exports = {
  authenticate,
};
