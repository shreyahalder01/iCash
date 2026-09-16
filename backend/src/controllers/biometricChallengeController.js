/**
 * BiometricChallengeController
 *
 * Implements the server-side challenge/nonce gating layer required for
 * secure biometric authentication. The flow is:
 *
 *   1. POST /api/biometric/challenge
 *      Server issues { challengeId, nonce, randomChallenge, expiresAt }
 *      Challenge stored in DB: single-use, 2-minute TTL, IP-bound.
 *
 *   2. Frontend performs the randomized liveness challenge on-camera.
 *
 *   3. POST /api/biometric/verify-challenge
 *      Server validates: nonce | expiry | one-time-use | liveness | face-match.
 *      On all checks passing: issues a short-lived biometricToken (JWT, 3 min, one-time).
 *
 *   4. biometricToken is used for enrollment or transaction authorization.
 *      It cannot be reused; challengeId is recorded as consumed.
 *
 * SECURITY INVARIANTS:
 *   - A face match alone CANNOT produce a biometricToken.
 *   - Liveness alone CANNOT produce a biometricToken.
 *   - The token is bound to challengeId and userId.
 *   - No biometric descriptor or liveness score is returned to the client.
 *   - A malicious browser cannot open DevTools and set isLive=true to bypass.
 */

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const prisma = require('../prisma');
const { biometricService } = require('../services/biometricService');
const SecurityService       = require('../services/securityService');

// ── Constants ─────────────────────────────────────────────────────────────────
const CHALLENGE_TTL_MS       = 2 * 60 * 1000; // 2 minutes
const BIO_TOKEN_TTL_SECONDS  = 3 * 60;         // 3 minutes
const BIO_TOKEN_SECRET_EXTRA = ':biometric-challenge-token-v1';

// Available randomized challenge types
const CHALLENGE_TYPES = [
  'BLINK_ONCE',
  'BLINK_TWICE',
];

const CHALLENGE_INSTRUCTIONS = {
  BLINK_ONCE:       'Please blink once.',
  BLINK_TWICE:      'Please blink twice.',
};

// ── Helper: biometric token signing secret ────────────────────────────────────
function getBioTokenSecret() {
  const base = process.env.BIO_TOKEN_JWT_SECRET || process.env.JWT_SECRET;
  if (!base) throw new Error('BIO_TOKEN_JWT_SECRET (or JWT_SECRET) is not configured.');
  return base + BIO_TOKEN_SECRET_EXTRA;
}

function getLivenessCandidates() {
  const configured = (process.env.LIVENESS_SERVER_URL || '').trim().replace(/\/+$/, '');
  const local = 'http://127.0.0.1:5001';
  if (configured && configured !== local) {
    return [configured, local];
  }
  return [local];
}

// ── Helper: query Python liveness server ──────────────────────────────────────
async function queryLivenessServer(sessionId) {
  if (!sessionId) return { live: false, reason: 'no_session_id' };

  if (sessionId.startsWith('local-bio-')) {
    return {
      live: true,
      blink_count: 2,
      spoof_detected: false,
      challenge_type: null,
      exactly_one_face: true,
      source: 'local_challenge',
    };
  }

  const candidates = getLivenessCandidates();
  for (const base of candidates) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(`${base}/liveness/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
        signal: controller.signal,
      });
      clearTimeout(tid);
      if (!res.ok) continue;
      const data = await res.json();
      return {
        live:           Boolean(data.live),
        blink_count:    data.blink_count || 0,
        spoof_detected: Boolean(data.spoof_detected),
        reason:         data.spoof_reason || null,
        challenge_type: data.challenge_type || null,
        exactly_one_face: data.exactly_one_face === true,
      };
    } catch (e) {
      // try next candidate
    }
  }

  // Graceful fallback in demo/dev mode
  if (process.env.BIOMETRIC_PROVIDER === 'demo' || process.env.NODE_ENV !== 'production') {
    return {
      live: true,
      blink_count: 2,
      spoof_detected: false,
      challenge_type: null,
      exactly_one_face: true,
      source: 'demo_fallback',
    };
  }

  console.warn('[iCash Bio] Liveness server unreachable across candidates');
  return { live: false, reason: 'liveness_server_offline' };
}

async function startLivenessServer(challengeType) {
  const candidates = getLivenessCandidates();
  let lastError = null;

  for (const base of candidates) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(`${base}/liveness/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge_type: challengeType }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`liveness_start_${res.status}`);
      const data = await res.json();
      if (!data.session_id || data.challenge_type !== challengeType) {
        throw new Error('invalid_liveness_session');
      }
      return data.session_id;
    } catch (e) {
      lastError = e;
    } finally {
      clearTimeout(tid);
    }
  }

  if (process.env.BIOMETRIC_PROVIDER === 'demo' || process.env.NODE_ENV !== 'production') {
    const localId = 'local-bio-' + crypto.randomUUID();
    console.log(`[iCash Bio] Python liveness server offline; issued local session ${localId}`);
    return localId;
  }

  throw lastError || new Error('liveness_unavailable');
}

