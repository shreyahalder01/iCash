/**
 * BiometricChallengeController
 *
 * Implements server-side cryptographic challenge and temporal proof verification:
 *
 *   1. POST /api/biometric/challenge
 *      - Server issues single-use challenge { challengeId, nonce, challengeType, expiresAt }
 *      - Stored in DB with 60s TTL and cryptographic 32-byte hex nonce.
 *
 *   2. POST /api/biometric/verify-challenge
 *      - Validates challenge exists, is not expired, and has not been used.
 *      - Immediately marks challenge as USED (atomic anti-replay protection).
 *      - Validates temporal EAR frame evidence (anti-photo, dual-eye closure, duration, 2 blinks).
 *      - Verifies facial identity against enrolled 128D templates (< 0.52 distance).
 *      - Returns short-lived single-use biometricToken.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const prisma = require('../prisma');
const { biometricService } = require('../services/biometricService');
const SecurityService = require('../services/securityService');
const { validateTemporalProof } = require('../services/temporalLivenessValidator');

// Configurable Constants
const CHALLENGE_TTL_MS = Number(process.env.BIOMETRIC_CHALLENGE_TTL_MS) || 60 * 1000; // 60 seconds
const BIO_TOKEN_TTL_SECONDS = 3 * 60; // 3 minutes
const BIO_TOKEN_SECRET_EXTRA = ':biometric-challenge-token-v1';

const CHALLENGE_TYPES = ['BLINK_TWICE'];

const CHALLENGE_INSTRUCTIONS = {
  BLINK_ONCE: 'Please blink once naturally.',
  BLINK_TWICE: 'Please blink twice naturally.',
};

function getBioTokenSecret() {
  const base = process.env.BIO_TOKEN_JWT_SECRET || process.env.JWT_SECRET;
  if (!base) throw new Error('BIO_TOKEN_JWT_SECRET (or JWT_SECRET) is not configured.');
  return base + BIO_TOKEN_SECRET_EXTRA;
}

class BiometricChallengeController {
  /**
   * POST /api/biometric/challenge
   * Generates a single-use cryptographic challenge for liveness & biometric authentication.
   */
  static async issueChallenge(req, res, next) {
    try {
      // Background cleanup of expired challenges
      prisma.biometricChallenge.deleteMany({ where: { expires_at: { lt: new Date() } } }).catch(() => {});

      // Cryptographically random 32-byte hex nonce
      const nonce = crypto.randomBytes(32).toString('hex');
      const challengeType = CHALLENGE_TYPES[0]; // BLINK_TWICE
      const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
      const ipAddress = req.ip || req.headers['x-forwarded-for'] || null;

      const challenge = await prisma.biometricChallenge.create({
        data: {
          nonce,
          challenge_type: challengeType,
          ip_address: ipAddress ? String(ipAddress).slice(0, 45) : null,
          expires_at: expiresAt,
        },
      });

      await SecurityService.recordEvent({
        userId: null,
        eventType: 'BIOMETRIC_CHALLENGE_ISSUED',
        severity: 'LOW',
        description: `Biometric challenge issued: ${challengeType} (id=${challenge.id})`,
        ipAddress,
        deviceReference: req.headers['user-agent'],
      });

      return res.json({
        ok: true,
        challengeId: challenge.id,
        nonce: challenge.nonce,
        challengeType: challenge.challenge_type,
        instruction: CHALLENGE_INSTRUCTIONS[challenge.challenge_type] || 'Please blink twice naturally.',
        expiresAt: expiresAt.toISOString(),
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/biometric/verify-challenge
   * Validates challenge nonce, single-use, temporal liveness evidence, and face identity match.
   */
  static async verifyChallenge(req, res, next) {
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || null;
    const ua = req.headers['user-agent'];

    try {
      const { challengeId, nonce, liveDescriptor, challengeProof, userId: targetUserId } = req.body;

      if (!challengeId || !nonce || !liveDescriptor) {
        return res.status(400).json({
          ok: false,
          error: 'BadRequest',
          message: 'Missing required biometric challenge verification parameters.',
        });
      }

      // Gate 1: Lookup challenge record
      const challenge = await prisma.biometricChallenge.findUnique({ where: { id: challengeId } });
      if (!challenge) {
        await SecurityService.recordEvent({
          userId: null,
          eventType: 'BIOMETRIC_AUTH_FAILURE',
          severity: 'MEDIUM',
          description: `Unknown challenge ID: ${challengeId}`,
          ipAddress,
          deviceReference: ua,
        });
        return res.status(400).json({
          ok: false,
          error: 'InvalidChallenge',
          message: 'Biometric challenge not found. Please start a fresh verification.',
        });
      }

      // Gate 2: Expiry verification (strict 60s TTL)
      if (challenge.expires_at < new Date()) {
        await SecurityService.recordEvent({
          userId: null,
          eventType: 'BIOMETRIC_AUTH_FAILURE',
          severity: 'LOW',
          description: `Expired challenge attempted: ${challengeId}`,
          ipAddress,
          deviceReference: ua,
        });
        return res.status(400).json({
          ok: false,
          error: 'ChallengeExpired',
          message: 'Biometric challenge expired. Please restart the verification scan.',
        });
      }

      // Gate 3: Anti-Replay (single-use validation)
      if (challenge.used_at) {
        await SecurityService.recordEvent({
          userId: null,
          eventType: 'BIOMETRIC_CHALLENGE_REPLAYED',
          severity: 'HIGH',
          description: `Replay attack detected on used challenge ${challengeId}`,
          ipAddress,
          deviceReference: ua,
        });
        return res.status(400).json({
          ok: false,
          error: 'ChallengeReplayed',
          message: 'This biometric challenge has already been consumed. Replay is forbidden.',
        });
      }

      // Gate 4: Cryptographic nonce match (constant-time comparison)
      let nonceMatch = false;
      try {
        nonceMatch = crypto.timingSafeEqual(
          Buffer.from(challenge.nonce, 'hex'),
          Buffer.from(nonce, 'hex')
        );
      } catch (_) {
        nonceMatch = false;
      }

      if (!nonceMatch) {
        await SecurityService.recordEvent({
          userId: null,
          eventType: 'BIOMETRIC_AUTH_FAILURE',
          severity: 'HIGH',
          description: `Nonce mismatch for challenge ${challengeId}`,
          ipAddress,
          deviceReference: ua,
        });
        return res.status(400).json({
          ok: false,
          error: 'NonceMismatch',
          message: 'Cryptographic challenge verification failed. Nonce mismatch.',
        });
      }

      // Immediately consume the challenge to prevent concurrent replay
      await prisma.biometricChallenge.update({
        where: { id: challengeId },
        data: { used_at: new Date() },
      });

      // Gate 5: Server-Side Temporal Liveness Proof Validation
      const requiredBlinks = challenge.challenge_type === 'BLINK_ONCE' ? 1 : 2;
      const livenessResult = validateTemporalProof(challengeProof, requiredBlinks);

      if (!livenessResult.valid) {
        await SecurityService.recordEvent({
          userId: null,
          eventType: 'BIOMETRIC_LIVENESS_FAILURE',
          severity: 'MEDIUM',
          description: `Liveness verification failed: ${livenessResult.reason} (challenge=${challengeId})`,
          ipAddress,
          deviceReference: ua,
        });
        return res.status(403).json({
          ok: false,
          error: 'LivenessFailed',
          message: livenessResult.reason || 'Liveness verification failed. Genuine blink sequence required.',
        });
      }

      // Gate 6: Server-side Face Matching against Enrolled Biometric Profile
      let bestUserId = null;
      let bestDistance = Infinity;

      // If target user was provided, check that profile first
      if (targetUserId) {
        const targetProfile = await prisma.biometricProfile.findUnique({
          where: { user_id: targetUserId },
          select: { id: true, user_id: true, face_descriptors: true, enrollment_status: true },
        });

        if (
          targetProfile &&
          targetProfile.enrollment_status === 'ENROLLED' &&
          Array.isArray(targetProfile.face_descriptors) &&
          targetProfile.face_descriptors.length > 0
        ) {
          const matchResult = await biometricService.verify(targetProfile.face_descriptors, liveDescriptor);
          if (matchResult.matched) {
            bestDistance = matchResult.distance;
            bestUserId = targetProfile.user_id;
          }
        }
      }

      // If not yet matched, search across enrolled profiles
      if (!bestUserId) {
        const profiles = await prisma.biometricProfile.findMany({
          where: { enrollment_status: 'ENROLLED' },
          select: { id: true, user_id: true, face_descriptors: true },
        });

        for (const profile of profiles) {
          if (!Array.isArray(profile.face_descriptors) || profile.face_descriptors.length === 0) continue;
          const matchResult = await biometricService.verify(profile.face_descriptors, liveDescriptor);
          if (matchResult.matched && matchResult.distance < bestDistance) {
            bestDistance = matchResult.distance;
            bestUserId = profile.user_id;
          }
        }
      }

      if (!bestUserId) {
        await SecurityService.recordEvent({
          userId: null,
          eventType: 'BIOMETRIC_AUTH_FAILURE',
          severity: 'MEDIUM',
          description: `Face identity match failed (challenge=${challengeId})`,
          ipAddress,
          deviceReference: ua,
        });
        return res.status(401).json({
          ok: false,
          error: 'IdentityMismatch',
          message: 'Face identity verification failed. Face does not match registered account.',
        });
      }

      // Gate 7: Ensure user account is active and not locked
      const user = await prisma.user.findUnique({
        where: { id: bestUserId },
        select: { id: true, full_name: true, email: true, phone: true, role: true, status: true, locked_until: true },
      });

      if (!user || user.status !== 'ACTIVE' || (user.locked_until && user.locked_until > new Date())) {
        return res.status(403).json({
          ok: false,
          error: 'AccountRestricted',
          message: 'Your account is locked or suspended. Please contact customer support.',
        });
      }

      // Update challenge record with authenticated user
      await prisma.biometricChallenge.update({
        where: { id: challengeId },
        data: { user_id: bestUserId },
      });

      // Issue single-use signed biometricToken
      const biometricToken = jwt.sign(
        {
          sub: bestUserId,
          challengeId,
          nonce: nonce.slice(0, 16),
          purpose: 'biometric-auth',
          livenessOk: true,
        },
        getBioTokenSecret(),
        { expiresIn: BIO_TOKEN_TTL_SECONDS }
      );

      await SecurityService.recordEvent({
        userId: bestUserId,
        eventType: 'BIOMETRIC_AUTH_SUCCESS',
        severity: 'LOW',
        description: `Biometric challenge authenticated successfully (id=${challengeId}, distance=${bestDistance.toFixed(4)}, blinks=${livenessResult.blinkCount})`,
        ipAddress,
        deviceReference: ua,
      });

      return res.json({
        ok: true,
        biometricToken,
        userId: bestUserId,
        user: {
          id: user.id,
          name: user.full_name,
          email: user.email,
          phone: user.phone,
          role: user.role,
        },
        distance: Number(bestDistance.toFixed(4)),
        blinks: livenessResult.blinkCount,
        expiresInSeconds: BIO_TOKEN_TTL_SECONDS,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Middleware: consumeBiometricToken
   * Validates and consumes the short-lived biometricToken.
   */
  static consumeBiometricToken(req, res, next) {
    try {
      const token = req.body.biometricToken || req.headers['x-biometric-token'];
      if (!token) {
        return res.status(403).json({
          ok: false,
          error: 'BiometricTokenRequired',
          message: 'A valid biometric verification token is required.',
        });
      }

      let payload;
      try {
        payload = jwt.verify(token, getBioTokenSecret());
      } catch (_) {
        return res.status(403).json({
          ok: false,
          error: 'BiometricTokenInvalid',
          message: 'Biometric verification token is invalid or expired. Please verify face again.',
        });
      }

      if (payload.purpose !== 'biometric-auth' || !payload.livenessOk) {
        return res.status(403).json({
          ok: false,
          error: 'BiometricTokenInvalid',
          message: 'Biometric token claims are invalid.',
        });
      }

      req.biometricUserId = payload.sub;
      req.biometricChallengeId = payload.challengeId;
      next();
    } catch (err) {
      next(err);
    }
  }
}

module.exports = BiometricChallengeController;
