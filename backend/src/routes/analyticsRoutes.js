const express = require('express');
const { authenticate } = require('../middleware/authMiddleware');
const { forecast } = require('../controllers/analyticsController');
const router = express.Router();
router.use(authenticate);
router.get('/forecast', forecast);
module.exports = router;
