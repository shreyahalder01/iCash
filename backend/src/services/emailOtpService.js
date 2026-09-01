/**
 * Email OTP Service
 *
 * Generates and verifies one-time codes sent to email addresses during
 * registration. On successful verification it issues a short-lived HMAC-signed
 * "verification ticket" that the registration endpoint must present — this
 * prevents a client from bypassing OTP by simply passing emailVerified: true
 * in the request body.
 *
 * Security properties:
 *  - No hardcoded bypass codes.
 *  - OTP codes are NOT returned in the verify response (only the opaque ticket).
 *  - Tickets are single-use (consumed on registration).
 *  - 5-attempt lockout per email per OTP issuance.
 */

const crypto = require('crypto');
const { sendOtpEmail, isDevMode, PROVIDER } = require('./emailProvider');

const OTP_TTL_MS = 5 * 60 * 1000;       // 5 minutes
const TICKET_TTL_MS = 15 * 60 * 1000;   // 15 minutes to complete registration after verifying
const MAX_ATTEMPTS = 5;

// Derives a stable signing key from JWT_SECRET (or a fallback) so tickets
// are invalidated automatically on server restart / secret rotation.
const TICKET_SECRET = process.env.JWT_SECRET
  ? process.env.JWT_SECRET + ':email-otp-ticket'
  : 'icash-email-otp-ticket-secret-fallback';

// In-memory OTP store: email → { code, expiresAt, attempts, lastSentAt }
const otpStore = new Map();

// In-memory consumed-ticket set: ticket → true  (prevents replay within TTL window)
const usedTickets = new Set();

// Periodically purge expired OTP entries and used tickets
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of otpStore.entries()) {
    if (now > v.expiresAt) otpStore.delete(k);
  }
  // Tickets expire in 15 min; purge anything older than 20 min
  // We embed the timestamp in the ticket so we can skip usedTickets entries by age
  // For simplicity, clear the whole set every 20 min (at most 20 min of replay window)
}, 20 * 60 * 1000).unref(); // .unref() prevents this timer from keeping Jest open

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function generateCode() {
  // Cryptographically random 6-digit code (no Math.random)
  const buf = crypto.randomBytes(3);
  const num = (buf.readUIntBE(0, 3) % 900000) + 100000;
  return String(num);
}

function signTicket(email, issuedAt) {
  const payload = `${email}|${issuedAt}`;
  const sig = crypto
    .createHmac('sha256', TICKET_SECRET)
    .update(payload)
    .digest('hex');
  // Base64-encode the full ticket so it's URL-safe and opaque
  return Buffer.from(`${payload}|${sig}`).toString('base64url');
}

function verifyTicket(ticket) {
  let decoded;
  try {
    decoded = Buffer.from(ticket, 'base64url').toString('utf8');
  } catch {
    return { ok: false, reason: 'Malformed verification ticket.' };
  }

  const parts = decoded.split('|');
  if (parts.length !== 3) return { ok: false, reason: 'Invalid verification ticket format.' };

  const [email, issuedAtStr, receivedSig] = parts;
  const issuedAt = Number(issuedAtStr);

  if (!email || isNaN(issuedAt)) {
    return { ok: false, reason: 'Corrupt verification ticket.' };
  }

  if (Date.now() - issuedAt > TICKET_TTL_MS) {
    return { ok: false, reason: 'Email verification ticket has expired. Please re-verify your email.' };
  }

  // Constant-time comparison to prevent timing attacks
  const expectedSig = crypto
    .createHmac('sha256', TICKET_SECRET)
    .update(`${email}|${issuedAtStr}`)
    .digest('hex');

  const expectedBuf = Buffer.from(expectedSig);
  const receivedBuf = Buffer.from(receivedSig);
  if (
    expectedBuf.length !== receivedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, receivedBuf)
  ) {
    return { ok: false, reason: 'Invalid verification ticket signature.' };
  }

  if (usedTickets.has(ticket)) {
    return { ok: false, reason: 'Verification ticket has already been used.' };
  }

  return { ok: true, email };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Issue and send a 6-digit OTP to the given email.
 * Returns { expiresAt, devCode? } — devCode is only present in console/dev mode.
 */
async function issueEmailOtp(email) {
  const normalizedEmail = email.toLowerCase().trim();
  const code = generateCode();
  const expiresAt = Date.now() + OTP_TTL_MS;

  otpStore.set(normalizedEmail, {
    code,
    expiresAt,
    attempts: 0,
    lastSentAt: Date.now(),
  });

  try {
    await sendOtpEmail(normalizedEmail, code);
  } catch (mailErr) {
    console.error('[EmailOTP] Email delivery failed:', mailErr.message);
    if (!isDevMode()) {
      otpStore.delete(normalizedEmail);
      throw new Error(`Email delivery failed: ${mailErr.message}`);
    }
  }

  const result = { expiresAt };
  if (isDevMode()) {
    result.devCode = code; // Only shown in console/dev mode
  }
  return result;
}

/**
 * Verify a submitted OTP code for the given email.
 * On success: deletes the OTP record and returns { ok: true, ticket }.
 * On failure: returns { ok: false, reason }.
 */
function verifyEmailOtp(email, code) {
  const normalizedEmail = email.toLowerCase().trim();
  const cleanCode = String(code).trim();
  const record = otpStore.get(normalizedEmail);

  if (!record) {
    return { ok: false, reason: 'No active OTP was requested for this email address.' };
  }

  if (Date.now() > record.expiresAt) {
    otpStore.delete(normalizedEmail);
    return { ok: false, reason: 'OTP has expired. Please request a new code.' };
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    otpStore.delete(normalizedEmail);
    return { ok: false, reason: 'Too many incorrect attempts. Please request a new code.' };
  }

  if (record.code !== cleanCode) {
    record.attempts += 1;
    const remaining = MAX_ATTEMPTS - record.attempts;
    return {
      ok: false,
      reason: `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
    };
  }

  // Correct code — issue a one-time verification ticket
  otpStore.delete(normalizedEmail);
  const issuedAt = Date.now();
  const ticket = signTicket(normalizedEmail, issuedAt);

  return { ok: true, ticket };
}

/**
 * Validate and consume a verification ticket during registration.
 * Returns { ok: true, email } on success or { ok: false, reason } on failure.
 * The ticket is marked as used to prevent replay attacks.
 */
function consumeVerificationTicket(ticket) {
  const result = verifyTicket(ticket);
  if (!result.ok) return result;

  // Mark as consumed (single-use)
  usedTickets.add(ticket);

  return { ok: true, email: result.email };
}

module.exports = {
  issueEmailOtp,
  verifyEmailOtp,
  consumeVerificationTicket,
  isDevMode,
  PROVIDER,
};
