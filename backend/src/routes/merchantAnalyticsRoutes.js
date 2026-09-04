const express = require('express');
const { authenticate } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roleMiddleware');
const controller = require('../controllers/merchantAnalyticsController');

const router = express.Router();
router.use(authenticate, requireRole('MERCHANT', 'ADMIN'));
router.get('/dashboard', controller.dashboard);
router.get('/analytics', controller.analytics);
module.exports = router;
