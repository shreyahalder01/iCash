const express = require('express');
const router = express.Router();
const AuthController = require('../controllers/authController');
const { authenticate, optionalAuthenticate } = require('../middleware/authMiddleware');
const { validateRequest } = require('../middleware/validateMiddleware');
const { authLimiter } = require('../middleware/rateLimitMiddleware');
const {
  registerSchema,
  loginAadhaarSchema,
  loginPinSchema,
  confirmDeleteSchema,
} = require('../utils/validator');

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

// Email Verification endpoints matching zahid-afridi/EmailVerfication
router.post('/verify-email', optionalAuthenticate, AuthController.verifyEmail);
router.post('/verifyEmail', optionalAuthenticate, AuthController.verifyEmail);
router.post('/resend-verification', optionalAuthenticate, AuthController.resendVerification);
router.get('/verification-status', authenticate, AuthController.getVerificationStatus);

module.exports = router;
