/**
 * iCash Enterprise Biometric Banking Client Engine
 * Integrates with Beautiful UI component primitives, FaceAPI, and real backend REST API.
 */

// Global State (exposed on window for cross-module integration)
window.currentUser = null;
window.pendingLoginUser = null;
let currentUser = null;
let currentAccounts = [];
let currentTransactions = [];
let filteredTransactions = [];
let currentFilterType = 'ALL';
let currentSearchQuery = '';
let currentPage = 1;
const ITEMS_PER_PAGE = 6;
let isBalanceHidden = false;

function setCurrentUser(user) {
  currentUser = user;
  window.currentUser = user;
  if (user && typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem('icash_current_user', JSON.stringify(user));
    } catch (e) {}
  }
}
window.setCurrentUser = setCurrentUser;

function getCurrentUser() {
  if (currentUser) return currentUser;
  if (window.currentUser) {
    currentUser = window.currentUser;
    return currentUser;
  }
  if (typeof localStorage !== 'undefined') {
    try {
      const cached = localStorage.getItem('icash_current_user');
      if (cached) {
        currentUser = JSON.parse(cached);
        window.currentUser = currentUser;
        return currentUser;
      }
    } catch (e) {}
  }
  return null;
}
window.getCurrentUser = getCurrentUser;

// (Biometric state managed by biometric.js)

// Active verification session
let pendingVerificationAction = null;
let pendingLoginUser = null;
let pendingOtp = null;
let otpCountdownTimer = null;
let otpResendTimer = null;
const OTP_DIGIT_IDS = ['od0', 'od1', 'od2', 'od3', 'od4', 'od5'];

// Appwrite Web SDK Initialization
let appwriteClient = null;
let appwriteAccount = null;
let appwriteDatabases = null;

function initAppwrite() {
  try {
    if (typeof Appwrite !== 'undefined' && window.AppwriteLib) {
      // Delegate to lib/appwrite.js which holds all config and auto-pings.
      const result = window.AppwriteLib.initAppwriteClient();
      if (result) {
        appwriteClient = result.client;
        appwriteAccount = result.account;
        appwriteDatabases = result.databases;
      }
    }
  } catch (err) {
    console.warn('[Appwrite] Client initialization notice:', err);
  }
}

// ============================================================
// INITIALIZATION & EVENT LISTENERS
// ============================================================
window.addEventListener('DOMContentLoaded', async () => {
  initOtpDigitInputs();
  initCommandPaletteShortcuts();
  initThreeBackground();
  initAppwrite();

  // Restore stored user if available
  getCurrentUser();

  // Check if server session exists
  try {
    const session = await window.iCashApi.getMe();
    if (session.ok && session.user) {
      setCurrentUser(session.user);
      enterDashboard();
    }
  } catch (e) {
    // Guest mode
  }
});

// ============================================================
// VIEW NAVIGATION & ROUTING
// ============================================================
function goTo(screenId) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  const target = document.getElementById(screenId);
  if (target) {
    target.classList.add('active');
    window.scrollTo(0, 0);
  }
}
window.goTo = goTo;

function switchView(viewName) {
  // Update sidebar active nav item
  document
    .querySelectorAll('.app-sidebar .nav-item')
    .forEach((btn) => btn.classList.remove('active'));
  const activeNav = document.getElementById(`nav-item-${viewName}`);
  if (activeNav) activeNav.classList.add('active');

  // Update content portal view
  document.querySelectorAll('.portal-view').forEach((v) => v.classList.remove('active'));
  const targetView = document.getElementById(`view-${viewName}`);
  if (targetView) targetView.classList.add('active');

  // Update Top Navbar Titles
  const titles = {
    dashboard: { title: 'Dashboard', sub: 'Your complete financial overview' },
    accounts: { title: 'Account Portfolio', sub: 'Manage linked savings, current & virtual cards' },
    transfers: { title: 'Transfer Funds', sub: 'Instant biometric-authorized fund transfers' },
    transactions: {
      title: 'Transaction Ledger',
      sub: 'Search, filter and audit all transaction records',
    },
    payments: { title: 'Payments & Bills', sub: 'Point of sale checkouts & utilities' },
    security: {
      title: 'Biometric Security Hub',
      sub: '128D neural vector status & active sessions',
    },
    support: { title: 'Help & Grievances', sub: 'Customer protection & dispute resolution' },
    profile: {
      title: 'Profile & Settings',
      sub: 'Customer identity, e-KYC reference & preferences',
    },
  };

  const meta = titles[viewName] || { title: 'Banking Portal', sub: 'Secure Biometric Banking' };
  document.getElementById('top-page-title').textContent = meta.title;
  document.getElementById('top-page-subtitle').textContent = meta.sub;

  // View specific loaders
  if (viewName === 'dashboard') loadDashboardData();
  if (viewName === 'accounts') renderAccountsView();
  if (viewName === 'transactions') renderAllTransactionsView();
  if (viewName === 'security') loadSecurityEvents();
  if (viewName === 'support') loadComplaintsList();
  if (viewName === 'profile') populateProfileView();
  if (viewName === 'transfers') populateTransferSourceAccounts();
}

function toggleSidebar() {
  const sidebar = document.getElementById('app-sidebar');
  const btn = document.getElementById('sidebar-toggle-btn');
  sidebar.classList.toggle('collapsed');
  btn.textContent = sidebar.classList.contains('collapsed') ? '▶' : '◀';
}

// ============================================================
// COMMAND PALETTE (CMD+K / CTRL+K)
// ============================================================
function initCommandPaletteShortcuts() {
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      openCommandPalette();
    }
    if (e.key === 'Escape') {
      closeCommandPalette();
      closeAllDrawers();
      closeAllModals();
    }
  });
}

function openCommandPalette() {
  document.getElementById('command-palette-backdrop').classList.add('active');
  document.getElementById('command-palette').classList.add('active');
  const input = document.getElementById('cmd-input');
  input.value = '';
  input.focus();
}

function closeCommandPalette() {
  document.getElementById('command-palette-backdrop').classList.remove('active');
  document.getElementById('command-palette').classList.remove('active');
}

function handleCommandInput(query) {
  const q = query.toLowerCase().trim();
  const items = document.querySelectorAll('.command-results-list .command-item');
  items.forEach((item) => {
    const text = item.textContent.toLowerCase();
    item.style.display = text.includes(q) ? 'flex' : 'none';
  });
}

// ============================================================
// DRAWERS (TRANSACTION DETAILS, SECURITY, NOTIFICATIONS)
// ============================================================
function openDrawer(drawerName) {
  document.getElementById(`drawer-backdrop-${drawerName}`)?.classList.add('active');
}

function closeDrawer(drawerName) {
  document.getElementById(`drawer-backdrop-${drawerName}`)?.classList.remove('active');
}

function closeAllDrawers() {
  document.querySelectorAll('.drawer-backdrop').forEach((d) => d.classList.remove('active'));
}

function showTransactionDetails(txId) {
  const tx = currentTransactions.find((t) => t.id === txId || t.referenceNumber === txId);
  if (!tx) return;

  const isPos = tx.type === 'DEPOSIT' || tx.type === 'REFUND';
  const prefix = isPos ? '+' : '-';
  const amtEl = document.getElementById('drawer-tx-amt');
  amtEl.textContent = `${prefix}${fmtMoney(tx.amount)}`;
  amtEl.style.color = isPos ? 'var(--success)' : 'var(--text-main)';

  document.getElementById('drawer-tx-ref').textContent = tx.referenceNumber || tx.id;
  document.getElementById('drawer-tx-desc').textContent = tx.description || 'Banking Transaction';
  document.getElementById('drawer-tx-date').textContent = new Date(
    tx.createdAt || Date.now()
  ).toLocaleString('en-IN');
  document.getElementById('drawer-tx-acc').textContent = tx.account
    ? `${tx.account.bankName} (${tx.account.accountNumberMasked})`
    : 'Primary Digital Account';

  const statusEl = document.getElementById('drawer-tx-status');
  statusEl.textContent = `${tx.status || 'COMPLETED'} ✓`;
  statusEl.className = `status-badge ${(tx.status || 'completed').toLowerCase()}`;

  openDrawer('transaction');
}

// ============================================================
// MODALS MANAGEMENT
// ============================================================
function openModal(modalId) {
  document.getElementById(`modal-${modalId}`)?.classList.add('active');
}

function closeModal(modalId) {
  document.getElementById(`modal-${modalId}`)?.classList.remove('active');
}

function closeAllModals() {
  document.querySelectorAll('.modal-backdrop').forEach((m) => m.classList.remove('active'));
}

function setAmt(action, val) {
  const input = document.getElementById(`${action}-amt`);
  if (input) input.value = val;
}

// ============================================================
// AUTH & ONBOARDING FLOWS
// ============================================================
function startLogin() {
  goTo('screen-login-aadhaar');
  document.getElementById('login-aadhaar-last4').value = '';
  document.getElementById('aadhaar-login-status').innerHTML = '';
}

function startRegistration() {
  goTo('screen-register-form');
  document.getElementById('reg-name').value = '';
  document.getElementById('reg-aadhaar').value = '';
  document.getElementById('reg-mobile').value = '';
  document.getElementById('reg-pin').value = '';
  document.getElementById('reg-emergency-pin').value = '';
  document.getElementById('reg-msg').textContent = '';
}

function formatAadhaar(input) {
  let val = input.value.replace(/\D/g, '').slice(0, 12);
  let parts = [];
  for (let i = 0; i < val.length; i += 4) {
    parts.push(val.slice(i, i + 4));
  }
  input.value = parts.join(' ');
}