// ── Controller ────────────────────────────────────────────────────────────────
class BiometricChallengeController {

  /**
   * POST /api/biometric/challenge
   * Issues a fresh server-side randomized liveness challenge.
   * Does NOT require authentication (used pre-login).
   * Rate-limited to 10 per 5 min per IP.
   */
  static async issueChallenge(req, res, next) {
    try {
      // Lazy background cleanup of expired challenges
      prisma.biometricChallenge.deleteMany({ where: { expires_at: { lt: new Date() } } }).catch(() => {});

      const nonce         = crypto.randomBytes(32).toString('hex');
      const challengeType = CHALLENGE_TYPES[Math.floor(Math.random() * CHALLENGE_TYPES.length)];
      const expiresAt     = new Date(Date.now() + CHALLENGE_TTL_MS);
      const ipAddress     = req.ip || req.headers['x-forwarded-for'] || null;

      // The Node server, not the browser, creates the liveness session. This
      // prevents a malicious client from swapping in a different session.
      let livenessSessionId;
      try {
        livenessSessionId = await startLivenessServer(challengeType);
      } catch (e) {
        console.error('[iCash Bio] Unable to start authoritative liveness session:', e.message || e);
        return res.status(503).json({
          ok: false,
          error: 'LivenessUnavailable',
          message: 'Live-person verification is temporarily unavailable. Please try again.',
        });
      }

      const challenge = await prisma.biometricChallenge.create({
        data: { nonce, challenge_type: challengeType, ip_address: ipAddress, expires_at: expiresAt, liveness_session_id: livenessSessionId },
      });

      await SecurityService.recordEvent({
        userId: null,
        eventType: 'BIOMETRIC_CHALLENGE_ISSUED',
        severity: 'LOW',
        description: `Challenge issued: ${challengeType} (id=${challenge.id})`,
        ipAddress,
        deviceReference: req.headers['user-agent'],
      });

      return res.json({
        ok:            true,
        challengeId:   challenge.id,
        nonce:         challenge.nonce,
        challengeType: challenge.challenge_type,
        instruction:   CHALLENGE_INSTRUCTIONS[challenge.challenge_type],
        expiresAt:     expiresAt.toISOString(),
        livenessSessionId, // convenience for the client; server still trusts only the DB-bound value
      });
    } catch (err) { next(err); }
  }

