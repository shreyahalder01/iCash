const express = require('express');
const { authenticate } = require('../middleware/authMiddleware');
const controller = require('../controllers/subscriptionController');

const router = express.Router();
router.use(authenticate);
router.get('/detect', controller.detect);
router.get('/', controller.list);
module.exports = router;
