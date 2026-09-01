/**
 * Registration OTP flow — email OR phone.
 *
 * Fixes the "OTP routed to wrong contact" class of bug by following one
 * rule everywhere in this file: the contact value is read from the input
 * field INSIDE the submit handler, at the moment of submission, and that
 * exact string is threaded through send -> verify -> register. It is never
 * read once and cached in an outer variable that could later go stale, and
 * there is never a fallback to `currentUser.email`, `localStorage`, or any
 * other stored value.
 *
 * Requires window.iCashApi (see frontend/api.js) with:
 *   sendContactOtp(contact)          -> { ok, contact, type, expiresAt, devCode? }
 *   verifyContactOtp(contact, code)  -> { ok, ticket, contact, type }
 *
 * Markup expected (ids are configurable via the `ids` option to mount()):
 *   <input id="reg-contact" />                 // email or phone input
 *   <button id="reg-submit-btn">Continue</button>
 *   <div id="reg-contact-error"></div>
 *
 *   <div id="otp-contact-display"></div>        // shows masked contact
 *   <input id="otp-code-input" />
 *   <button id="otp-verify-btn">Verify</button>
 *   <button id="otp-resend-btn">Resend code</button>
 *   <div id="otp-countdown"></div>
 *   <div id="otp-error"></div>
 */

