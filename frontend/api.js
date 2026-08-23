/**
 * iCash API Client
 * Handles communication with the Express.js backend.
 * Uses credentials: 'include' for secure HTTP-only cookie session handling.
 */

const API_BASE_CANDIDATES = [
  '', // Same origin if served from backend
  'http://localhost:4000',
  'http://127.0.0.1:4000',
  'http://localhost:4001',
  'http://127.0.0.1:4001',
  'http://localhost:4002',
];

let currentBase = (typeof window !== 'undefined' && window.__API_BASE__) || '';

async function detectApiBase() {
  if (currentBase !== '') return currentBase;

  // 1. If served over HTTP/HTTPS, same-origin relative URLs are always best
  if (
    typeof window !== 'undefined' &&
    window.location &&
    (window.location.protocol === 'http:' || window.location.protocol === 'https:')
  ) {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (res.ok) {
        currentBase = '';
        return currentBase;
      }
    } catch (e) {
      // If same-origin health failed, try candidates
    }
  }

  // 2. Try candidate URLs (for file:// protocol or standalone development)
  for (const base of API_BASE_CANDIDATES) {
    try {
      const res = await fetch(`${base}/api/health`, { cache: 'no-store' });
      if (res.ok) {
        currentBase = base;
        return currentBase;
      }
    } catch (e) {
      // Try next
    }
  }

  currentBase = '';
  return currentBase;
}