function handleDobChange() {
  const dobVal = document.getElementById('reg-dob').value;
  if (!dobVal) return;
  const age = computeAge(dobVal);
  const note = document.getElementById('reg-age-note');
  const seniorBlock = document.getElementById('reg-senior-block');
  if (age !== null) {
    if (age >= 60) {
      note.textContent = `Age: ${age} years · Senior Assisted Banking enabled.`;
      seniorBlock.style.display = 'block';
    } else {
      note.textContent = `Age: ${age} years.`;
      seniorBlock.style.display = 'none';
    }
  }
}

function computeAge(dobStr) {
  const birth = new Date(dobStr);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return isNaN(age) ? null : age;
}

async function proceedToBiometrics() {
  // This now just validates the form and stores the pending payload,
  // then triggers the email OTP step. The actual biometric scan is launched
  // after email verification succeeds.
  return proceedToEmailOtp();
}

async function proceedToEmailOtp() {
  const name = document.getElementById('reg-name').value.trim();
  const aadhaar = document.getElementById('reg-aadhaar').value.replace(/\s/g, '');
  const mobile = document.getElementById('reg-mobile').value.trim();
  const email = (document.getElementById('reg-email')?.value || '').trim();
  const role = document.getElementById('reg-role').value;
  const pin = document.getElementById('reg-pin').value.trim();
  const emergencyPin = document.getElementById('reg-emergency-pin').value.trim();
  const dobVal = document.getElementById('reg-dob').value;
  const msg = document.getElementById('reg-msg');

  if (!name || name.length < 2) {
    msg.textContent = 'Please enter your full name.';
    msg.className = 'modal-msg err';
    return;
  }
  if (aadhaar.length !== 12 || !/^\d{12}$/.test(aadhaar)) {
    msg.textContent = 'Enter a valid 12-digit Aadhaar number.';
    msg.className = 'modal-msg err';
    return;
  }
  if (!/^\d{10}$/.test(mobile)) {
    msg.textContent = 'Enter a valid 10-digit mobile number.';
    msg.className = 'modal-msg err';
    return;
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    msg.textContent = 'Please enter a valid email address.';
    msg.className = 'modal-msg err';
    document.getElementById('reg-email')?.focus();
    return;
  }
  if (!/^\d{4}$/.test(pin)) {
    msg.textContent = 'Primary PIN must be 4 digits.';
    msg.className = 'modal-msg err';
    return;
  }
  if (emergencyPin && !/^\d{4}$/.test(emergencyPin)) {
    msg.textContent = 'Emergency Duress PIN must be 4 digits (or leave blank).';
    msg.className = 'modal-msg err';
    return;
  }
  if (emergencyPin && pin === emergencyPin) {
    msg.textContent = 'Emergency PIN must be different from primary PIN.';
    msg.className = 'modal-msg err';
    return;
  }

  const age = dobVal ? computeAge(dobVal) : null;
  const isSenior = age !== null && age >= 60;

  // Extract all trusted emergency contacts / authorized persons
  const emergencyContacts = [];
  const contactRows = document.querySelectorAll(
    '#reg-emergency-contacts-list .emergency-contact-row'
  );
  contactRows.forEach((row) => {
    const cName = row.querySelector('.reg-ec-name')?.value.trim();
    const cPhone = row.querySelector('.reg-ec-phone')?.value.trim();
    const cRel = row.querySelector('.reg-ec-relation')?.value.trim();
    const cIdNum = row.querySelector('.reg-ec-idnum')?.value.trim();
    if (cName && cPhone) {
      emergencyContacts.push({
        name: cName,
        phone: cPhone,
        relation: cRel || 'Trusted Representative',
        idNumber: cIdNum || null,
      });
    }
  });

  const primaryContact = emergencyContacts[0] || null;

  // Store pending payload — email and ticket will be added after OTP verify
  window._pendingRegPayload = {
    fullName: name,
    phone: mobile,
    email,
    aadhaarNumber: aadhaar,
    dob: dobVal || undefined,
    role,
    pin,
    emergencyPin: emergencyPin || undefined,
    isSenior,
    emergencyContactName: primaryContact ? primaryContact.name : undefined,
    emergencyContactPhone: primaryContact ? primaryContact.phone : undefined,
    emergencyContactRelation: primaryContact ? primaryContact.relation : undefined,
    emergencyContacts: emergencyContacts.length > 0 ? emergencyContacts : undefined,
  };

  msg.textContent = '';
  msg.className = 'modal-msg';

  // Proceed to email OTP verification step
  await startEmailOtpFlow(email);
}

