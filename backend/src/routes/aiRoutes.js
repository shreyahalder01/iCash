const express = require('express');
const AIController = require('../controllers/aiController');
const { authenticate } = require('../middleware/authMiddleware');
const { validateRequest } = require('../middleware/validateMiddleware');
const { aiChatSchema } = require('../utils/validator');

const router = express.Router();

router.use(authenticate);
router.post('/chat', validateRequest(aiChatSchema), AIController.chat);
router.get('/history', AIController.history);

module.exports = router;
