const prisma = require('../prisma');

/**
 * Security Service
 * Logs and audits all authentication and security anomalies.
 */
class SecurityService {
  /**
   * Record a security event in PostgreSQL.
   */
  static async recordEvent({ userId = null, eventType, severity = 'LOW', description, ipAddress = null, deviceReference = null }) {
    try {
      return await prisma.securityEvent.create({
        data: {
          user_id: userId,
          event_type: eventType,
          severity: severity,
          description: description,
          ip_address: ipAddress,
          device_reference: deviceReference
        }
      });
    } catch (err) {
      console.error('Failed to record security event:', err.message);
      return null;
    }
  }

  /**
   * Handle failed login attempt for a user.
   * Increments failed count and locks account for 15 minutes after 5 consecutive failures.
   */
  static async handleFailedLogin(user, req) {
    if (!user) return;
    const ip = req.ip || req.connection.remoteAddress;
    const newCount = user.failed_login_attempts + 1;
    let isLocked = false;
    let lockedUntil = null;

    if (newCount >= 5) {
      isLocked = true;
      lockedUntil = new Date(Date.now() + 15 * 60 * 1000); // Lock for 15 minutes
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failed_login_attempts: newCount,
        status: isLocked ? 'LOCKED' : user.status,
        locked_until: lockedUntil
      }
    });

    await this.recordEvent({
      userId: user.id,
      eventType: isLocked ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED',
      severity: isLocked ? 'HIGH' : 'MEDIUM',
      description: isLocked
        ? `Account automatically locked for 15 minutes after ${newCount} consecutive failed attempts.`
        : `Failed login attempt (${newCount}/5).`,
      ipAddress: ip,
      deviceReference: req.headers['user-agent']
    });

    return { isLocked, remainingAttempts: Math.max(0, 5 - newCount) };
  }

  /**
   * Reset failed attempts upon successful login.
   */
  static async handleSuccessfulLogin(user, req) {
    const ip = req.ip || req.connection.remoteAddress;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failed_login_attempts: 0,
        last_login_at: new Date()
      }
    });

    await this.recordEvent({
      userId: user.id,
      eventType: 'LOGIN_SUCCESS',
      severity: 'LOW',
      description: `Successful login session initialized.`,
      ipAddress: ip,
      deviceReference: req.headers['user-agent']
    });
  }

  /**
   * Handle emergency duress PIN entry.
   */
  static async handleDuressAlert(user, req) {
    const ip = req.ip || req.connection.remoteAddress;

    await this.recordEvent({
      userId: user.id,
      eventType: 'DURESS_ALERT',
      severity: 'CRITICAL',
      description: `🚨 Emergency duress PIN entered by user. Covert security alert triggered.`,
      ipAddress: ip,
      deviceReference: req.headers['user-agent']
    });
  }

  /**
   * Handle multiple face detection anomaly.
   */
  static async handleMultipleFacesDetected(userId, req) {
    const ip = req.ip || req.connection.remoteAddress;

    await this.recordEvent({
      userId: userId || null,
      eventType: 'MULTIPLE_FACE_DETECTED',
      severity: 'HIGH',
      description: `Multiple faces detected in camera frame during sensitive authentication flow.`,
      ipAddress: ip,
      deviceReference: req.headers['user-agent']
    });
  }
}

module.exports = SecurityService;
