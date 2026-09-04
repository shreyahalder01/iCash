const express = require('express');
const router = express.Router();
const BiometricController = require('../controllers/biometricController');
const { authenticate } = require('../middleware/authMiddleware');
const { validateRequest } = require('../middleware/validateMiddleware');
const { biometricEnrollSchema, biometricVerifySchema } = require('../utils/validator');

// Face verification endpoint (can be called during login before session exists with target userId, or during active session)
router.post('/verify', validateRequest(biometricVerifySchema), (req, res, next) => {
  // If session cookie exists, authenticate, otherwise proceed with payload userId
  if (req.cookies?.icash_session || req.headers.authorization) {
    return authenticate(req, res, () => BiometricController.verify(req, res, next));
  }
  BiometricController.verify(req, res, next);
});

// Enrollment requires authentication
router.post(
  '/enroll',
  authenticate,
  validateRequest(biometricEnrollSchema),
  BiometricController.enroll
);

// Fetch stored descriptors for the AUTHENTICATED user only.
// Requires a valid session to prevent face vector harvesting.
router.get('/profile/:userId', authenticate, (req, res, next) => {
  // Enforce that users can only fetch their own biometric profile.
  // Admin access is intentionally omitted here since descriptors are
  // biometric raw data and must never be exposed to a third party.
  if (req.params.userId !== req.user.id) {
    return res.status(403).json({
      ok: false,
      error: 'Forbidden',
      message: 'You may only access your own biometric profile.',
    });
  }
  BiometricController.getProfile(req, res, next);
});

module.exports = router;
