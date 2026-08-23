const express = require('express');
const router = express.Router();
const AuthController = require('../controllers/authController');
const { authenticate } = require('../middleware/authMiddleware');
const { validateRequest } = require('../middleware/validateMiddleware');
const { authLimiter } = require('../middleware/rateLimitMiddleware');
const {
  registerSchema,
  loginAadhaarSchema,
  loginPinSchema,
  confirmDeleteSchema,
} = require('../utils/validator');

const { getCsrfTokenHandler } = require('../middleware/csrfMiddleware');

router.get('/csrf-token', getCsrfTokenHandler);
router.post('/register', authLimiter, validateRequest(registerSchema), AuthController.register);
router.post(
  '/login-aadhaar',
  authLimiter,
  validateRequest(loginAadhaarSchema),
  AuthController.lookupAadhaar
);
router.post('/login-pin', authLimiter, validateRequest(loginPinSchema), AuthController.loginPin);
router.post('/logout', authenticate, AuthController.logout);
router.get('/me', authenticate, AuthController.getMe);
router.post('/refresh', authenticate, AuthController.refresh);
// Delete own account (requires current PIN confirmation)
router.delete('/me', authenticate, validateRequest(confirmDeleteSchema), AuthController.deleteMe);

module.exports = router;