function addRegistrationEmergencyContactRow() {
  const container = document.getElementById('reg-emergency-contacts-list');
  if (!container) return;
  const count = container.querySelectorAll('.emergency-contact-row').length + 1;
  const row = document.createElement('div');
  row.className = 'emergency-contact-row';
  row.style.cssText =
    'background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px; position: relative;';
  row.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
      <span style="font-size: 11px; font-weight: 600; color: var(--primary);">Authorized Contact #${count}</span>
      <button type="button" class="mini-btn" style="padding: 2px 6px; font-size: 10px; color: #ef4444;" onclick="this.closest('.emergency-contact-row').remove()">Remove ✕</button>
    </div>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">
      <div>
        <label style="font-size: 11px;">Full Name *</label>
        <input class="reg-ec-name" type="text" maxlength="80" placeholder="Full Name" autocomplete="name" />
      </div>
      <div>
        <label style="font-size: 11px;">10-Digit Mobile *</label>
        <input class="reg-ec-phone" type="tel" placeholder="10-digit mobile" inputmode="numeric" maxlength="10" autocomplete="tel" />
      </div>
    </div>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
      <div>
        <label style="font-size: 11px;">Relationship</label>
        <select class="reg-ec-relation">
          <option value="Spouse">Spouse</option>
          <option value="Parent">Parent</option>
          <option value="Child">Child / Son / Daughter</option>
          <option value="Sibling">Sibling / Brother / Sister</option>
          <option value="Caregiver">Designated Caregiver</option>
          <option value="Legal Representative">Legal Representative / Attorney</option>
          <option value="Trusted Relative">Trusted Relative / Friend</option>
          <option value="Other">Other Authorized Person</option>
        </select>
      </div>
      <div>
        <label style="font-size: 11px;">Gov ID Proof (Optional)</label>
        <input class="reg-ec-idnum" type="text" maxlength="30" placeholder="Aadhaar/PAN/DL (Optional)" autocomplete="off" />
      </div>
    </div>
  `;
  container.appendChild(row);
}

// Alias for backwards compatibility
async function proceedToOtp() {
  return proceedToEmailOtp();
}

// ============================================================
// EMAIL OTP VERIFICATION FLOW
// ============================================================
function maskEmail(email) {
  if (!email || !email.includes('@')) return 'your email';
  const [local, domain] = email.split('@');
  const masked = local.length > 3
    ? local.slice(0, 2) + '•'.repeat(local.length - 2)
    : local[0] + '•'.repeat(local.length - 1);
  return masked + '@' + domain;
}

async function startEmailOtpFlow(email) {
  document.getElementById('otp-eyebrow').textContent = 'Step 2 of 3 · Email Verification';
  const emailDisplay = document.getElementById('otp-email-display');
  if (emailDisplay) emailDisplay.textContent = maskEmail(email);
  OTP_DIGIT_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  const smsBanner = document.getElementById('otp-sms-banner');
  if (smsBanner) smsBanner.style.display = 'none';

  const msg = document.getElementById('otp-msg');
  msg.textContent = 'Sending verification code to your email…';
  msg.className = 'modal-msg';
  goTo('screen-email-otp');

  try {
    const data = await window.iCashApi.sendEmailOtp(email);
    pendingOtp = { purpose: 'register', email, expiresAt: data.expiresAt };
    msg.textContent = '';
    document.getElementById('od0')?.focus();

    const displayCode = data.devCode || data.code;
    if (displayCode) {
      const smsCodeEl = document.getElementById('otp-sms-code');
      if (smsBanner && smsCodeEl) {
        smsCodeEl.textContent = displayCode;
        smsBanner.style.display = 'block';
      }
      showAlertToast(`📧 Email Verification Code: [ ${displayCode} ]`);
    }

    startOtpCountdown();
    startResendCooldown();
  } catch (err) {
    msg.textContent = err.message || 'Failed to send email. Please check your address and try again.';
    msg.className = 'modal-msg err';
  }
}

function startOtpCountdown() {
  clearInterval(otpCountdownTimer);
  updateOtpCountdown();
  otpCountdownTimer = setInterval(updateOtpCountdown, 1000);
}

function updateOtpCountdown() {
  const el = document.getElementById('otp-countdown');
  if (!el) return;
  if (!pendingOtp) {
    clearInterval(otpCountdownTimer);
    return;
  }
  const remaining = pendingOtp.expiresAt - Date.now();
  if (remaining <= 0) {
    el.textContent = 'Code expired — please request a new code';
    clearInterval(otpCountdownTimer);
    return;
  }
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  el.textContent = `Expires in ${mins}:${secs.toString().padStart(2, '0')}`;
}

function startResendCooldown() {
  const btn = document.getElementById('resend-btn');
  if (!btn) return;
  let remaining = 30;
  btn.disabled = true;
  btn.textContent = `Resend Code (${remaining}s)`;
  clearInterval(otpResendTimer);
  otpResendTimer = setInterval(() => {
    remaining--;
    btn.textContent = remaining > 0 ? `Resend Code (${remaining}s)` : 'Resend Code';
    if (remaining <= 0) {
      clearInterval(otpResendTimer);
      btn.disabled = false;
    }
  }, 1000);
}

async function resendEmailOtp() {
  if (!pendingOtp) return;
  await startEmailOtpFlow(pendingOtp.email);
}

async function verifyEmailOtpCode() {
  const msg = document.getElementById('otp-msg');
  if (!pendingOtp) return;
  const entered = OTP_DIGIT_IDS.map((id) => document.getElementById(id).value).join('');
  if (entered.length < 6) {
    msg.textContent = 'Enter all 6 digits.';
    msg.className = 'modal-msg err';
    return;
  }

  msg.textContent = 'Verifying code…';
  msg.className = 'modal-msg';

  try {
    const res = await window.iCashApi.verifyEmailOtp(pendingOtp.email, entered);
    if (!res.ok) {
      msg.textContent = res.error || res.reason || 'Incorrect code.';
      msg.className = 'modal-msg err';
      return;
    }

    // Store the verification ticket — required for registration
    window._emailVerificationTicket = res.ticket;
    if (window._pendingRegPayload) {
      window._pendingRegPayload.emailVerificationTicket = res.ticket;
    }

    msg.textContent = 'Email verified ✓';
    msg.className = 'modal-msg ok';
    clearInterval(otpCountdownTimer);
    clearInterval(otpResendTimer);
    pendingOtp = null;

    setTimeout(() => {
      goTo('screen-register-scan');
      beginRegisterScan();
    }, 400);
  } catch (err) {
    msg.textContent = err.message || 'Verification error.';
    msg.className = 'modal-msg err';
  }
}

function cancelEmailOtp() {
  clearInterval(otpCountdownTimer);
  clearInterval(otpResendTimer);
  pendingOtp = null;
  window._emailVerificationTicket = null;
  goTo('screen-register-form');
}

// Keep old names as no-op stubs so any residual HTML onclick references
// (e.g. in dist/ if not yet rebuilt) don't throw
function cancelOtp() { cancelEmailOtp(); }
function resendOtp() { resendEmailOtp(); }
function verifyOtpCode() { verifyEmailOtpCode(); }

function autoFillOtp(code) {
  if (!code) return;
  const digits = String(code).replace(/\D/g, '').slice(0, 6).split('');
  digits.forEach((ch, i) => {
    if (OTP_DIGIT_IDS[i]) document.getElementById(OTP_DIGIT_IDS[i]).value = ch;
  });
  if (digits.length === 6) {
    verifyEmailOtpCode();
  }
}

function initOtpDigitInputs() {
  OTP_DIGIT_IDS.forEach((id, idx) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      el.value = el.value.replace(/\D/g, '').slice(0, 1);
      if (el.value && idx < OTP_DIGIT_IDS.length - 1) {
        document.getElementById(OTP_DIGIT_IDS[idx + 1])?.focus();
      }
      const allFilled = OTP_DIGIT_IDS.every(
        (did) => (document.getElementById(did)?.value || '').length === 1
      );
      if (allFilled) {
        verifyOtpCode();
      }
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !el.value && idx > 0) {
        document.getElementById(OTP_DIGIT_IDS[idx - 1])?.focus();
      }
      if (e.key === 'Enter') verifyOtpCode();
    });
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      const pasteText = (e.clipboardData || window.clipboardData).getData('text');
      autoFillOtp(pasteText);
    });
  });
}

// ============================================================
// BIOMETRIC CAMERA & VECTOR MATCHING
// ============================================================
function cameraErrorMessage(err) {
  if (err && err.message === 'INSECURE_CONTEXT') {
    return 'Mobile browsers require HTTPS for camera streaming. Use PIN authorization or tap below to proceed with digital verification.';
  }
  if (err && err.message === 'NO_MEDIA_API') {
    return "This browser doesn't support webcam access. Use PIN authorization to sign in.";
  }
  const name = err && err.name;
  if (
    name === 'NotAllowedError' ||
    name === 'PermissionDeniedError' ||
    name === 'SecurityError' ||
    name === 'AbortError'
  ) {
    return 'Camera access blocked. On Android: close any floating bubbles/overlays (such as Messenger Chat Heads or screen recorders) and tap Retry, or use PIN authorization below.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No camera found. Connect a camera or use PIN authorization below.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Camera is in use by another app. Close other camera apps or use PIN authorization below.';
  }
  if (name === 'OverconstrainedError') {
    return 'Camera resolution unsupported. Retrying with standard mobile camera settings.';
  }
  return 'Camera permission unavailable. Close floating screen bubbles/overlays or use PIN authorization below.';
}

async function startCamera(videoEl, errEl) {
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.remove('active');
  }

  // Set mobile video attributes
  if (videoEl) {
    videoEl.setAttribute('playsinline', 'true');
    videoEl.setAttribute('webkit-playsinline', 'true');
    videoEl.setAttribute('muted', 'true');
    videoEl.muted = true;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (
      !window.isSecureContext &&
      location.hostname !== 'localhost' &&
      location.hostname !== '127.0.0.1'
    ) {
      const err = new Error('INSECURE_CONTEXT');
      if (errEl) {
        errEl.textContent = cameraErrorMessage(err);
        errEl.classList.add('active');
      }
      throw err;
    }
    const err = new Error('NO_MEDIA_API');
    if (errEl) {
      errEl.textContent = cameraErrorMessage(err);
      errEl.classList.add('active');
    }
    throw err;
  }

  try {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      });
    } catch (conErr) {
      stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
    }
    videoEl.srcObject = stream;
    await videoEl.play().catch(() => {});
    return stream;
  } catch (err) {
    console.error('Camera access failed:', err.name, err.message);
    if (errEl) {
      errEl.textContent = cameraErrorMessage(err);
      errEl.classList.add('active');
    }
    throw err;
  }
}

function stopCamera(videoEl) {
  if (videoEl && videoEl.srcObject) {
    videoEl.srcObject.getTracks().forEach((track) => track.stop());
    videoEl.srcObject = null;
  }
}

// beginRegisterScan / captureRegisterFace / cancelRegisterScan / teardownRegisterScan
// → Implemented in biometric.js (real face-api.js auto-scan engine)

// Login Aadhaar lookup
async function verifyAadhaarLogin() {
  const last4 = document.getElementById('login-aadhaar-last4').value.trim();
  const statusDiv = document.getElementById('aadhaar-login-status');
  if (!/^\d{4}$/.test(last4)) {
    statusDiv.innerHTML = '<span style="color:var(--alert);font-size:12px;">Enter 4 digits.</span>';
    return;
  }
  statusDiv.innerHTML =
    '<span style="color:var(--text-muted);font-size:12px;">Verifying records…</span>';

  try {
    const res = await window.iCashApi.loginAadhaar({ aadhaarLast4: last4 });
    const matchingUsers = res.users || [];
    if (matchingUsers.length === 0) {
      statusDiv.innerHTML =
        '<span style="color:var(--alert);font-size:12px;">No account found with this record.</span>';
      return;
    }
    const targetUser = matchingUsers[0];
    statusDiv.innerHTML = `<span style="color:var(--primary);font-size:12px;">✓ Verified: ${targetUser.name}</span>`;
    window._loginTargetUser = targetUser;
    setTimeout(() => {
      goTo('screen-login-scan');
      beginLoginScan();
    }, 400);
  } catch (err) {
    statusDiv.innerHTML = `<span style="color:var(--alert);font-size:12px;">${err.message}</span>`;
  }
}

// beginLoginScan / captureLoginFace / cancelLoginScan / teardownLoginScan
// → Implemented in biometric.js (real face-api.js Euclidean matching engine)

function promptLoginPin(user, confidence = 0.95) {
  const u = user || window._loginTargetUser || pendingLoginUser;
  pendingLoginUser = u;
  window.pendingLoginUser = u;
  const pinInput = document.getElementById('login-pin-input');
  if (pinInput) pinInput.value = '';
  const pinMsg = document.getElementById('login-pin-msg');
  if (pinMsg) pinMsg.textContent = '';
  const banner = document.getElementById('login-pin-banner');
  const uName = u ? (u.name || 'Customer') : 'Customer';
  if (banner) {
    banner.innerHTML = `
      <div class="av">${initials(uName)}</div>
      <div>
        <strong>Biometric Verified — ${uName}</strong>
        <span>Match confidence: ${Math.round(confidence * 100)}% · Enter 4-digit security PIN</span>
      </div>
    `;
  }
  goTo('screen-login-pin');
  if (pinInput) pinInput.focus();
}
window.promptLoginPin = promptLoginPin;

async function submitLoginPin() {
  const pin = document.getElementById('login-pin-input').value.trim();
  const msg = document.getElementById('login-pin-msg');
  const u = pendingLoginUser || window._loginTargetUser;
  if (!u || !u.id) {
    goTo('screen-welcome');
    return;
  }

  msg.textContent = 'Authenticating…';
  msg.className = 'modal-msg';

  try {
    const res = await window.iCashApi.loginPin({ userId: u.id, pin });
    if (res.ok && res.user) {
      setCurrentUser(res.user);
      pendingLoginUser = null;
      window.pendingLoginUser = null;
      if (res.isDuress)
        showAlertToast('🚨 Emergency access mode activated · silent alert logged.', true);
      enterDashboard();
    } else {
      msg.textContent = res.message || res.error || 'Incorrect PIN.';
      msg.className = 'modal-msg err';
    }
  } catch (err) {
    msg.textContent = err.message || 'Incorrect PIN.';
    msg.className = 'modal-msg err';
  }
}

async function attemptPinDirectLogin() {
  const aadhaarLast4 = document.getElementById('pin-login-aadhaar').value.trim();
  const pin = document.getElementById('pin-login-pin').value.trim();
  const msg = document.getElementById('pin-login-msg');

  if (!/^\d{4}$/.test(aadhaarLast4) || !/^\d{4}$/.test(pin)) {
    msg.textContent = 'Enter 4-digit Aadhaar last 4 and 4-digit PIN.';
    msg.className = 'modal-msg err';
    return;
  }

  msg.textContent = 'Authenticating…';
  msg.className = 'modal-msg';

  try {
    const lookup = await window.iCashApi.loginAadhaar({ aadhaarLast4 });
    if (!lookup.users || lookup.users.length === 0) {
      msg.textContent = 'No account found.';
      msg.className = 'modal-msg err';
      return;
    }
    const targetUser = lookup.users[0];
    const res = await window.iCashApi.loginPin({ userId: targetUser.id, pin });
    if (res.ok && res.user) {
      setCurrentUser(res.user);
      if (res.isDuress) showAlertToast('🚨 Emergency access mode activated.', true);
      enterDashboard();
    }
  } catch (err) {
    msg.textContent = err.message || 'Authentication failed.';
    msg.className = 'modal-msg err';
  }
}

function showMatch(user, isNew) {
  if (!user) return;
  setCurrentUser(user);
  const banner = document.getElementById('match-banner');
  if (banner) {
    banner.innerHTML = `
      <div class="av">${initials(user.name || 'CU')}</div>
      <div>
        <strong>${isNew ? 'Welcome to iCash, ' : 'Identity Confirmed — '}${user.name || 'Customer'}</strong>
        <span>${isNew ? 'Account created successfully with primary digital savings wallet.' : 'Session established with bank-grade encryption.'}</span>
        <span style="font-size:11px;color:var(--primary);display:block;margin-top:4px;">Masked Aadhaar: •••• ${user.aadhaarLast4 || '----'} ✓</span>
      </div>
    `;
  }
  goTo('screen-match');
}
window.showMatch = showMatch;

// ============================================================
// DASHBOARD & FINANCIAL DATA ENGINE
// ============================================================
function enterDashboard() {
  const user = getCurrentUser();
  if (!user) {
    // No authenticated user — send back to login
    goTo('screen-welcome');
    return;
  }
  setCurrentUser(user);
  goTo('screen-dashboard');
  switchView('dashboard');
}
window.enterDashboard = enterDashboard;

async function loadDashboardData() {
  if (!currentUser) return;

  // Header and user information
  const firstName = (currentUser.name || 'Customer').split(' ')[0];
  const greetEl = document.getElementById('dash-greeting');
  if (greetEl) greetEl.textContent = `Good afternoon, ${firstName}`;
  const nameEl = document.getElementById('top-user-name');
  if (nameEl) nameEl.textContent = currentUser.name || 'Customer';
  const avatarEl = document.getElementById('top-avatar');
  if (avatarEl) avatarEl.textContent = initials(currentUser.name || 'CU');
  const phoneEl = document.getElementById('dash-masked-phone');
  if (phoneEl) phoneEl.textContent = `Mobile: +91 ${currentUser.phone || '9876543210'}`;
  const aadhaarEl = document.getElementById('dash-masked-aadhaar');
  if (aadhaarEl) aadhaarEl.textContent = `Aadhaar: •••• ${currentUser.aadhaarLast4 || '4821'}`;

  const seniorTagEl = document.getElementById('dash-senior-tag');
  if (seniorTagEl) {
    seniorTagEl.style.display = currentUser.isSenior ? 'inline-block' : 'none';
  }

  // Fetch real Accounts & Transactions
  try {
    const accRes = await window.iCashApi.getAccounts();
    currentAccounts =
      accRes && accRes.accounts && accRes.accounts.length > 0
        ? accRes.accounts
        : [
            {
              id: 'acc_primary_savings',
              bankName: 'iCash Federal Digital Bank',
              accountNumberMasked: `•••• ${currentUser.aadhaarLast4 || '4821'}`,
              accountType: 'SAVINGS',
              balance: 25000,
              isPrimary: true,
              status: 'ACTIVE',
            },
            {
              id: 'acc_virtual_wallet',
              bankName: 'iCash Virtual Debit Wallet',
              accountNumberMasked: '•••• 0912',
              accountType: 'VIRTUAL',
              balance: 5000,
              isPrimary: false,
              status: 'ACTIVE',
            },
          ];

    const primaryAcc = currentAccounts.find((a) => a.isPrimary) || currentAccounts[0];
    renderBalanceHero(primaryAcc);
    renderAccountsGrid(currentAccounts);

    const txRes = await window.iCashApi.getTransactions();
    currentTransactions =
      txRes && txRes.transactions && txRes.transactions.length > 0
        ? txRes.transactions
        : [
            {
              id: 'TX_DEMO_01',
              referenceNumber: 'TX_ICASH_1001',
              description: 'Account opened · e-KYC demo funds credited',
              amount: 25000,
              type: 'DEPOSIT',
              status: 'COMPLETED',
              createdAt: new Date().toISOString(),
            },
            {
              id: 'TX_DEMO_02',
              referenceNumber: 'TX_ICASH_1002',
              description: 'Metro Mart POS Grocery Store',
              amount: 1450,
              type: 'PAYMENT',
              status: 'COMPLETED',
              createdAt: new Date(Date.now() - 3600000).toISOString(),
            },
          ];
    filteredTransactions = [...currentTransactions];

    renderInsightCards(primaryAcc.balance, currentTransactions, currentAccounts.length);
    renderTransactionsTable();
  } catch (err) {
    console.error('Failed to load dashboard:', err);
  }
}

function renderBalanceHero(primaryAcc) {
  const balEl = document.getElementById('dash-primary-balance');
  const bankLabel = document.getElementById('dash-primary-bank-label');
  const accMask = document.getElementById('dash-primary-acc-mask');
  if (!primaryAcc) {
    if (balEl) balEl.textContent = '₹0.00';
    if (bankLabel) bankLabel.textContent = 'iCash Federal Digital Bank';
    if (accMask) accMask.textContent = '•••• ----';
    return;
  }

  if (bankLabel) bankLabel.textContent = primaryAcc.bankName || 'iCash Federal Digital Bank';
  if (accMask) accMask.textContent = primaryAcc.accountNumberMasked || '•••• 6926';

  if (balEl) {
    if (isBalanceHidden) {
      balEl.textContent = '₹ ••••••';
    } else {
      balEl.textContent = fmtMoney(primaryAcc.balance || 0);
    }
  }
}

function toggleBalanceVisibility() {
  isBalanceHidden = !isBalanceHidden;
  const eyeBtn = document.getElementById('balance-eye-btn');
  eyeBtn.textContent = isBalanceHidden ? '🙈' : '👁️';
  const primaryAcc = currentAccounts.find((a) => a.isPrimary) ||
    currentAccounts[0] || { balance: 15000 };
  renderBalanceHero(primaryAcc);
}

function renderInsightCards(balance, transactions, linkedCount) {
  let moneyIn = 0;
  let moneyOut = 0;

  transactions.forEach((t) => {
    if (t.type === 'DEPOSIT' || t.type === 'REFUND') moneyIn += Number(t.amount);
    if (t.type === 'WITHDRAWAL' || t.type === 'TRANSFER' || t.type === 'PAYMENT')
      moneyOut += Number(t.amount);
  });

  if (moneyIn === 0) moneyIn = 12500;
  if (moneyOut === 0) moneyOut = 7250;

  document.getElementById('dash-money-in').textContent = fmtMoney(moneyIn);
  document.getElementById('dash-money-out').textContent = fmtMoney(moneyOut);
  document.getElementById('dash-available-bal').textContent = isBalanceHidden
    ? '₹ ••••••'
    : fmtMoney(balance);
  document.getElementById('dash-linked-count').textContent =
    `${linkedCount} ${linkedCount === 1 ? 'Account' : 'Accounts'}`;
}

function renderAccountsGrid(accounts) {
  const container = document.getElementById('dash-accounts-grid');
  const pageContainer = document.getElementById('accounts-page-grid');

  if (accounts.length === 0) {
    const emptyHtml =
      '<div class="empty">No linked bank accounts found. Link an account to start.</div>';
    if (container) container.innerHTML = emptyHtml;
    if (pageContainer) pageContainer.innerHTML = emptyHtml;
    return;
  }

  const html = accounts
    .map(
      (a) => `
    <div class="account-card-box">
      <div class="acc-card-top">
        <div class="acc-bank-info">
          <div class="acc-logo-pill">${a.accountType === 'SAVINGS' ? 'S' : a.accountType === 'CURRENT' ? 'C' : 'V'}</div>
          <div>
            <div class="acc-name-label">${a.bankName} ${a.isPrimary ? '<span style="color:var(--primary);font-size:10px;">(Primary)</span>' : ''}</div>
            <div class="acc-num-label">${a.accountNumberMasked} · ${a.accountType}</div>
          </div>
        </div>
        <span class="status-badge completed">${a.status}</span>
      </div>
      <div class="acc-card-bal">${isBalanceHidden ? '₹ ••••••' : fmtMoney(a.balance)}</div>
      <div class="acc-card-actions">
        ${!a.isPrimary ? `<button class="mini-btn" onclick="setPrimaryAccount('${a.id}')">Make Primary</button>` : ''}
        <button class="mini-btn" onclick="switchView('transfers')">Transfer</button>
      </div>
    </div>
  `
    )
    .join('');

  if (container) container.innerHTML = html;
  if (pageContainer) pageContainer.innerHTML = html;
}

// ============================================================
// RECORDS & FILTER TRANSACTIONS TABLE (BEAUTIFUL UI PATTERN)
// ============================================================
function filterTransactions(type, chipEl) {
  currentFilterType = type;
  document
    .querySelectorAll('.table-filter-bar .filter-chip')
    .forEach((c) => c.classList.remove('active'));
  if (chipEl) chipEl.classList.add('active');

  applyTransactionFilters();
}

function handleTransactionSearch(query) {
  currentSearchQuery = query.toLowerCase().trim();
  applyTransactionFilters();
}

function applyTransactionFilters() {
  filteredTransactions = currentTransactions.filter((t) => {
    const matchesType = currentFilterType === 'ALL' || t.type === currentFilterType;
    const desc = (t.description || '').toLowerCase();
    const ref = (t.referenceNumber || t.id || '').toLowerCase();
    const matchesSearch =
      !currentSearchQuery || desc.includes(currentSearchQuery) || ref.includes(currentSearchQuery);
    return matchesType && matchesSearch;
  });

  currentPage = 1;
  renderTransactionsTable();
}

function renderTransactionsTable() {
  const tbody = document.getElementById('tx-table-body');
  const allTbody = document.getElementById('all-tx-table-body');

  if (filteredTransactions.length === 0) {
    const empty =
      '<tr><td colspan="6" class="empty">No matching transactions found in ledger.</td></tr>';
    if (tbody) tbody.innerHTML = empty;
    if (allTbody) allTbody.innerHTML = empty;
    return;
  }

  const startIdx = (currentPage - 1) * ITEMS_PER_PAGE;
  const pageItems = filteredTransactions.slice(startIdx, startIdx + ITEMS_PER_PAGE);

  const icons = { TRANSFER: '↗', WITHDRAWAL: '↓', DEPOSIT: '✨', PAYMENT: '💳', REFUND: '↺' };

  const rowsHtml = pageItems
    .map((t) => {
      const isPos = t.type === 'DEPOSIT' || t.type === 'REFUND';
      const sign = isPos ? '+' : '-';
      const accLabel = t.account
        ? `${t.account.bankName} (${t.account.accountNumberMasked})`
        : 'Primary Digital Account';

      return `
      <tr onclick="showTransactionDetails('${t.id || t.referenceNumber}')">
        <td>
          <div class="tx-entity-cell">
            <div class="tx-type-icon">${icons[t.type] || '•'}</div>
            <div>
              <strong>${t.description || 'Transfer'}</strong>
              <div style="font-size:11px;color:var(--text-faint);font-family:var(--font-mono);">${t.referenceNumber || t.id}</div>
            </div>
          </div>
        </td>
        <td style="color:var(--text-muted);font-family:var(--font-mono);font-size:12px;">
          ${new Date(t.createdAt || Date.now()).toLocaleString('en-IN')}
        </td>
        <td>
          <span style="font-size:12px;color:var(--text-muted);">${accLabel}</span>
        </td>
        <td>
          <span class="tx-amount-cell ${isPos ? 'pos' : 'neg'}">
            ${sign}${fmtMoney(t.amount)}
          </span>
        </td>
        <td>
          <span class="status-badge ${(t.status || 'completed').toLowerCase()}">${t.status || 'Completed'}</span>
        </td>
        <td style="color:var(--text-faint);font-size:11px;font-family:var(--font-mono);">
          ${t.type === 'PAYMENT' ? 'UPI / POS' : 'Biometric'}
        </td>
      </tr>
    `;
    })
    .join('');

  if (tbody) tbody.innerHTML = rowsHtml;
  if (allTbody) allTbody.innerHTML = rowsHtml;

  const pageInfo = document.getElementById('pagination-info');
  if (pageInfo) {
    pageInfo.textContent = `Showing ${startIdx + 1}–${Math.min(startIdx + ITEMS_PER_PAGE, filteredTransactions.length)} of ${filteredTransactions.length} records`;
  }
}

function prevPage() {
  if (currentPage > 1) {
    currentPage--;
    renderTransactionsTable();
  }
}

function nextPage() {
  if (currentPage * ITEMS_PER_PAGE < filteredTransactions.length) {
    currentPage++;
    renderTransactionsTable();
  }
}

function exportStatement() {
  if (currentTransactions.length === 0) {
    showAlertToast('No transactions to export.', true);
    return;
  }

  let csv = 'Transaction ID,Date,Description,Type,Amount,Status\n';
  currentTransactions.forEach((t) => {
    csv += `"${t.referenceNumber || t.id}","${new Date(t.createdAt).toLocaleString('en-IN')}","${t.description || ''}","${t.type}","${t.amount}","${t.status}"\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `iCash_Statement_${Date.now()}.csv`;
  a.click();
  showAlertToast('📄 Bank statement CSV downloaded.');
}

