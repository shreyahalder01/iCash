const prisma = require('../prisma');
const { biometricService } = require('../services/biometricService');
const SecurityService = require('../services/securityService');

class BiometricController {
  /**
   * Enroll or update face descriptors for the authenticated user.
   */
  static async enroll(req, res, next) {
    try {
      const { descriptors } = req.body;
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
        description: `Facial biometric profile updated with ${descriptors.length} sample(s).`,
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
   */
  static async verify(req, res, next) {
    try {
      const { liveDescriptor, userId } = req.body;
      const targetUserId = userId || (req.user && req.user.id);

      if (!targetUserId) {
        return res.status(400).json({
          ok: false,
          message: 'Target user identity is required for biometric verification.',
        });
      }

      const profile = await prisma.biometricProfile.findUnique({
        where: { user_id: targetUserId },
      });

      if (!profile || !profile.face_descriptors) {
        return res.status(404).json({
          ok: false,
          matched: false,
          message: 'No registered face template found for this user.',
        });
      }

      const verifyResult = await biometricService.verify(profile.face_descriptors, liveDescriptor);

      if (verifyResult.matched) {
        await SecurityService.recordEvent({
          userId: targetUserId,
          eventType: 'BIOMETRIC_SUCCESS',
          severity: 'LOW',
          description: `Live facial match confirmed (confidence: ${Math.round(verifyResult.confidence * 100)}%).`,
          ipAddress: req.ip,
          deviceReference: req.headers['user-agent'],
        });
      } else {
        await SecurityService.recordEvent({
          userId: targetUserId,
          eventType: 'BIOMETRIC_FAILED',
          severity: 'MEDIUM',
          description: `Face verification failed — descriptor distance (${verifyResult.distance}) exceeded threshold.`,
          ipAddress: req.ip,
          deviceReference: req.headers['user-agent'],
        });
      }

      res.json({
        ok: true,
        matched: verifyResult.matched,
        confidence: verifyResult.confidence,
        distance: verifyResult.distance,
        provider: verifyResult.provider,
      });
    } catch (err) {
      next(err);
    }
  }
  /**
   * Return stored face descriptors for a user (no PII — descriptors only).
   * Used by the frontend real-time Euclidean matcher.
   */
  static async getProfile(req, res, next) {
    try {
      const { userId } = req.params;
      if (!userId) return res.status(400).json({ ok: false, message: 'userId required.' });

      const profile = await prisma.biometricProfile.findUnique({
        where: { user_id: userId },
        select: { face_descriptors: true, enrollment_status: true },
      });

      if (!profile) {
        return res.json({ ok: true, descriptors: [], enrolled: false });
      }

      res.json({
        ok: true,
        enrolled: profile.enrollment_status === 'ENROLLED',
        descriptors: profile.face_descriptors || [],
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = BiometricController;
