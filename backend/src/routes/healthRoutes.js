const express = require('express');
const { authenticate } = require('../middleware/authMiddleware');
const { score } = require('../controllers/analyticsController');
const router = express.Router();
router.use(authenticate);
router.get('/score', score);
module.exports = router;
