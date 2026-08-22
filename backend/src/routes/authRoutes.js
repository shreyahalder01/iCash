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
  phoneEmailVerifySchema
} = require('../utils/validator');

router.post('/register', authLimiter, validateRequest(registerSchema), AuthController.register);
router.post('/login-aadhaar', authLimiter, validateRequest(loginAadhaarSchema), AuthController.lookupAadhaar);
router.post('/login-pin', authLimiter, validateRequest(loginPinSchema), AuthController.loginPin);
router.post('/phone-email-verify', authLimiter, validateRequest(phoneEmailVerifySchema), AuthController.verifyPhoneEmail);
router.post('/logout', authenticate, AuthController.logout);
router.get('/me', authenticate, AuthController.getMe);
router.post('/refresh', authenticate, AuthController.refresh);

module.exports = router;
