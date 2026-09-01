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
  email: z.string().email('A valid email address is required.').max(254, 'Email address is too long.'),
  emailVerificationTicket: z.string().min(1, 'Email verification is required. Please verify your email before registering.'),
  aadhaarNumber: z.string().regex(/^\d{12}$/, 'Aadhaar number must be 12 digits.'),
  dob: z.string().optional(),
  role: z.enum(['USER', 'MERCHANT', 'ADMIN']).optional(),
  pin: digits4,
  emergencyPin: digits4.optional().or(z.literal('')).optional(),
  isSenior: z.boolean().optional(),
  emergencyContactName: z.string().optional(),
  emergencyContactPhone: z.string().optional().or(z.literal('')).optional(),
  emergencyContactRelation: z.string().optional(),
  emergencyContacts: z.array(z.any()).optional().default([]),
  descriptors: z.array(z.array(z.number())).optional().default([]),
});

const loginAadhaarSchema = z.object({
  aadhaarLast4,
});

const loginPinSchema = z.object({
  userId: z.string().uuid('Invalid user identifier.'),
  pin: digits4,
});

const loginBiometricSchema = z.object({
  userId: z.string().uuid('Invalid user identifier.').or(z.string().min(1)),
  liveDescriptor: z.array(z.number()).min(1, 'A live face descriptor is required.'),
});

// Confirm account deletion by providing current PIN
const confirmDeleteSchema = z.object({
  pin: digits4,
});

// ---------------- Biometric ----------------

const biometricEnrollSchema = z.object({
  descriptors: z
    .array(z.array(z.number()))
    .min(1, 'At least one face descriptor sample is required.'),
});

const biometricVerifySchema = z.object({
  liveDescriptor: z.array(z.number()).min(1, 'A live face descriptor is required.'),
  userId: z.string().uuid().optional(),
});

// ---------------- Accounts ----------------

const accountCreateSchema = z.object({
  bankName: z.string().min(2, 'Bank name is required.'),
  accountType: z.enum(['SAVINGS', 'CURRENT', 'VIRTUAL']).optional().default('SAVINGS'),
  initialBalance: z.number().nonnegative().optional().default(0),
  isPrimary: z.boolean().optional().default(false),
});

const accountUpdateSchema = z.object({
  bankName: z.string().min(2).optional(),
  isPrimary: z.boolean().optional(),
  status: z.enum(['ACTIVE', 'FROZEN', 'CLOSED']).optional(),
});

// ---------------- Transactions ----------------

const transactionCreateSchema = z.object({
  accountId: z.string().optional(),
  transactionType: z.enum(['WITHDRAWAL', 'DEPOSIT', 'TRANSFER', 'PAYMENT', 'REFUND']),
  amount: z
    .number()
    .positive('Amount must be greater than zero.')
    .or(
      z
        .string()
        .regex(/^\d+(\.\d+)?$/)
        .transform(Number)
    ),
  description: z.string().optional(),
  recipientName: z.string().optional(),
  recipientAccount: z.string().optional(),
  recipientPhone: z.string().optional(),
  recipientUserId: z.string().optional(),
  pin: z.string().optional(),
  verifyMethod: z.enum(['FACE', 'PIN']).optional().default('PIN'),
});

const delegateGenerateSchema = z.object({
  amount: z.number().positive('Enter a valid authorization amount.').or(z.string()),
});

const delegateClaimSchema = z.object({
  seniorName: z.string().min(2, "Senior citizen's full name is required."),
  otp: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits.'),
});

const emergencyWithdrawalRequestSchema = z.object({
  accountIdentifier: z.string().min(2, 'Account identifier is required.'),
  authorizedName: z.string().min(2, 'Authorized person name is required.'),
  authorizedPhone: z.string().min(8, 'Authorized person phone number is required.'),
  authorizedIdType: z.string().optional(),
  authorizedIdNumber: z.string().optional(),
  amount: z.number().positive('Amount must be positive.').or(z.string()),
  reason: z.string().optional(),
});

const emergencyWithdrawalVerifySchema = z.object({
  requestId: z.string().min(1, 'Request identifier is required.'),
  otp: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits.'),
});

const emergencyContactsUpdateSchema = z.object({
  contacts: z.array(
    z.object({
      name: z.string().min(2, 'Contact name is required.'),
      phone: z.string().min(8, 'Contact phone is required.'),
      relation: z.string().optional(),
      idType: z.string().optional().nullable(),
      idNumber: z.string().optional().nullable(),
    })
  ),
});

// ---------------- Complaints ----------------

const complaintCreateSchema = z.object({
  transactionId: z.string().optional().nullable(),
  subject: z.string().min(1, 'Subject is required.'),
  description: z.string().min(1, 'Please describe the issue.'),
  category: z.string().optional(),
});

const complaintResolveSchema = z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'REJECTED']),
  adminResponse: z.string().optional(),
});

// ---------------- Merchant ----------------

const merchantPaymentRequestSchema = z.object({
  amount: z.number().positive('Amount must be greater than zero.'),
  description: z.string().optional(),
});

const merchantRefundSchema = z.object({
  transactionId: z.string().uuid(),
  reason: z.string().min(3, 'A refund reason is required.'),
});

// ---------------- Admin ----------------

const userStatusUpdateSchema = z.object({
  status: z.enum(['ACTIVE', 'LOCKED', 'SUSPENDED']),
});

// ---------------- Security ----------------

const securityEventSchema = z.object({
  eventType: z.string().min(2),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  description: z.string().min(2),
  deviceReference: z.string().optional(),
});

module.exports = {
  registerSchema,
  loginAadhaarSchema,
  loginPinSchema,
  loginBiometricSchema,
  confirmDeleteSchema,
  biometricEnrollSchema,
  biometricVerifySchema,
  accountCreateSchema,
  accountUpdateSchema,
  transactionCreateSchema,
  delegateGenerateSchema,
  delegateClaimSchema,
  emergencyWithdrawalRequestSchema,
  emergencyWithdrawalVerifySchema,
  emergencyContactsUpdateSchema,
  complaintCreateSchema,
  complaintResolveSchema,
  merchantPaymentRequestSchema,
  merchantRefundSchema,
  userStatusUpdateSchema,
  securityEventSchema,
};
