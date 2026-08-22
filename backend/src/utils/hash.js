/**
 * Credential Hashing Utility
 * Used for PINs, emergency duress PINs, and delegation OTPs.
 * 12 salt rounds, matching prisma/seed.js.
 */
const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 12;

async function hashValue(value) {
  return bcrypt.hash(String(value), SALT_ROUNDS);
}

async function compareValue(value, hash) {
  if (!hash) return false;
  return bcrypt.compare(String(value), hash);
}

module.exports = { hashValue, compareValue };