// ============================================================
// TRANSFER / WITHDRAW / DEPOSIT WORKFLOWS
// ============================================================
let currentTransferMode = 'PHONE';
let currentModalSendMode = 'PHONE';
let _transferPhoneTimeout = null;
let _sendPhoneTimeout = null;

function switchTransferMode(mode) {
  currentTransferMode = mode;
  const tabPhone = document.getElementById('tab-transfer-phone');
  const tabAcct = document.getElementById('tab-transfer-acct');
  const phoneGroup = document.getElementById('transfer-phone-group');

  if (mode === 'PHONE') {
    tabPhone?.classList.add('active');
    tabAcct?.classList.remove('active');
    if (phoneGroup) phoneGroup.style.display = 'block';
  } else {
    tabAcct?.classList.add('active');
    tabPhone?.classList.remove('active');
    if (phoneGroup) phoneGroup.style.display = 'none';
  }
}

function switchModalSendMode(mode) {
  currentModalSendMode = mode;
  const tabPhone = document.getElementById('tab-send-phone');
  const tabAcct = document.getElementById('tab-send-acct');
  const phoneGroup = document.getElementById('send-phone-group');

  if (mode === 'PHONE') {
    tabPhone?.classList.add('active');
    tabAcct?.classList.remove('active');
    if (phoneGroup) phoneGroup.style.display = 'block';
  } else {
    tabAcct?.classList.add('active');
    tabPhone?.classList.remove('active');
    if (phoneGroup) phoneGroup.style.display = 'none';
  }
}

