const express = require('express');
const { authenticate } = require('../middleware/authMiddleware');
const controller = require('../controllers/savingsController');

const router = express.Router();
router.use(authenticate);
router.get('/challenges', controller.list);
router.post('/challenges/:id/join', controller.join);
router.get('/progress', controller.progress);
router.post('/progress/:id/claim', controller.claim);
module.exports = router;
