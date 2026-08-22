const express = require('express');
const router = express.Router();
const SecurityController = require('../controllers/securityController');
const { authenticate } = require('../middleware/authMiddleware');
const { validateRequest } = require('../middleware/validateMiddleware');
const { securityEventSchema } = require('../utils/validator');

// Security reporting can be anonymous (during unauthenticated scan) or authenticated
router.post('/events', validateRequest(securityEventSchema), (req, res, next) => {
  if (req.cookies?.icash_session || req.headers.authorization) {
    return authenticate(req, res, () => SecurityController.reportSecurityEvent(req, res, next));
  }
  SecurityController.reportSecurityEvent(req, res, next);
});

// Protected security status and personal audit query
router.get('/status', authenticate, SecurityController.getSecurityStatus);
router.get('/events', authenticate, SecurityController.getSecurityEvents);

module.exports = router;