function handleTransferPhoneInput(val) {
  clearTimeout(_transferPhoneTimeout);
  const badge = document.getElementById('transfer-phone-lookup-badge');
  const nameInput = document.getElementById('transfer-dest-name');
  const clean = val.replace(/\D/g, '').slice(-10);

  if (clean.length < 10) {
    if (badge) badge.innerHTML = '';
    window._transferRecipient = null;
    return;
  }

  if (badge) {
    badge.innerHTML = '<span style="color:var(--text-muted);">🔍 Verifying iCash user…</span>';
  }

  _transferPhoneTimeout = setTimeout(async () => {
    try {
      const res = await window.iCashApi.lookupRecipient(clean);
      if (res.found && res.recipient) {
        window._transferRecipient = res.recipient;
        if (nameInput) nameInput.value = res.recipient.name;
        if (badge) {
          badge.innerHTML = `<span style="color:var(--primary);font-weight:600;">✓ ${res.recipient.name}</span> <span style="color:var(--text-faint);font-size:11px;">(${res.recipient.bankName} · ${res.recipient.accountMasked})</span>`;
        }
      } else if (res.isSelf) {
        window._transferRecipient = null;
        if (badge) {
          badge.innerHTML = `<span style="color:var(--alert);">${res.message || 'Cannot transfer to own number.'}</span>`;
        }
      } else {
        window._transferRecipient = null;
        if (badge) {
          badge.innerHTML =
            '<span style="color:var(--text-muted);">ℹ️ External recipient · Standard mobile settlement</span>';
        }
      }
    } catch (e) {
      if (badge) badge.innerHTML = '';
    }
  }, 350);
}

function handleSendPhoneInput(val) {
  clearTimeout(_sendPhoneTimeout);
  const badge = document.getElementById('send-phone-lookup-badge');
  const nameInput = document.getElementById('send-external-name');
  const clean = val.replace(/\D/g, '').slice(-10);

  if (clean.length < 10) {
    if (badge) badge.innerHTML = '';
    window._sendRecipient = null;
    return;
  }

  if (badge) {
    badge.innerHTML = '<span style="color:var(--text-muted);">🔍 Verifying recipient…</span>';
  }

  _sendPhoneTimeout = setTimeout(async () => {
    try {
      const res = await window.iCashApi.lookupRecipient(clean);
      if (res.found && res.recipient) {
        window._sendRecipient = res.recipient;
        if (nameInput) nameInput.value = res.recipient.name;
        if (badge) {
          badge.innerHTML = `<span style="color:var(--primary);font-weight:600;">✓ ${res.recipient.name}</span> <span style="color:var(--text-faint);font-size:11px;">(${res.recipient.bankName})</span>`;
        }
      } else if (res.isSelf) {
        window._sendRecipient = null;
        if (badge) {
          badge.innerHTML = `<span style="color:var(--alert);">${res.message || 'Cannot send to own number.'}</span>`;
        }
      } else {
        window._sendRecipient = null;
        if (badge) {
          badge.innerHTML =
            '<span style="color:var(--text-muted);">ℹ️ External recipient · Mobile transfer</span>';
        }
      }
    } catch (e) {
      if (badge) badge.innerHTML = '';
    }
  }, 350);
}

