const express = require('express');
const router = express.Router();
const TransactionController = require('../controllers/transactionController');
const { authenticate } = require('../middleware/authMiddleware');
const { validateRequest } = require('../middleware/validateMiddleware');
const { transactionLimiter } = require('../middleware/rateLimitMiddleware');
const {
  transactionCreateSchema,
  delegateGenerateSchema,
  delegateClaimSchema,
  emergencyWithdrawalRequestSchema,
  emergencyWithdrawalVerifySchema,
  emergencyContactsUpdateSchema,
} = require('../utils/validator');

// ── Public Routes for Authorized Representative & Emergency Cash ────────────

// 1. Authorized person requests emergency withdrawal -> dispatches 5-min OTP to account holder's registered mobile
router.post(
  '/emergency-withdrawal/request',
  validateRequest(emergencyWithdrawalRequestSchema),
  TransactionController.requestEmergencyWithdrawal
);

// 2. Authorized person enters 6-digit OTP received by account holder to release cash
router.post(
  '/emergency-withdrawal/verify',
  validateRequest(emergencyWithdrawalVerifySchema),
  TransactionController.verifyEmergencyWithdrawal
);

// Legacy aliases for backward compatibility
router.post(
  '/delegate/claim',
  validateRequest(delegateClaimSchema),
  TransactionController.claimDelegateWithdrawal
);

// ── Protected User Routes ───────────────────────────────────────────────────
router.use(authenticate);

router.get('/', TransactionController.getTransactions);
router.get('/:id', TransactionController.getTransactionById);
router.post(
  '/',
  transactionLimiter,
  validateRequest(transactionCreateSchema),
  TransactionController.createTransaction
);
router.post('/topup', transactionLimiter, TransactionController.topUpDemoFunds);

// Emergency contacts management
router.get('/emergency-contacts', TransactionController.getEmergencyContacts);
router.post(
  '/emergency-contacts',
  validateRequest(emergencyContactsUpdateSchema),
  TransactionController.updateEmergencyContacts
);

router.post(
  '/delegate/generate',
  validateRequest(delegateGenerateSchema),
  TransactionController.generateDelegateOtp
);

module.exports = router;