function createRegistrationOtpFlow(ids = {}) {
  const el = {
    contactInput: document.getElementById(ids.contactInput || 'reg-contact'),
    submitBtn: document.getElementById(ids.submitBtn || 'reg-submit-btn'),
    contactError: document.getElementById(ids.contactError || 'reg-contact-error'),

    contactDisplay: document.getElementById(ids.contactDisplay || 'otp-contact-display'),
    codeInput: document.getElementById(ids.codeInput || 'otp-code-input'),
    verifyBtn: document.getElementById(ids.verifyBtn || 'otp-verify-btn'),
    resendBtn: document.getElementById(ids.resendBtn || 'otp-resend-btn'),
    countdown: document.getElementById(ids.countdown || 'otp-countdown'),
    otpError: document.getElementById(ids.otpError || 'otp-error'),
  };

  // The ONLY place the verified contact + ticket live between steps. Both
  // fields are set together, from the same server response, every time —
  // never independently, and never pre-populated from a stored profile.
  let session = { contact: null, type: null, ticket: null, expiresAt: null };
  let countdownTimer = null;
  let resendCooldownUntil = 0;

  function maskContact(contact, type) {
    if (type === 'email') {
      const [local, domain] = contact.split('@');
      if (!local || !domain) return contact;
      const visible = local.slice(0, Math.min(2, local.length));
      return `${visible}${'*'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
    }
    // phone: show last 2 digits only
    return `${'*'.repeat(Math.max(contact.length - 2, 0))}${contact.slice(-2)}`;
  }

  function setError(node, message) {
    if (!node) return;
    node.textContent = message || '';
  }

  function startCountdown(expiresAt) {
    clearInterval(countdownTimer);
    const tick = () => {
      const remainingMs = expiresAt - Date.now();
      if (remainingMs <= 0) {
        clearInterval(countdownTimer);
        if (el.countdown) el.countdown.textContent = 'Code expired — request a new one.';
        return;
      }
      const s = Math.ceil(remainingMs / 1000);
      if (el.countdown) {
        el.countdown.textContent = `Code expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      }
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  /**
   * Step 1: user submits the registration form. `contact` is read directly
   * from the input's current .value right here — nothing upstream of this
   * function is trusted to have already captured it correctly.
   */
  async function handleSubmit(evt) {
    if (evt) evt.preventDefault();
    setError(el.contactError, '');

    const contact = (el.contactInput?.value || '').trim();
    if (!contact) {
      setError(el.contactError, 'Enter your email address or mobile number.');
      el.contactInput?.focus();
      return;
    }

    if (el.submitBtn) el.submitBtn.disabled = true;
    try {
      // `contact` — the value just read above — is sent verbatim. The
      // server keys the OTP record by this exact string and sends the
      // code to it; see contactOtpService.issueContactOtp.
      const res = await window.iCashApi.sendContactOtp(contact);

      // Session state is populated only from this response, using the
      // `contact`/`type` the server confirms it sent to — not from the
      // local `contact` variable and not from any prior session.
      session = { contact: res.contact, type: res.type, ticket: null, expiresAt: res.expiresAt };

      if (el.contactDisplay) {
        el.contactDisplay.textContent = maskContact(res.contact, res.type);
      }
      if (el.codeInput) el.codeInput.value = '';
      setError(el.otpError, '');
      resendCooldownUntil = Date.now() + 30 * 1000;
      startCountdown(res.expiresAt);

      if (res.devCode) {
        console.info(`[DEV] OTP for ${res.contact}: ${res.devCode}`);
      }
    } catch (err) {
      setError(el.contactError, err.message || 'Failed to send verification code.');
    } finally {
      if (el.submitBtn) el.submitBtn.disabled = false;
    }
  }

  /**
   * Step 2: verify the code against session.contact — the contact the
   * server told us it actually sent to in Step 1, not a re-read of the
   * (possibly since-edited) form field.
   */
  async function handleVerify(evt) {
    if (evt) evt.preventDefault();
    setError(el.otpError, '');

    if (!session.contact) {
      setError(el.otpError, 'Please request a code first.');
      return;
    }

    const code = (el.codeInput?.value || '').trim();
    if (!/^\d{6}$/.test(code)) {
      setError(el.otpError, 'Enter the 6-digit code.');
      return;
    }

    if (el.verifyBtn) el.verifyBtn.disabled = true;
    try {
      const res = await window.iCashApi.verifyContactOtp(session.contact, code);
      session.ticket = res.ticket;
      clearInterval(countdownTimer);
      return { contact: res.contact, type: res.type, ticket: res.ticket };
    } catch (err) {
      setError(el.otpError, err.message || 'Verification failed.');
      return null;
    } finally {
      if (el.verifyBtn) el.verifyBtn.disabled = false;
    }
  }

  /**
   * Resend: re-sends to session.contact (the confirmed, already-sent-to
   * value from Step 1) — not a fresh read of the input, so an accidental
   * edit to the field after Step 1 can't silently redirect the resend.
   * If the user wants to change the contact, they must go back to Step 1.
   */
  async function handleResend() {
    setError(el.otpError, '');
    if (!session.contact) return;

    if (Date.now() < resendCooldownUntil) {
      const waitSec = Math.ceil((resendCooldownUntil - Date.now()) / 1000);
      setError(el.otpError, `Please wait ${waitSec}s before resending.`);
      return;
    }

    if (el.resendBtn) el.resendBtn.disabled = true;
    try {
      const res = await window.iCashApi.sendContactOtp(session.contact);
      session.expiresAt = res.expiresAt;
      resendCooldownUntil = Date.now() + 30 * 1000;
      startCountdown(res.expiresAt);
      if (res.devCode) {
        console.info(`[DEV] Resent OTP for ${res.contact}: ${res.devCode}`);
      }
    } catch (err) {
      setError(el.otpError, err.message || 'Failed to resend code.');
    } finally {
      if (el.resendBtn) el.resendBtn.disabled = false;
    }
  }

  el.submitBtn?.addEventListener('click', handleSubmit);
  el.verifyBtn?.addEventListener('click', handleVerify);
  el.resendBtn?.addEventListener('click', handleResend);

  return {
    handleSubmit,
    handleVerify,
    handleResend,
    // For the caller (e.g. the final "Create account" step) to read the
    // verified contact + ticket to attach to the /api/auth/register call.
    getVerifiedContact: () => (session.ticket ? { contact: session.contact, type: session.type, ticket: session.ticket } : null),
    destroy: () => clearInterval(countdownTimer),
  };
}

if (typeof window !== 'undefined') {
  window.createRegistrationOtpFlow = createRegistrationOtpFlow;
}