function populateTransferSourceAccounts() {
  const select = document.getElementById('transfer-source-select');
  if (!select) return;
  select.innerHTML = currentAccounts
    .map(
      (a) => `
    <option value="${a.id}">${a.bankName} (${a.accountNumberMasked}) — ${fmtMoney(a.balance)}</option>
  `
    )
    .join('');
}

function initiateTransferWorkflow() {
  const sourceId = document.getElementById('transfer-source-select').value;
  const phone = (document.getElementById('transfer-dest-phone')?.value || '').trim();
  const destName = document.getElementById('transfer-dest-name').value.trim();
  const amt = Number(document.getElementById('transfer-amount').value);
  const memo = document.getElementById('transfer-memo').value.trim();
  const msg = document.getElementById('transfer-msg');

  if (currentTransferMode === 'PHONE') {
    const cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.length !== 10) {
      msg.textContent = 'Enter a valid 10-digit mobile phone number.';
      msg.className = 'modal-msg err';
      return;
    }
  }

  if (!destName && currentTransferMode === 'ACCOUNT') {
    msg.textContent = 'Enter beneficiary name.';
    msg.className = 'modal-msg err';
    return;
  }

  if (!amt || amt <= 0) {
    msg.textContent = 'Enter a valid transfer amount.';
    msg.className = 'modal-msg err';
    return;
  }

  const finalName =
    destName ||
    (window._transferRecipient ? window._transferRecipient.name : `Mobile User (+91 ${phone})`);
  const finalDesc =
    currentTransferMode === 'PHONE'
      ? `P2P Mobile Transfer to ${finalName}${memo ? ` (${memo})` : ''}`
      : `Transfer to ${finalName}${memo ? ` (${memo})` : ''}`;

  pendingVerificationAction = {
    type: 'TRANSFER',
    amount: amt,
    description: finalDesc,
    recipientName: finalName,
    recipientPhone: currentTransferMode === 'PHONE' ? phone : undefined,
    recipientUserId: window._transferRecipient ? window._transferRecipient.id : undefined,
    sourceAccountId: sourceId,
  };

  launchBiometricGate(
    'Transfer Authorization',
    `Authorize instant transfer of ${fmtMoney(amt)} to ${finalName}`
  );
}

function confirmWithdraw() {
  const amt = Number(document.getElementById('withdraw-amt').value);
  const msg = document.getElementById('withdraw-msg');
  if (!amt || amt <= 0) {
    msg.textContent = 'Enter a valid withdrawal amount.';
    msg.className = 'modal-msg err';
    return;
  }

  closeModal('withdraw');
  pendingVerificationAction = {
    type: 'WITHDRAWAL',
    amount: amt,
    description: 'ATM Cash Withdrawal',
  };

  launchBiometricGate(
    'Withdrawal Authorization',
    `Authorize ATM cash withdrawal of ${fmtMoney(amt)}`
  );
}

function confirmSend() {
  const phone = (document.getElementById('send-phone')?.value || '').trim();
  const name = document.getElementById('send-external-name').value.trim();
  const amt = Number(document.getElementById('send-amt').value);
  const msg = document.getElementById('send-msg');

  if (currentModalSendMode === 'PHONE') {
    const cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.length !== 10) {
      msg.textContent = 'Enter a valid 10-digit mobile number.';
      msg.className = 'modal-msg err';
      return;
    }
  }

  if (!name && currentModalSendMode === 'ACCOUNT') {
    msg.textContent = 'Enter beneficiary name.';
    msg.className = 'modal-msg err';
    return;
  }

  if (!amt || amt <= 0) {
    msg.textContent = 'Enter a valid amount.';
    msg.className = 'modal-msg err';
    return;
  }

  const finalName =
    name || (window._sendRecipient ? window._sendRecipient.name : `Mobile User (+91 ${phone})`);
  const finalDesc =
    currentModalSendMode === 'PHONE'
      ? `Instant Mobile Transfer to ${finalName}`
      : `Instant P2P Transfer to ${finalName}`;

  closeModal('send');
  pendingVerificationAction = {
    type: 'TRANSFER',
    amount: amt,
    description: finalDesc,
    recipientName: finalName,
    recipientPhone: currentModalSendMode === 'PHONE' ? phone : undefined,
    recipientUserId: window._sendRecipient ? window._sendRecipient.id : undefined,
  };

  launchBiometricGate(
    'Transfer Authorization',
    `Authorize transfer of ${fmtMoney(amt)} to ${finalName}`
  );
}

function openDepositModal() {
  // Reset form state
  const amtEl = document.getElementById('deposit-amt');
  const descEl = document.getElementById('deposit-desc');
  const msgEl = document.getElementById('deposit-msg');
  if (amtEl) amtEl.value = '';
  if (descEl) descEl.value = '';
  if (msgEl) {
    msgEl.textContent = '';
    msgEl.className = 'modal-msg';
  }
  openModal('deposit');
}

function confirmDeposit() {
  const amt = Number(document.getElementById('deposit-amt').value);
  const desc = (document.getElementById('deposit-desc').value || '').trim();
  const msg = document.getElementById('deposit-msg');

  if (!amt || amt <= 0) {
    msg.textContent = 'Enter a valid deposit amount.';
    msg.className = 'modal-msg err';
    return;
  }

  closeModal('deposit');
  pendingVerificationAction = {
    type: 'DEPOSIT',
    amount: amt,
    description: desc || 'Cash Deposit to Primary Account',
  };

  launchBiometricGate(
    'Deposit Authorization',
    `Authorize instant credit of ${fmtMoney(amt)} to digital account`
  );
}

// ============================================================
// BIOMETRIC VERIFICATION GATE (HUMAN IN THE LOOP)
// → launchBiometricGate / captureVerifyFace / cancelVerify / teardownVerifyGate
//   implemented in biometric.js (real face-api.js Euclidean matching, multi-face rejection)
// ============================================================

function toggleVerifyPin() {
  const block = document.getElementById('verify-pin-block');
  if (!block) return;
  const isHidden = block.style.display === 'none';
  block.style.display = isHidden ? 'block' : 'none';
  if (isHidden) {
    document.getElementById('verify-pin-input')?.focus();
  }
}

async function submitVerifyPin() {
  const pin = document.getElementById('verify-pin-input').value.trim();
  const msg = document.getElementById('verify-msg');
  if (!/^\d{4}$/.test(pin)) {
    msg.textContent = 'Enter 4-digit PIN.';
    msg.className = 'modal-msg err';
    return;
  }

  if (pendingVerificationAction) {
    pendingVerificationAction.pin = pin;
    pendingVerificationAction.verifyMethod = 'PIN';
  }

  try {
    await executePendingAction();
    teardownVerifyGate();
    closeModal('verify');
  } catch (err) {
    msg.textContent = err.message || 'Authorization failed.';
    msg.className = 'modal-msg err';
  }
}

async function executePendingAction() {
  if (!pendingVerificationAction) return;

  try {
    const res = await window.iCashApi.createTransaction(pendingVerificationAction);
    if (res.ok) {
      if (res.policeAlertTriggered || res.isDuress) {
        showAlertToast(
          '🚨 Emergency Distress Signal Active · Covert Police Alert Dispatched.',
          true
        );
      } else {
        showAlertToast(
          `✓ ${pendingVerificationAction.description} of ${fmtMoney(pendingVerificationAction.amount)} authorized.`
        );
      }
      pendingVerificationAction = null;
      loadDashboardData();
    }
  } catch (err) {
    if (err.status === 401) {
      currentUser = null;
      setTimeout(() => {
        closeModal('verify');
        goTo('screen-welcome');
        showAlertToast('🔒 Session expired. Please sign in again to authorize transactions.', true);
      }, 1800);
    }
    throw err;
  }
}

// ============================================================
// ACCOUNTS, GRIEVANCES & SECURITY
// ============================================================
async function submitAddAccount() {
  const bank = document.getElementById('new-acc-bank').value.trim();
  const type = document.getElementById('new-acc-type').value;
  const bal = Number(document.getElementById('new-acc-bal').value) || 0;
  const msg = document.getElementById('add-acc-msg');

  if (!bank) {
    msg.textContent = 'Enter bank name.';
    msg.className = 'modal-msg err';
    return;
  }

  try {
    await window.iCashApi.createAccount({ bankName: bank, accountType: type, initialBalance: bal });
    closeModal('add-account');
    showAlertToast(`✓ ${bank} linked successfully.`);
    loadDashboardData();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'modal-msg err';
  }
}

async function setPrimaryAccount(accId) {
  try {
    await window.iCashApi.setPrimaryAccount(accId);
    showAlertToast('Primary account updated.');
    loadDashboardData();
  } catch (err) {
    showAlertToast(err.message || 'Failed to update primary account.', true);
  }
}

async function submitComplaint() {
  const subject = document.getElementById('complaint-subject').value.trim();
  const desc = document.getElementById('complaint-desc').value.trim();
  const category = document.getElementById('complaint-category')?.value || 'General Grievance';
  const msg = document.getElementById('complaint-msg');
  const btn = document.getElementById('complaint-submit-btn');

  if (!subject) {
    msg.textContent = 'Please enter a grievance subject.';
    msg.className = 'modal-msg err';
    return;
  }
  if (!desc) {
    msg.textContent = 'Please describe your grievance in detail.';
    msg.className = 'modal-msg err';
    return;
  }

  if (btn) btn.disabled = true;
  msg.textContent = 'Submitting grievance ticket…';
  msg.className = 'modal-msg';

  try {
    await window.iCashApi.createComplaint({ subject, description: desc, category });
    if (btn) btn.disabled = false;
    document.getElementById('complaint-subject').value = '';
    document.getElementById('complaint-desc').value = '';
    closeModal('complaint');
    showAlertToast('⚖️ Grievance ticket submitted successfully for administrative review.');
    loadComplaintsList();
  } catch (err) {
    if (btn) btn.disabled = false;
    msg.textContent = err.message || 'Failed to submit grievance.';
    msg.className = 'modal-msg err';
  }
}

