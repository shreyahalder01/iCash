/**
 * Zod request validation schemas.
 * Used by middleware/validateMiddleware.js via validateRequest(schema).
 */
const { z } = require('zod');

const mobile10 = z.string().regex(/^\d{10}$/, 'Mobile number must be exactly 10 digits.');
const digits4 = z.string().regex(/^\d{4}$/, 'Must be exactly 4 digits.');
const aadhaarLast4 = z.string().regex(/^\d{4}$/, 'Aadhaar last 4 digits must be numeric.');

// ---------------- Auth ----------------

const registerSchema = z.object({
  fullName: z.string().min(2, 'Full name is required.'),
  phone: mobile10,
  email: z.string().email().optional().or(z.literal('')).optional(),
  aadhaarNumber: z.string().regex(/^\d{12}$/, 'Aadhaar number must be 12 digits.'),
  dob: z.string().optional(),
  role: z.enum(['USER', 'MERCHANT', 'ADMIN']).optional(),
  pin: digits4,
  emergencyPin: digits4.optional(),
  isSenior: z.boolean().optional(),
  emergencyContactName: z.string().optional(),
  emergencyContactPhone: mobile10.optional().or(z.literal('')).optional(),
  descriptors: z.array(z.array(z.number())).optional().default([])
});

const loginAadhaarSchema = z.object({
  aadhaarLast4
});

const loginPinSchema = z.object({
  userId: z.string().uuid('Invalid user identifier.'),
  pin: digits4
});


// ---------------- Biometric ----------------

const biometricEnrollSchema = z.object({
  descriptors: z.array(z.array(z.number())).min(1, 'At least one face descriptor sample is required.')
});

const biometricVerifySchema = z.object({
  liveDescriptor: z.array(z.number()).min(1, 'A live face descriptor is required.'),
  userId: z.string().uuid().optional()
});

// ---------------- Accounts ----------------

const accountCreateSchema = z.object({
  bankName: z.string().min(2, 'Bank name is required.'),
  accountType: z.enum(['SAVINGS', 'CURRENT', 'VIRTUAL']).optional().default('SAVINGS'),
  initialBalance: z.number().nonnegative().optional().default(0),
  isPrimary: z.boolean().optional().default(false)
});

const accountUpdateSchema = z.object({
  bankName: z.string().min(2).optional(),
  isPrimary: z.boolean().optional(),
  status: z.enum(['ACTIVE', 'FROZEN', 'CLOSED']).optional()
});

// ---------------- Transactions ----------------

const transactionCreateSchema = z.object({
  accountId: z.string().uuid().optional(),
  transactionType: z.enum(['WITHDRAWAL', 'DEPOSIT', 'TRANSFER', 'PAYMENT', 'REFUND']),
  amount: z.number().positive('Amount must be greater than zero.'),
  description: z.string().optional(),
  recipientName: z.string().optional(),
  recipientAccount: z.string().optional(),
  recipientUserId: z.string().uuid().optional(),
  verifyMethod: z.enum(['FACE', 'PIN']).optional().default('PIN')
});

const delegateGenerateSchema = z.object({
  amount: z.number().positive('Enter a valid authorization amount.')
});

const delegateClaimSchema = z.object({
  seniorName: z.string().min(2, "Senior citizen's full name is required."),
  otp: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits.')
});

// ---------------- Complaints ----------------

const complaintCreateSchema = z.object({
  transactionId: z.string().uuid().optional(),
  subject: z.string().min(3, 'Subject is required.'),
  description: z.string().min(5, 'Please describe the issue in more detail.')
});

const complaintResolveSchema = z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'REJECTED']),
  adminResponse: z.string().optional()
});

// ---------------- Merchant ----------------

const merchantPaymentRequestSchema = z.object({
  amount: z.number().positive('Amount must be greater than zero.'),
  description: z.string().optional()
});

const merchantRefundSchema = z.object({
  transactionId: z.string().uuid(),
  reason: z.string().min(3, 'A refund reason is required.')
});

// ---------------- Admin ----------------

const userStatusUpdateSchema = z.object({
  status: z.enum(['ACTIVE', 'LOCKED', 'SUSPENDED'])
});

// ---------------- Security ----------------

const securityEventSchema = z.object({
  eventType: z.string().min(2),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  description: z.string().min(2),
  deviceReference: z.string().optional()
});

module.exports = {
  registerSchema,
  loginAadhaarSchema,
  loginPinSchema,
  biometricEnrollSchema,
  biometricVerifySchema,
  accountCreateSchema,
  accountUpdateSchema,
  transactionCreateSchema,
  delegateGenerateSchema,
  delegateClaimSchema,
  complaintCreateSchema,
  complaintResolveSchema,
  merchantPaymentRequestSchema,
  merchantRefundSchema,
  userStatusUpdateSchema,
  securityEventSchema
};
