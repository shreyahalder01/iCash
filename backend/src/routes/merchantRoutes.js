const express = require('express');
const router = express.Router();
const MerchantController = require('../controllers/merchantController');
const { authenticate } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roleMiddleware');
const { validateRequest } = require('../middleware/validateMiddleware');
const { merchantPaymentRequestSchema, merchantRefundSchema } = require('../utils/validator');

router.use(authenticate);
router.use(requireRole('MERCHANT', 'ADMIN'));

router.get('/profile', MerchantController.getProfile);
router.post(
  '/payment-requests',
  validateRequest(merchantPaymentRequestSchema),
  MerchantController.createPaymentRequest
);
router.get('/transactions', MerchantController.getTransactions);
router.get('/settlements', MerchantController.getSettlements);
router.post('/refunds', validateRequest(merchantRefundSchema), MerchantController.processRefund);

module.exports = router;