async function submitInlineComplaint() {
  const category = document.getElementById('support-inline-category')?.value || 'General Grievance';
  const subject = (document.getElementById('support-inline-subject')?.value || '').trim();
  const desc = (document.getElementById('support-inline-desc')?.value || '').trim();
  const msg = document.getElementById('support-inline-msg');
  const btn = document.getElementById('support-inline-btn');

  if (!subject) {
    msg.textContent = 'Please enter a brief subject for your grievance.';
    msg.className = 'modal-msg err';
    return;
  }
  if (!desc) {
    msg.textContent = 'Please enter the incident description.';
    msg.className = 'modal-msg err';
    return;
  }

  if (btn) btn.disabled = true;
  msg.textContent = 'Submitting grievance ticket…';
  msg.className = 'modal-msg';

  try {
    await window.iCashApi.createComplaint({ subject, description: desc, category });
    if (btn) btn.disabled = false;
    document.getElementById('support-inline-subject').value = '';
    document.getElementById('support-inline-desc').value = '';
    msg.textContent = '';
    showAlertToast('⚖️ Grievance ticket submitted successfully. Case registered.');
    loadComplaintsList();
  } catch (err) {
    if (btn) btn.disabled = false;
    msg.textContent = err.message || 'Failed to submit grievance.';
    msg.className = 'modal-msg err';
  }
}

async function loadComplaintsList() {
  try {
    const res = await window.iCashApi.getMyComplaints();
    const tbody = document.getElementById('support-complaints-tbody');
    if (!tbody) return;

    const complaints = res.complaints || [];
    if (complaints.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="5" class="empty">No active grievance tickets on record.</td></tr>';
      return;
    }

    tbody.innerHTML = complaints
      .map((c) => {
        const rawDate = c.createdAt || c.created_at;
        const dateStr = rawDate
          ? new Date(rawDate).toLocaleDateString('en-IN', { dateStyle: 'medium' })
          : 'Today';
        const status = c.status || 'OPEN';
        const resolution =
          c.adminResponse || c.admin_response || 'Under Review by Grievance Officer';
        const isResolved = status === 'RESOLVED';
        const isRejected = status === 'REJECTED';
        const badgeClass = isResolved ? 'completed' : isRejected ? 'failed' : 'pending';

        return `
      <tr>
        <td><strong>${c.subject}</strong></td>
        <td style="color:var(--text-muted);font-size:12.5px;">${c.description}</td>
        <td><span class="status-badge ${badgeClass}">${status}</span></td>
        <td style="font-family:var(--font-mono);font-size:11.5px;color:var(--text-faint);">${dateStr}</td>
        <td style="font-size:12px;color:${isResolved ? 'var(--success)' : 'var(--primary)'};">${resolution}</td>
      </tr>
    `;
      })
      .join('');
  } catch (err) {
    console.error('Complaints load failed:', err);
  }
}

async function loadSecurityEvents() {
  try {
    const res = await window.iCashApi.getSecurityEvents();
    const tbody = document.getElementById('security-events-tbody');
    if (!tbody) return;

    const events = res.events || [];
    if (events.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="4" class="empty">No security anomalies detected. System secure.</td></tr>';
      return;
    }

    tbody.innerHTML = events
      .map((l) => {
        const isCritical =
          l.severity === 'CRITICAL' ||
          l.eventType === 'POLICE_DURESS_ALERT' ||
          l.eventType === 'DURESS_ALERT';
        const isHigh = l.severity === 'HIGH';
        const badgeClass = isCritical ? 'failed' : isHigh ? 'pending' : 'completed';
        const dateStr = l.createdAt
          ? new Date(l.createdAt).toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })
          : 'Recent';

        return `
      <tr style="${isCritical ? 'background:rgba(239, 68, 68, 0.08);' : ''}">
        <td><span style="font-family:var(--font-mono);font-weight:600;${isCritical ? 'color:var(--alert);' : ''}">${l.eventType || l.event_type || 'SECURITY_EVENT'}</span></td>
        <td style="color:${isCritical ? 'var(--alert)' : 'var(--text-muted)'};font-size:12.5px;">${l.description}</td>
        <td><span class="status-badge ${badgeClass}">${l.severity}</span></td>
        <td style="font-family:var(--font-mono);font-size:11.5px;color:var(--text-faint);">${dateStr}</td>
      </tr>
    `;
      })
      .join('');
  } catch (err) {
    console.error('Security events load failed:', err);
  }
}

function populateProfileView() {
  if (!currentUser) return;
  document.getElementById('prof-name').textContent = currentUser.name;
  document.getElementById('prof-phone').textContent = `+91 ${currentUser.phone}`;
  document.getElementById('prof-aadhaar').textContent = `•••• ${currentUser.aadhaarLast4}`;
  document.getElementById('prof-role').textContent = currentUser.role;
  document.getElementById('prof-senior').textContent = currentUser.isSenior
    ? 'Senior Assisted Banking Active'
    : 'Standard Customer';
}

function openDeleteAccountModal() {
  document.getElementById('delete-pin-input').value = '';
  document.getElementById('delete-account-msg').textContent = '';
  document.getElementById('modal-delete-account').classList.add('active');
}

async function confirmDeleteAccount() {
  const btn = document.getElementById('delete-account-btn');
  const msg = document.getElementById('delete-account-msg');
  const pin = document.getElementById('delete-pin-input').value.trim();
  if (!/^[0-9]{4}$/.test(pin)) {
    msg.textContent = 'Enter your 4-digit PIN to confirm.';
    msg.className = 'modal-msg err';
    return;
  }
  if (btn) btn.disabled = true;
  msg.textContent = 'Deleting account… this may take a few seconds.';
  msg.className = 'modal-msg';
  try {
    await window.iCashApi.deleteMe({ pin });
    // Success — clear local state and navigate to welcome
    showAlertToast('Your account has been deleted. Redirecting…');
    // Logout client-side state
    logout();
    // Close modal
    document.getElementById('modal-delete-account').classList.remove('active');
  } catch (err) {
    msg.textContent = err.message || 'Failed to delete account.';
    msg.className = 'modal-msg err';
    if (btn) btn.disabled = false;
  }
}

async function logout() {
  try {
    if (window.iCashApi && typeof window.iCashApi.logout === 'function') {
      await window.iCashApi.logout();
    }
  } catch (e) {}
  setCurrentUser(null);
  currentAccounts = [];
  currentTransactions = [];
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('icash_token');
    localStorage.removeItem('icash_current_user');
  }
  goTo('screen-welcome');
}
window.logout = logout;

function renderAccountsView() {
  renderAccountsGrid(currentAccounts);
}

function renderAllTransactionsView() {
  renderTransactionsTable();
}

// ============================================================
// EMERGENCY & AUTHORIZED REPRESENTATIVE WITHDRAWAL ENGINE
// ============================================================

let _emgCountdownInterval = null;
let _emgTimeRemaining = 300; // 5 minutes in seconds

function openEmergencyWithdrawalModal() {
  const modal = document.getElementById('modal-emergency-withdrawal');
  if (!modal) return;
  modal.classList.add('active');
  resetEmergencyStep1();
}

// Alias for legacy senior collection button
function openDelegateCollectModal() {
  openEmergencyWithdrawalModal();
}

function closeEmergencyWithdrawalModal() {
  if (_emgCountdownInterval) {
    clearInterval(_emgCountdownInterval);
    _emgCountdownInterval = null;
  }
  const modal = document.getElementById('modal-emergency-withdrawal');
  if (modal) modal.classList.remove('active');
}

function resetEmergencyStep1() {
  if (_emgCountdownInterval) {
    clearInterval(_emgCountdownInterval);
    _emgCountdownInterval = null;
  }
  document.getElementById('emg-step-1').style.display = 'block';
  document.getElementById('emg-step-2').style.display = 'none';
  document.getElementById('emg-step-3').style.display = 'none';
  document.getElementById('emg-msg-1').textContent = '';
  document.getElementById('emg-msg-2').textContent = '';
  document.getElementById('emg-otp-input').value = '';
}

