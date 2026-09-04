/**
 * JWT signing/verification and HTTP-only session cookie configuration.
 */
const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'icash_session';
const TOKEN_TTL = '24h';

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set in .env');
  }
  return secret;
}

function signToken(payload) {
  return jwt.sign(payload, getSecret(), { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, getSecret());
  } catch (err) {
    return null;
  }
}

/**
 * Cookie options for the HTTP-only session cookie.
 * Secure is enabled outside local development so the cookie only
 * travels over HTTPS in production/staging.
 */
function getCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24h, matches TOKEN_TTL
    path: '/',
  };
}

function getClearCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: 0, // Force immediate expiry in browsers that respect maxAge
  };
}

module.exports = {
  COOKIE_NAME,
  signToken,
  verifyToken,
  getCookieOptions,
  getClearCookieOptions,
};