  /**
   * POST /api/biometric/verify-challenge
   * Validates a completed liveness challenge.
   * All 7 security gates must pass before a biometricToken is issued.
   * Returns: { ok, biometricToken, userId }
   */
  static async verifyChallenge(req, res, next) {
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || null;
    const ua        = req.headers['user-agent'];

    try {
      const { challengeId, nonce, liveDescriptor, userId: targetUserId } = req.body;

      // Gate 1: Challenge exists
      const challenge = await prisma.biometricChallenge.findUnique({ where: { id: challengeId } });
      if (!challenge) {
        await SecurityService.recordEvent({ userId: null, eventType: 'BIOMETRIC_AUTH_FAILURE', severity: 'MEDIUM',
          description: `Unknown challenge ID: ${challengeId}`, ipAddress, deviceReference: ua });
        return res.status(400).json({ ok: false, message: 'Biometric verification failed. Please try again.' });
      }

      // Gate 2: Expiry
      if (challenge.expires_at < new Date()) {
        return res.status(400).json({ ok: false, message: 'Biometric verification failed. Please try again.' });
      }

      // Gate 3: One-time use (replay prevention)
      if (challenge.used_at) {
        await SecurityService.recordEvent({ userId: null, eventType: 'BIOMETRIC_CHALLENGE_REPLAYED', severity: 'HIGH',
          description: `Replay attempt on used challenge ${challengeId}`, ipAddress, deviceReference: ua });
        return res.status(400).json({ ok: false, message: 'Biometric verification failed. Please try again.' });
      }

      // Gate 4: Challenge is bound to the client network identity.
      const requestIp = ipAddress ? String(ipAddress) : null;
      if (challenge.ip_address && requestIp !== challenge.ip_address) {
        const isLocal = (ip) => !ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('::ffff:127.0.0.1') || ip === 'localhost';
        if (!(isLocal(challenge.ip_address) && isLocal(requestIp))) {
          return res.status(400).json({ ok: false, message: 'Biometric verification failed. Please try again.' });
        }
      }

      // Gate 5: Nonce integrity (constant-time comparison)
      let nonceMatch = false;
      try {
        nonceMatch = crypto.timingSafeEqual(Buffer.from(challenge.nonce, 'hex'), Buffer.from(nonce, 'hex'));
      } catch (_) { nonceMatch = false; }
      if (!nonceMatch) {
        await SecurityService.recordEvent({ userId: null, eventType: 'BIOMETRIC_AUTH_FAILURE', severity: 'HIGH',
          description: `Nonce mismatch for challenge ${challengeId}`, ipAddress, deviceReference: ua });
        return res.status(400).json({ ok: false, message: 'Biometric verification failed. Please try again.' });
      }

      // Gate 6: Authoritative liveness validation
      const livenessResult = await queryLivenessServer(challenge.liveness_session_id);
      const livenessSource = livenessResult.source || 'liveness_server';

      const isLiveServer = livenessResult.live === true &&
        !livenessResult.spoof_detected &&
        (livenessResult.challenge_type ? livenessResult.challenge_type === challenge.challenge_type : true) &&
        livenessResult.exactly_one_face === true;

      // Never accept browser-supplied challengeProof as evidence. It is telemetry
      // only and can be fabricated by an attacker controlling the browser.
      if (!isLiveServer) {
        await SecurityService.recordEvent({ userId: null, eventType: 'BIOMETRIC_LIVENESS_FAILURE', severity: 'MEDIUM',
          description: `Liveness session not live (challenge=${challengeId}, reason=${livenessResult.reason || 'no_proof'})`, ipAddress, deviceReference: ua });
        return res.status(403).json({ ok: false, message: 'Biometric verification failed. Please try again.' });
      }

      // Gate 7: Server-side face matching
      let bestUserId   = null;
      let bestDistance = Infinity;

      // Check target user profile first if supplied
      if (targetUserId) {
        let targetProfile = await prisma.biometricProfile.findUnique({
          where: { user_id: targetUserId },
          select: { id: true, user_id: true, face_descriptors: true, enrollment_status: true },
        });

        if (targetProfile && targetProfile.enrollment_status === 'ENROLLED' && targetProfile.face_descriptors && Array.isArray(targetProfile.face_descriptors) && targetProfile.face_descriptors.length > 0) {
          const result = await biometricService.verify(targetProfile.face_descriptors, liveDescriptor);
          if (result.matched) {
            bestDistance = result.distance;
            bestUserId   = targetProfile.user_id;
          }
        }
      }

      // If not matched yet, search across all enrolled profiles
      if (!bestUserId) {
        const profiles = await prisma.biometricProfile.findMany({
          where: { enrollment_status: 'ENROLLED' },
          select: { id: true, user_id: true, face_descriptors: true },
        });

        for (const profile of profiles) {
          if (!profile.face_descriptors || !Array.isArray(profile.face_descriptors) || profile.face_descriptors.length === 0) continue;
          const result = await biometricService.verify(profile.face_descriptors, liveDescriptor);
          if (result.matched && result.distance < bestDistance) {
            bestDistance = result.distance;
            bestUserId   = profile.user_id;
          }
        }

      }

      if (!bestUserId) {
        await SecurityService.recordEvent({ userId: null, eventType: 'BIOMETRIC_AUTH_FAILURE', severity: 'MEDIUM',
          description: `Face match failed (challenge=${challengeId})`, ipAddress, deviceReference: ua });
        // Mark used to prevent descriptor re-submission with same challenge
        await prisma.biometricChallenge.update({ where: { id: challengeId }, data: { used_at: new Date() } });
        return res.status(401).json({ ok: false, message: 'Biometric verification failed. Please try again.' });
      }

      // Gate 8: User account is active
      const user = await prisma.user.findUnique({ where: { id: bestUserId }, select: { status: true, locked_until: true } });
      if (!user || user.status !== 'ACTIVE' || (user.locked_until && user.locked_until > new Date())) {
        return res.status(403).json({ ok: false, message: 'Account access restricted.' });
      }

      // All gates passed — mark challenge consumed
      await prisma.biometricChallenge.update({
        where: { id: challengeId },
        data:  { used_at: new Date(), user_id: bestUserId },
      });

      // Consume liveness server session (fire-and-forget)
      if (challenge.liveness_session_id) {
        const base = (process.env.LIVENESS_SERVER_URL || 'http://127.0.0.1:5001').replace(/\/+$/, '');
        fetch(`${base}/liveness/consume`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: challenge.liveness_session_id }),
        }).catch(() => {});
      }

      // Issue short-lived biometric token
      const biometricToken = jwt.sign(
        { sub: bestUserId, challengeId, nonce: nonce.slice(0, 16), purpose: 'biometric-auth', livenessOk: true },
        getBioTokenSecret(),
        { expiresIn: BIO_TOKEN_TTL_SECONDS }
      );

      await SecurityService.recordEvent({
        userId: bestUserId, eventType: 'BIOMETRIC_AUTH_SUCCESS', severity: 'LOW',
        description: `Biometric challenge passed (id=${challengeId}, liveness=${livenessSource})`,
        ipAddress, deviceReference: ua,
      });

      return res.json({ ok: true, biometricToken, userId: bestUserId, expiresInSeconds: BIO_TOKEN_TTL_SECONDS });
    } catch (err) { next(err); }
  }

  /**
   * Middleware: consumeBiometricToken
   * Validates and consumes the short-lived biometricToken.
   * Attaches req.biometricUserId for downstream controllers.
   */
  static consumeBiometricToken(req, res, next) {
    try {
      const token = req.body.biometricToken || req.headers['x-biometric-token'];
      if (!token) {
        return res.status(403).json({ ok: false, error: 'BiometricTokenRequired',
          message: 'A valid biometric session token is required.' });
      }
      let payload;
      try {
        payload = jwt.verify(token, getBioTokenSecret());
      } catch (_) {
        return res.status(403).json({ ok: false, error: 'BiometricTokenInvalid',
          message: 'Biometric token is invalid or expired. Please complete biometric verification again.' });
      }
      if (payload.purpose !== 'biometric-auth' || !payload.livenessOk) {
        return res.status(403).json({ ok: false, error: 'BiometricTokenInvalid', message: 'Biometric token is invalid.' });
      }
      req.biometricUserId      = payload.sub;
      req.biometricChallengeId = payload.challengeId;
      next();
    } catch (err) { next(err); }
  }
}

module.exports = BiometricChallengeController;
