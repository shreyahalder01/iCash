const rateLimit = require('express-rate-limit');

// Strict rate limiter for auth/login endpoints to prevent brute-force attacks
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'test' ? 1000 : 25, // limit each IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: 'TooManyRequests',
    message: 'Too many authentication attempts. Please wait 15 minutes before trying again.',
  },
});

// Sensitive transactions rate limiter
const transactionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: process.env.NODE_ENV === 'test' ? 1000 : 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: 'TooManyRequests',
    message: 'Rate limit exceeded for financial operations. Please wait a few minutes.',
  },
});

const emergencyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 1000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: 'TooManyRequests',
    message: 'Too many emergency authorization attempts. Please try again later.',
  },
});

// General API rate limiter
const generalApiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: process.env.NODE_ENV === 'test' ? 5000 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: 'TooManyRequests',
    message: 'Too many requests. Please slow down.',
  },
});

module.exports = {
  authLimiter,
  transactionLimiter,
  emergencyLimiter,
  generalApiLimiter,
};