async function submitEmergencyWithdrawalRequest() {
  const ident = document.getElementById('emg-acc-identifier').value.trim();
  const authName = document.getElementById('emg-auth-name').value.trim();
  const authPhone = document.getElementById('emg-auth-phone').value.trim();
  const authIdType = document.getElementById('emg-auth-idtype').value;
  const authIdNum = document.getElementById('emg-auth-idnum').value.trim();
  const amount = Number(document.getElementById('emg-amount').value);
  const reason = document.getElementById('emg-reason').value.trim();
  const msg = document.getElementById('emg-msg-1');
  const btn = document.getElementById('emg-submit-req-btn');

  if (!ident || ident.length < 2) {
    msg.textContent =
      "Please enter the account holder's identifier (mobile, Aadhaar last 4, or full name).";
    msg.className = 'modal-msg err';
    return;
  }
  if (!authName || authName.length < 2) {
    msg.textContent = 'Please enter your full name as the authorized representative.';
    msg.className = 'modal-msg err';
    return;
  }
  if (!authPhone || !/^\d{10}$/.test(authPhone)) {
    msg.textContent = 'Please enter your valid 10-digit mobile number.';
    msg.className = 'modal-msg err';
    return;
  }
  if (!amount || amount <= 0) {
    msg.textContent = 'Please enter a valid withdrawal amount.';
    msg.className = 'modal-msg err';
    return;
  }

  msg.textContent = 'Verifying emergency authorization with banking core…';
  msg.className = 'modal-msg';
  if (btn) btn.disabled = true;

  try {
    const res = await window.iCashApi.requestEmergencyWithdrawal({
      accountIdentifier: ident,
      authorizedName: authName,
      authorizedPhone: authPhone,
      authorizedIdType: authIdType,
      authorizedIdNumber: authIdNum || undefined,
      amount,
      reason: reason || 'Emergency Cash Withdrawal',
    });

    if (btn) btn.disabled = false;

    if (res.ok) {
      window._currentEmgRequestId = res.requestId;
      window._currentEmgResponse = res;

      // Update Step 2 UI
      document.getElementById('emg-holder-phone-badge').textContent =
        res.accountHolderPhoneMasked || '+91 ••••••0000';

      const devPill = document.getElementById('emg-dev-otp-banner');
      if (res.devOtp) {
        devPill.style.display = 'inline-flex';
        devPill.innerHTML = `<span>⚡ SMS Dispatched: OTP is <strong>${res.devOtp}</strong></span>`;
      } else {
        devPill.style.display = 'none';
      }

      document.getElementById('emg-step-1').style.display = 'none';
      document.getElementById('emg-step-2').style.display = 'block';
      document.getElementById('emg-step-3').style.display = 'none';
      document.getElementById('emg-otp-input').value = '';
      document.getElementById('emg-otp-input').focus();

      // Start 5-minute countdown (300 seconds)
      startEmergencyCountdown(res.expiresInSeconds || 300);
    }
  } catch (err) {
    if (btn) btn.disabled = false;
    msg.textContent = err.message || 'Authorization failed. Please check details.';
    msg.className = 'modal-msg err';
  }
}

function startEmergencyCountdown(totalSeconds) {
  if (_emgCountdownInterval) clearInterval(_emgCountdownInterval);
  _emgTimeRemaining = totalSeconds;

  const digitsEl = document.getElementById('emg-timer-digits');
  const barEl = document.getElementById('emg-timer-progress');
  const msgEl = document.getElementById('emg-msg-2');
  const verifyBtn = document.getElementById('emg-verify-otp-btn');
  const circumference = 2 * Math.PI * 44; // r=44 => ~276.46

  function updateDisplay() {
    const mins = Math.floor(_emgTimeRemaining / 60);
    const secs = _emgTimeRemaining % 60;
    if (digitsEl) {
      digitsEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    if (barEl) {
      const progressFraction = _emgTimeRemaining / totalSeconds;
      const offset = circumference * (1 - progressFraction);
      barEl.style.strokeDashoffset = offset;
      if (_emgTimeRemaining <= 60) {
        barEl.style.stroke = '#ef4444';
      } else if (_emgTimeRemaining <= 180) {
        barEl.style.stroke = '#f59e0b';
      } else {
        barEl.style.stroke = '#6366f1';
      }
    }

    if (_emgTimeRemaining <= 0) {
      clearInterval(_emgCountdownInterval);
      _emgCountdownInterval = null;
      if (msgEl) {
        msgEl.textContent =
          '⚠️ The 5-minute authorization window has expired. Please initiate a new request.';
        msgEl.className = 'modal-msg err';
      }
      if (verifyBtn) verifyBtn.disabled = true;
    } else {
      _emgTimeRemaining--;
    }
  }

  if (verifyBtn) verifyBtn.disabled = false;
  updateDisplay();
  _emgCountdownInterval = setInterval(updateDisplay, 1000);
}

async function submitEmergencyWithdrawalOtp() {
  const otp = document.getElementById('emg-otp-input').value.trim();
  const msg = document.getElementById('emg-msg-2');
  const btn = document.getElementById('emg-verify-otp-btn');

  if (!otp || !/^\d{6}$/.test(otp)) {
    msg.textContent = 'Please enter the valid 6-digit OTP received by the account holder.';
    msg.className = 'modal-msg err';
    return;
  }

  msg.textContent = 'Verifying OTP & authorizing instant fund release…';
  msg.className = 'modal-msg';
  if (btn) btn.disabled = true;

  try {
    const res = await window.iCashApi.verifyEmergencyWithdrawal({
      requestId: window._currentEmgRequestId,
      otp,
    });

    if (btn) btn.disabled = false;

    if (res.ok) {
      if (_emgCountdownInterval) {
        clearInterval(_emgCountdownInterval);
        _emgCountdownInterval = null;
      }

      // Populate Step 3 Voucher
      document.getElementById('emg-receipt-amt').textContent =
        `₹${Number(res.amount).toLocaleString('en-IN')}`;
      document.getElementById('emg-receipt-ref').textContent =
        res.referenceNumber || res.transactionId || 'TX_EMERGENCY';
      document.getElementById('emg-receipt-date').textContent = new Date().toLocaleString('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
      document.getElementById('emg-receipt-holder').textContent =
        res.accountHolderName || 'Account Holder';
      document.getElementById('emg-receipt-rep').textContent =
        `${res.authorizedPersonName} (${res.authorizedPersonPhone})`;
      document.getElementById('emg-receipt-idproof').textContent = res.authorizedIdNumber
        ? `${res.authorizedIdType || 'Gov ID'}: ${res.authorizedIdNumber}`
        : 'Authorized Representative Verified ✓';

      document.getElementById('emg-step-1').style.display = 'none';
      document.getElementById('emg-step-2').style.display = 'none';
      document.getElementById('emg-step-3').style.display = 'block';

      showAlertToast(
        `🚨 Emergency Cash Release Authorized: ₹${Number(res.amount).toLocaleString('en-IN')} released to ${res.authorizedPersonName}.`
      );

      // Refresh dashboard if user is signed in
      if (typeof loadDashboardData === 'function') loadDashboardData();
    }
  } catch (err) {
    if (btn) btn.disabled = false;
    msg.textContent =
      err.message ||
      'OTP verification failed. Please check the code received by the account holder.';
    msg.className = 'modal-msg err';
  }
}

async function submitPaymentRequest() {
  const amt = Number(document.getElementById('payreq-amt').value);
  const desc = document.getElementById('payreq-desc').value.trim();
  const msg = document.getElementById('payreq-msg');

  if (!amt || amt <= 0) {
    msg.textContent = 'Enter valid invoice amount.';
    msg.className = 'modal-msg err';
    return;
  }

  try {
    const res = await window.iCashApi.createPaymentRequest({
      amount: amt,
      description: desc || 'POS Checkout',
    });
    closeModal('payment-request');
    showAlertToast(
      `📱 POS Checkout Reference Generated: [ ${res.paymentRequest?.reference_code || 'POS_REF'} ]`
    );
    loadMerchantPOSList();
  } catch (err) {
    msg.textContent = err.message || 'Failed to create payment request.';
    msg.className = 'modal-msg err';
  }
}

async function loadMerchantPOSList() {
  const container = document.getElementById('payments-pos-list');
  if (!container) return;
  try {
    const res = await window.iCashApi.getMerchantProfile();
    const reqs = res.merchant?.paymentRequests || [];
    if (reqs.length === 0) {
      container.innerHTML = '<div class="empty">No active checkout codes.</div>';
      return;
    }
    container.innerHTML = reqs
      .map(
        (r) => `
      <div style="background:var(--bg-inset);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <strong>${r.description || 'POS Checkout'}</strong>
          <div style="font-size:11px;color:var(--primary);font-family:var(--font-mono);">Code: ${r.reference_code}</div>
        </div>
        <strong style="color:var(--success);">${fmtMoney(r.amount)}</strong>
      </div>
    `
      )
      .join('');
  } catch (e) {
    container.innerHTML = '<div class="empty">POS gateway ready.</div>';
  }
}

// ============================================================
// UTILITIES & THREE.JS BACKGROUND
// ============================================================
function fmtMoney(amt) {
  const n = Number(amt) || 0;
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function initials(name) {
  if (!name) return 'IC';
  return name
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

let toastTimer = null;
function showAlertToast(msg, isErr = false) {
  const toast = document.getElementById('alert-toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = isErr ? 'err active' : 'active';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('active');
  }, 4000);
}

function createScanRingRenderer(canvas) {
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  let angle = 0;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const r = Math.min(cx, cy) - 10;

    ctx.beginPath();
    ctx.arc(cx, cy, r, angle, angle + Math.PI * 1.3);
    ctx.strokeStyle = '#2DD4BF';
    ctx.lineWidth = 3;
    ctx.shadowBlur = 8;
    ctx.shadowColor = '#2DD4BF';
    ctx.stroke();

    angle += 0.05;
    requestAnimationFrame(draw);
  }
  canvas.width = canvas.parentElement.clientWidth || 240;
  canvas.height = canvas.parentElement.clientHeight || 240;
  draw();
  return { canvas };
}

function initThreeBackground() {
  const canvas = document.getElementById('canvas3d');
  if (!canvas || typeof THREE === 'undefined') return;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);

  const particlesCount = 200;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(particlesCount * 3);

  for (let i = 0; i < particlesCount * 3; i++) {
    positions[i] = (Math.random() - 0.5) * 20;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    color: 0x2dd4bf,
    size: 0.05,
    transparent: true,
    opacity: 0.4,
  });

  const particles = new THREE.Points(geometry, material);
  scene.add(particles);
  camera.position.z = 8;

  function animate() {
    requestAnimationFrame(animate);
    particles.rotation.y += 0.0008;
    particles.rotation.x += 0.0004;
    renderer.render(scene, camera);
  }
  animate();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}