async function request(endpoint, options = {}) {
  const base = await detectApiBase();
  const url = `${base}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;

  // Get stored token if any
  const storedToken =
    typeof localStorage !== 'undefined' ? localStorage.getItem('icash_token') : null;

  const headers = {
    'Content-Type': 'application/json',
    ...(storedToken ? { Authorization: `Bearer ${storedToken}` } : {}),
    ...(options.headers || {}),
  };

  const config = {
    ...options,
    headers,
    credentials: 'include', // Always include HTTP-only cookies as well
  };

  if (config.body && typeof config.body === 'object' && !(config.body instanceof FormData)) {
    config.body = JSON.stringify(config.body);
  }

  let response;
  try {
    response = await fetch(url, config);
  } catch (netErr) {
    if (base !== 'http://localhost:4000') {
      try {
        const fallbackUrl = `http://localhost:4000${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
        response = await fetch(fallbackUrl, config);
        currentBase = 'http://localhost:4000';
      } catch (fallbackErr) {
        throw new Error(
          'Unable to connect to banking services. Please ensure the backend server is running on http://localhost:4000.'
        );
      }
    } else {
      throw new Error(
        'Unable to connect to banking services. Please ensure the backend server is running on http://localhost:4000.'
      );
    }
  }

  let data;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      data = await response.json();
    } catch (e) {
      data = {};
    }
  } else {
    // No JSON API answered this request — most likely the static host's
    // SPA/404 fallback served back index.html (or some other HTML/plain
    // page) instead of a real API response. Never surface that raw body
    // to the UI: log it for debugging and treat the request as failed.
    const rawText = await response.text();
    console.error(
      `[iCash API] Expected JSON from ${url} but got "${contentType || 'unknown content-type'}". ` +
        `This usually means no backend is reachable at this origin. First 300 chars of response:`,
      rawText.slice(0, 300)
    );
    const error = new Error(
      'Unable to reach banking services right now. Please try again shortly, or contact support if this continues.'
    );
    error.status = response.status;
    error.nonJson = true;
    throw error;
  }

  // Automatically save token on successful login or register
  if (response.ok && data && data.token && typeof localStorage !== 'undefined') {
    localStorage.setItem('icash_token', data.token);
  }

  // Clear token on logout
  if (endpoint.includes('/logout') && typeof localStorage !== 'undefined') {
    localStorage.removeItem('icash_token');
  }

  if (!response.ok) {
    if (response.status === 401 && typeof localStorage !== 'undefined') {
      // Clear potentially invalid token
      localStorage.removeItem('icash_token');
    }
    const errorMsg =
      data.message ||
      data.error ||
      (data.errors && data.errors[0]?.message) ||
      `Request failed with status ${response.status}`;
    const error = new Error(errorMsg);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

const api = {
  // Auth
  register: (userData) => request('/api/auth/register', { method: 'POST', body: userData }),
  loginAadhaar: (data) => request('/api/auth/login-aadhaar', { method: 'POST', body: data }),
  loginPin: (data) => request('/api/auth/login-pin', { method: 'POST', body: data }),
  loginEmergencyPin: (data) =>
    request('/api/auth/login-emergency-pin', { method: 'POST', body: data }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  getMe: () => request('/api/auth/me', { method: 'GET' }),
  refreshToken: () => request('/api/auth/refresh', { method: 'POST' }),
  // Delete own account (requires PIN confirmation)
  deleteMe: (data) => request('/api/auth/me', { method: 'DELETE', body: data }),

  // OTP
  sendOtp: (mobile, purpose) =>
    request('/api/otp/send', { method: 'POST', body: { mobile, purpose } }),
  verifyOtp: (mobile, purpose, code) =>
    request('/api/otp/verify', { method: 'POST', body: { mobile, purpose, code } }),

  // Biometric
  enrollBiometric: (data) => request('/api/biometric/enroll', { method: 'POST', body: data }),
  verifyBiometric: (data) => request('/api/biometric/verify', { method: 'POST', body: data }),
  getBiometricProfile: (userId) => request(`/api/biometric/profile/${userId}`, { method: 'GET' }),

  // Accounts
  getAccounts: () => request('/api/accounts', { method: 'GET' }),
  createAccount: (data) => request('/api/accounts', { method: 'POST', body: data }),
  updateAccount: (id, data) => request(`/api/accounts/${id}`, { method: 'PATCH', body: data }),
  setPrimaryAccount: (id) =>
    request(`/api/accounts/${id}`, { method: 'PATCH', body: { isPrimary: true } }),
  deleteAccount: (id) => request(`/api/accounts/${id}`, { method: 'DELETE' }),

  // Transactions
  getTransactions: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return request(`/api/transactions${query ? '?' + query : ''}`, { method: 'GET' });
  },
  getTransactionById: (id) => request(`/api/transactions/${id}`, { method: 'GET' }),
  createTransaction: (data) => {
    const payload = {
      ...data,
      transactionType: data.transactionType || data.type,
    };
    return request('/api/transactions', { method: 'POST', body: payload });
  },
  topUpDemoFunds: (amount = 5000) =>
    request('/api/transactions/topup', { method: 'POST', body: { amount } }),

  // Delegated Senior Citizen Withdrawal
  generateDelegateOtp: (data) =>
    request('/api/transactions/delegate/generate', { method: 'POST', body: data }),
  claimDelegateWithdrawal: (data) =>
    request('/api/transactions/delegate/claim', { method: 'POST', body: data }),

  // Security
  getSecurityStatus: () => request('/api/security/status', { method: 'GET' }),
  getSecurityEvents: () => request('/api/security/events', { method: 'GET' }),
  reportSecurityEvent: (data) => request('/api/security/events', { method: 'POST', body: data }),

  // Complaints
  getComplaints: () => request('/api/complaints', { method: 'GET' }),
  getMyComplaints: () => request('/api/complaints', { method: 'GET' }),
  createComplaint: (data) => request('/api/complaints', { method: 'POST', body: data }),

  // Admin
  getAdminUsers: () => request('/api/admin/users', { method: 'GET' }),
  getAdminUserById: (id) => request(`/api/admin/users/${id}`, { method: 'GET' }),
  updateUserStatus: (id, status) =>
    request(`/api/admin/users/${id}/status`, { method: 'PATCH', body: { status } }),
  getAdminTransactions: () => request('/api/admin/transactions', { method: 'GET' }),
  getAdminSecurityEvents: () => request('/api/admin/security-events', { method: 'GET' }),
  getAdminComplaints: () => request('/api/admin/complaints', { method: 'GET' }),
  resolveComplaint: (id, data) =>
    request(`/api/admin/complaints/${id}`, { method: 'PATCH', body: data }),

  // Merchant
  getMerchantProfile: () => request('/api/merchant/profile', { method: 'GET' }),
  createPaymentRequest: (data) =>
    request('/api/merchant/payment-requests', { method: 'POST', body: data }),
  getMerchantTransactions: () => request('/api/merchant/transactions', { method: 'GET' }),
  getMerchantSettlements: () => request('/api/merchant/settlements', { method: 'GET' }),
  processRefund: (data) => request('/api/merchant/refunds', { method: 'POST', body: data }),

  // Real-Time Liveness Server (Flask + OpenCV + dlib)
  liveness: {
    baseUrl: 'http://127.0.0.1:5001',
    start: async () => {
      try {
        const res = await fetch('http://127.0.0.1:5001/liveness/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        return await res.json();
      } catch (e) {
        return null;
      }
    },
    sendFrame: async (sessionId, base64Image) => {
      try {
        const res = await fetch('http://127.0.0.1:5001/liveness/frame', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, image: base64Image }),
        });
        return await res.json();
      } catch (e) {
        return null;
      }
    },
    status: async (sessionId) => {
      try {
        const res = await fetch(
          `http://127.0.0.1:5001/liveness/status?session_id=${encodeURIComponent(sessionId)}`
        );
        return await res.json();
      } catch (e) {
        return null;
      }
    },
    reset: async (sessionId) => {
      try {
        await fetch('http://127.0.0.1:5001/liveness/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId }),
        });
      } catch {
        // Reset call failed or server offline — safe to ignore
      }
    },
  },
};

if (typeof window !== 'undefined') {
  window.iCashApi = api;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}