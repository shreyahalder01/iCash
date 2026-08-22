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
} = require('../utils/validator');

// Public route: Trusted contact claims senior citizen funds using OTP (senior citizen name + OTP)
router.post(
  '/delegate/claim',
  validateRequest(delegateClaimSchema),
  TransactionController.claimDelegateWithdrawal
);

// Protected routes
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
router.post(
  '/delegate/generate',
  validateRequest(delegateGenerateSchema),
  TransactionController.generateDelegateOtp
);

module.exports = router;
