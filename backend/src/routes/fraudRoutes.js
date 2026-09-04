const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/authMiddleware');
const FraudController = require('../controllers/fraudController');

router.use(authenticate);
router.post('/transactions/:transactionId/analyze', FraudController.analyze);
router.get('/transactions/:transactionId', FraudController.getAnalysis);
// Short aliases keep the v2 API convenient for clients.
router.post('/analyze/:transactionId', FraudController.analyze);
router.get('/:transactionId', FraudController.getAnalysis);

module.exports = router;
