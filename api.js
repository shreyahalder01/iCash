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
  'http://localhost:4002'
];

let currentBase = (typeof window !== 'undefined' && window.__API_BASE__) || '';

async function detectApiBase() {
  if (currentBase !== '') return currentBase;
  if (typeof window !== 'undefined' && window.location && (window.location.protocol === 'http:' || window.location.protocol === 'https:')) {
    if (['4000', '4001', '4002', '4003'].includes(window.location.port)) {
      currentBase = '';
      return currentBase;
    }
  }

  for (const base of API_BASE_CANDIDATES) {
    try {
      const res = await fetch(`${base || ''}/api/health`, { cache: 'no-store' });
      if (res.ok) {
        currentBase = base;
        return currentBase;
      }
    } catch (e) {
      // try next candidate
    }
  }
  return 'http://localhost:4000';
}

async function request(endpoint, options = {}) {
  const base = await detectApiBase();
  const url = `${base}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
  
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  const config = {
    ...options,
    headers,
    credentials: 'include' // Always include HTTP-only cookies
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
        throw new Error('Unable to connect to banking services. Please ensure the backend server is running on http://localhost:4000.');
      }
    } else {
      throw new Error('Unable to connect to banking services. Please ensure the backend server is running on http://localhost:4000.');
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
    data = { message: await response.text() };
  }

  if (!response.ok) {
    const errorMsg = data.message || data.error || (data.errors && data.errors[0]?.message) || `Request failed with status ${response.status}`;
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
  loginEmergencyPin: (data) => request('/api/auth/login-emergency-pin', { method: 'POST', body: data }),
  verifyPhoneEmail: (user_json_url) => request('/api/auth/phone-email-verify', { method: 'POST', body: { user_json_url } }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  getMe: () => request('/api/auth/me', { method: 'GET' }),
  refreshToken: () => request('/api/auth/refresh', { method: 'POST' }),

  // OTP
  sendOtp: (mobile, purpose) => request('/api/otp/send', { method: 'POST', body: { mobile, purpose } }),
  verifyOtp: (mobile, purpose, code) => request('/api/otp/verify', { method: 'POST', body: { mobile, purpose, code } }),

  // Biometric
  enrollBiometric: (data) => request('/api/biometric/enroll', { method: 'POST', body: data }),
  verifyBiometric: (data) => request('/api/biometric/verify', { method: 'POST', body: data }),
  getBiometricProfile: (userId) => request(`/api/biometric/profile/${userId}`, { method: 'GET' }),

  // Accounts
  getAccounts: () => request('/api/accounts', { method: 'GET' }),
  createAccount: (data) => request('/api/accounts', { method: 'POST', body: data }),
  updateAccount: (id, data) => request(`/api/accounts/${id}`, { method: 'PATCH', body: data }),
  setPrimaryAccount: (id) => request(`/api/accounts/${id}`, { method: 'PATCH', body: { isPrimary: true } }),
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
      transactionType: data.transactionType || data.type
    };
    return request('/api/transactions', { method: 'POST', body: payload });
  },
  topUpDemoFunds: (amount = 5000) => request('/api/transactions/topup', { method: 'POST', body: { amount } }),
  
  // Delegated Senior Citizen Withdrawal
  generateDelegateOtp: (data) => request('/api/transactions/delegate/generate', { method: 'POST', body: data }),
  claimDelegateWithdrawal: (data) => request('/api/transactions/delegate/claim', { method: 'POST', body: data }),

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
  updateUserStatus: (id, status) => request(`/api/admin/users/${id}/status`, { method: 'PATCH', body: { status } }),
  getAdminTransactions: () => request('/api/admin/transactions', { method: 'GET' }),
  getAdminSecurityEvents: () => request('/api/admin/security-events', { method: 'GET' }),
  getAdminComplaints: () => request('/api/admin/complaints', { method: 'GET' }),
  resolveComplaint: (id, data) => request(`/api/admin/complaints/${id}`, { method: 'PATCH', body: data }),

  // Merchant
  getMerchantProfile: () => request('/api/merchant/profile', { method: 'GET' }),
  createPaymentRequest: (data) => request('/api/merchant/payment-requests', { method: 'POST', body: data }),
  getMerchantTransactions: () => request('/api/merchant/transactions', { method: 'GET' }),
  getMerchantSettlements: () => request('/api/merchant/settlements', { method: 'GET' }),
  processRefund: (data) => request('/api/merchant/refunds', { method: 'POST', body: data })
};

if (typeof window !== 'undefined') {
  window.iCashApi = api;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
