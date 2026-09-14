const prisma = require('../prisma');
const { biometricService } = require('../services/biometricService');
const SecurityService = require('../services/securityService');

class BiometricController {
  /**
   * Enroll or update face descriptors for the authenticated user.
   * REQUIRES: a valid biometricToken issued by verify-challenge (liveness proven).
   * req.biometricUserId is attached by the consumeBiometricToken middleware.
   */
  static async enroll(req, res, next) {
    try {
      const { descriptors } = req.body;

      // Enforce that the authenticated user matches the biometricToken subject.
      if (req.biometricUserId && req.biometricUserId !== req.user.id) {
        await SecurityService.recordEvent({
          userId: req.user.id,
          eventType: 'BIOMETRIC_AUTH_FAILURE',
          severity: 'HIGH',
          description: 'Enrollment rejected: biometricToken user does not match session user.',
          ipAddress: req.ip,
          deviceReference: req.headers['user-agent'],
        });
        return res.status(403).json({ ok: false, message: 'Biometric enrollment refused: identity mismatch.' });
      }

      const enrollment = await biometricService.enroll(req.user.id, descriptors);

      const profile = await prisma.biometricProfile.upsert({
        where: { user_id: req.user.id },
        update: {
          biometric_provider: enrollment.provider,
          biometric_reference: enrollment.reference,
          enrollment_status: 'ENROLLED',
          face_descriptors: enrollment.descriptors,
        },
        create: {
          user_id: req.user.id,
          biometric_provider: enrollment.provider,
          biometric_reference: enrollment.reference,
          enrollment_status: 'ENROLLED',
          face_descriptors: enrollment.descriptors,
        },
      });

      await SecurityService.recordEvent({
        userId: req.user.id,
        eventType: 'BIOMETRIC_ENROLLED',
        severity: 'LOW',
        description: `Facial biometric profile enrolled with ${descriptors.length} live sample(s) (liveness verified via biometricToken).`,
        ipAddress: req.ip,
        deviceReference: req.headers['user-agent'],
      });

      res.json({
        ok: true,
        message: 'Biometric profile enrolled successfully.',
        provider: profile.biometric_provider,
        reference: profile.biometric_reference,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Server-side face verification against enrolled template.
   * DEPRECATED for the primary login flow — use POST /verify-challenge instead.
   * This endpoint does NOT validate liveness and must not be used for auth.
   */
  static async verify(req, res, next) {
    try {
      const { liveDescriptor, userId } = req.body;
      const targetUserId = userId || (req.user && req.user.id);

      if (!targetUserId) {
        return res.status(400).json({ ok: false, message: 'Target user identity is required.' });
      }

      const profile = await prisma.biometricProfile.findUnique({ where: { user_id: targetUserId } });
      if (!profile || !profile.face_descriptors) {
        return res.status(404).json({ ok: false, matched: false, message: 'No registered face template found.' });
      }

      const verifyResult = await biometricService.verify(profile.face_descriptors, liveDescriptor);

      await SecurityService.recordEvent({
        userId: targetUserId,
        eventType: verifyResult.matched ? 'BIOMETRIC_SUCCESS' : 'BIOMETRIC_FAILED',
        severity: verifyResult.matched ? 'LOW' : 'MEDIUM',
        description: verifyResult.matched
          ? `[LEGACY] Face match confirmed. NOTE: liveness NOT verified by this endpoint.`
          : `[LEGACY] Face verification failed.`,
        ipAddress: req.ip,
        deviceReference: req.headers['user-agent'],
      });

      res.json({
        ok: true,
        matched: verifyResult.matched,
        confidence: verifyResult.confidence,
        // distance omitted intentionally — prevents scoring oracle attacks
        provider: verifyResult.provider,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Return enrollment STATUS only — face descriptors are NEVER returned to the browser.
   * Server-side matching via POST /verify-challenge replaced the old download-then-match flow.
   */
  static async getProfile(req, res, next) {
    try {
      const { userId } = req.params;
      if (!userId) return res.status(400).json({ ok: false, message: 'userId required.' });

      const profile = await prisma.biometricProfile.findUnique({
        where: { user_id: userId },
        // SECURITY: face_descriptors intentionally excluded
        select: { enrollment_status: true, biometric_provider: true, updated_at: true },
      });

      if (!profile) return res.json({ ok: true, enrolled: false });

      res.json({
        ok:       true,
        enrolled: profile.enrollment_status === 'ENROLLED',
        provider: profile.biometric_provider,
        // face_descriptors deliberately omitted
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = BiometricController;
