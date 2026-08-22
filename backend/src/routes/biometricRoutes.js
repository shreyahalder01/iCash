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

// Fetch stored descriptors for a given userId (used by client-side matcher).
// Accessible during login (no session) — only returns descriptors, no PII.
router.get('/profile/:userId', BiometricController.getProfile);

module.exports = router;
