/**
 * In-memory OTP store.
 *
 * Good enough for a demo / single-instance server. If you deploy this
 * with more than one server instance, or want OTPs to survive a
 * restart, swap this for Redis or a database table keyed the same way.
 */

const OTP_TTL_MS = 5 * 60 * 1000;      // OTP valid for 5 minutes
const RESEND_COOLDOWN_MS = 30 * 1000;   // must wait 30s between sends
const MAX_ATTEMPTS = 5;                 // wrong-code guesses allowed per OTP

const store = new Map(); // key: `${purpose}:${mobile}` -> { code, expiresAt, attempts, lastSentAt }

function key(purpose, mobile) {
  return `${purpose}:${mobile}`;
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * Returns { code, expiresAt } on success, or throws an Error with
 * .code = 'COOLDOWN' if called again too soon (resend spam protection).
 */
function issue(purpose, mobile) {
  const k = key(purpose, mobile);
  const existing = store.get(k);
  if (existing && Date.now() - existing.lastSentAt < RESEND_COOLDOWN_MS) {
    const err = new Error('Please wait before requesting another OTP.');
    err.code = 'COOLDOWN';
    err.retryAfterMs = RESEND_COOLDOWN_MS - (Date.now() - existing.lastSentAt);
    throw err;
  }
  const code = generateCode();
  const record = { code, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0, lastSentAt: Date.now() };
  store.set(k, record);
  return { code, expiresAt: record.expiresAt };
}

/**
 * Returns { ok: true } or { ok: false, reason } — never throws for
 * normal wrong-code / expired cases, so callers can respond cleanly.
 */
function verify(purpose, mobile, code) {
  const k = key(purpose, mobile);
  const record = store.get(k);
  if (!record) return { ok: false, reason: 'No OTP was requested for this number.' };
  if (Date.now() > record.expiresAt) {
    store.delete(k);
    return { ok: false, reason: 'OTP expired. Request a new one.' };
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    store.delete(k);
    return { ok: false, reason: 'Too many incorrect attempts. Request a new OTP.' };
  }
  if (record.code !== String(code)) {
    record.attempts += 1;
    return { ok: false, reason: 'Incorrect OTP.' };
  }
  store.delete(k); // one-time use
  return { ok: true };
}

module.exports = { issue, verify, OTP_TTL_MS, RESEND_COOLDOWN_MS };
