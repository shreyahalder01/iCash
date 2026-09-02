/**
 * Contact OTP Service (email OR phone)
 *
 * Generates and verifies one-time codes sent to whatever contact value the
 * caller passes in — an email address or a 10-digit mobile number.
 *
 * IMPORTANT — the routing bug this module exists to prevent:
 *   The OTP must always be sent to the exact `contact` string the caller
 *   supplies on THIS call. This module never reads a stored/previous
 *   contact (e.g. from a user record, session, or a prior OTP request) to
 *   decide where to send the code. The contact value must be captured by
 *   the client at submit-time and passed straight through on every call:
 *     issueContactOtp(contact)         -> sends to `contact`, keyed by `contact`
 *     verifyContactOtp(contact, code)  -> looks up the record keyed by `contact`
 *   If the `contact` passed to verify doesn't match the `contact` passed to
 *   issue (byte-for-byte after normalization), verification fails — there is
 *   no cross-contact fallback lookup.
 *
 * Security properties:
 *  - No hardcoded bypass codes.
 *  - OTP codes are NOT returned in the verify response (only an opaque ticket).
 *  - Tickets are single-use (consumed on registration) and bound to the
 *    specific contact + type that was verified.
 *  - 5-attempt lockout per contact per OTP issuance.
 *  - 30-second minimum gap between resends per contact.
 */

const crypto = require('crypto');
const { sendOtpEmail, isDevMode: isEmailDevMode } = require('./emailProvider');
const { sendOtpSms, isDevMode: isSmsDevMode } = require('./smsProvider');

const OTP_TTL_MS = 5 * 60 * 1000;       // 5 minutes
const TICKET_TTL_MS = 15 * 60 * 1000;   // 15 minutes to complete registration after verifying
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 30 * 1000;   // 30 seconds between resends

const TICKET_SECRET = process.env.JWT_SECRET
  ? process.env.JWT_SECRET + ':contact-otp-ticket'
  : 'icash-contact-otp-ticket-secret-fallback';

// In-memory OTP store: normalizedContact → { code, expiresAt, attempts, lastSentAt, type }
const otpStore = new Map();

// In-memory consumed-ticket set: ticket → true (prevents replay within TTL window)
const usedTickets = new Set();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of otpStore.entries()) {
    if (now > v.expiresAt) otpStore.delete(k);
  }
}, 20 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Contact detection / normalization
// ---------------------------------------------------------------------------

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^\d{10}$/;

/**
 * Detects whether a submitted contact string is an email or a phone number
 * and returns its normalized form. Returns { ok: false } if neither matches.
 */
function detectContact(rawContact) {
  const contact = typeof rawContact === 'string' ? rawContact.trim() : '';

  if (EMAIL_REGEX.test(contact) && contact.length <= 254) {
    return { ok: true, type: 'email', normalized: contact.toLowerCase() };
  }

  const digitsOnly = contact.replace(/[\s\-()]/g, '').replace(/^\+?91/, '');
  if (PHONE_REGEX.test(digitsOnly)) {
    return { ok: true, type: 'phone', normalized: digitsOnly };
  }

  return { ok: false };
}

function generateCode() {
  const buf = crypto.randomBytes(3);
  const num = (buf.readUIntBE(0, 3) % 900000) + 100000;
  return String(num);
}

