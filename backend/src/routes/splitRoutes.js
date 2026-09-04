const express = require('express');
const { authenticate } = require('../middleware/authMiddleware');
const controller = require('../controllers/splitController');

const router = express.Router();
router.use(authenticate);
router.post('/groups', controller.createGroup);
router.post('/groups/:groupId/members', controller.addMember);
router.post('/groups/:groupId/expenses', controller.createExpense);
router.get('/groups/:groupId/optimization', controller.optimize);
router.post('/calculate', controller.calculate);
router.post('/payments/:paymentId/pay', controller.settlePayment);
// Convenient aliases for clients that model a bill as a top-level split.
router.post('/groups/:groupId/split', controller.createExpense);
router.get('/groups/:groupId/debts', controller.optimize);
module.exports = router;