function signTicket(type, contact, issuedAt) {
  const payload = `${type}|${contact}|${issuedAt}`;
  const sig = crypto.createHmac('sha256', TICKET_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}|${sig}`).toString('base64url');
}

function verifyTicketInternal(ticket) {
  let decoded;
  try {
    decoded = Buffer.from(ticket, 'base64url').toString('utf8');
  } catch {
    return { ok: false, reason: 'Malformed verification ticket.' };
  }

  const parts = decoded.split('|');
  if (parts.length !== 4) return { ok: false, reason: 'Invalid verification ticket format.' };

  const [type, contact, issuedAtStr, receivedSig] = parts;
  const issuedAt = Number(issuedAtStr);

  if (!type || !contact || isNaN(issuedAt)) {
    return { ok: false, reason: 'Corrupt verification ticket.' };
  }

  if (Date.now() - issuedAt > TICKET_TTL_MS) {
    return { ok: false, reason: 'Verification ticket has expired. Please re-verify.' };
  }

  const expectedSig = crypto
    .createHmac('sha256', TICKET_SECRET)
    .update(`${type}|${contact}|${issuedAtStr}`)
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

  return { ok: true, type, contact };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Issue and send a 6-digit OTP to `rawContact` — the value the caller
 * captured directly from the form field at submit-time. This function does
 * not accept or consult any stored/default contact; whatever is passed here
 * is exactly where the code is sent.
 *
 * Returns { expiresAt, contact, type, devCode? }.
 */
async function issueContactOtp(rawContact) {
  const detected = detectContact(rawContact);
  if (!detected.ok) {
    throw new Error('Enter a valid email address or 10-digit mobile number.');
  }
  const { type, normalized } = detected;

  const existing = otpStore.get(normalized);
  if (existing && Date.now() - existing.lastSentAt < RESEND_COOLDOWN_MS) {
    const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - existing.lastSentAt)) / 1000);
    throw new Error(`Please wait ${waitSec}s before requesting another code.`);
  }

  const code = generateCode();
  const expiresAt = Date.now() + OTP_TTL_MS;

  // Keyed by the exact normalized contact just supplied — no lookup of any
  // previously stored value happens anywhere in this function.
  otpStore.set(normalized, {
    code,
    expiresAt,
    attempts: 0,
    lastSentAt: Date.now(),
    type,
  });

  const devMode = type === 'email' ? isEmailDevMode() : isSmsDevMode();

  try {
    if (type === 'email') {
      await sendOtpEmail(normalized, code);
    } else {
      await sendOtpSms(normalized, code);
    }
  } catch (sendErr) {
    console.error(`[ContactOTP] ${type} delivery failed for ${normalized}:`, sendErr.message);
    if (!devMode) {
      otpStore.delete(normalized);
      throw new Error(`${type === 'email' ? 'Email' : 'SMS'} delivery failed: ${sendErr.message}`);
    }
  }

  const result = { expiresAt, contact: normalized, type };
  if (devMode) {
    result.devCode = code;
  }
  return result;
}

/**
 * Verify a submitted OTP code against `rawContact` — again, exactly the
 * value the caller captured at submit-time. The lookup is keyed solely by
 * this contact string; there is no fallback to any other contact.
 */
function verifyContactOtp(rawContact, code) {
  const detected = detectContact(rawContact);
  if (!detected.ok) {
    return { ok: false, reason: 'Enter a valid email address or 10-digit mobile number.' };
  }
  const { type, normalized } = detected;
  const cleanCode = String(code || '').trim();

  const record = otpStore.get(normalized);
  if (!record) {
    return { ok: false, reason: 'No active OTP was requested for this contact.' };
  }

  if (Date.now() > record.expiresAt) {
    otpStore.delete(normalized);
    return { ok: false, reason: 'OTP has expired. Please request a new code.' };
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    otpStore.delete(normalized);
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

  otpStore.delete(normalized);
  const issuedAt = Date.now();
  const ticket = signTicket(type, normalized, issuedAt);

  return { ok: true, ticket, contact: normalized, type };
}

/**
 * Validate and consume a verification ticket during registration. Returns
 * { ok: true, contact, type } on success. The caller (registration
 * endpoint) should confirm `contact` matches the contact field the user is
 * registering with, so a ticket for one contact can never authorize a
 * different one.
 */
function consumeContactVerificationTicket(ticket) {
  const result = verifyTicketInternal(ticket);
  if (!result.ok) return result;
  usedTickets.add(ticket);
  return { ok: true, contact: result.contact, type: result.type };
}

module.exports = {
  detectContact,
  issueContactOtp,
  verifyContactOtp,
  consumeContactVerificationTicket,
};
