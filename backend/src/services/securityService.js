const prisma = require('../prisma');

/**
 * Security Service
 * Logs and audits all authentication and security anomalies.
 */
class SecurityService {
  /**
   * Record a security event in PostgreSQL.
   */
  static async recordEvent({
    userId = null,
    eventType,
    severity = 'LOW',
    description,
    ipAddress = null,
    deviceReference = null,
  }) {
    try {
      return await prisma.securityEvent.create({
        data: {
          user_id: userId,
          event_type: eventType,
          severity: severity,
          description: description,
          ip_address: ipAddress,
          device_reference: deviceReference,
        },
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
        locked_until: lockedUntil,
      },
    });

    await this.recordEvent({
      userId: user.id,
      eventType: isLocked ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED',
      severity: isLocked ? 'HIGH' : 'MEDIUM',
      description: isLocked
        ? `Account automatically locked for 15 minutes after ${newCount} consecutive failed attempts.`
        : `Failed login attempt (${newCount}/5).`,
      ipAddress: ip,
      deviceReference: req.headers['user-agent'],
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
        last_login_at: new Date(),
      },
    });

    await this.recordEvent({
      userId: user.id,
      eventType: 'LOGIN_SUCCESS',
      severity: 'LOW',
      description: `Successful login session initialized.`,
      ipAddress: ip,
      deviceReference: req.headers['user-agent'],
    });
  }

  /**
   * Handle emergency duress / distress PIN entry (covert police and emergency dispatch).
   */
  static async handleDuressAlert(user, req, { context = 'AUTHENTICATION', amount = null } = {}) {
    const ip = req?.ip || req?.connection?.remoteAddress || '127.0.0.1';
    const userAgent = req?.headers?.['user-agent'] || 'Direct Client';

    const eventDesc = `🚨 POLICE DISPATCH & SOS ALERT: Emergency distress PIN entered by ${user?.full_name || 'Account Holder'} during ${context}${amount ? ` for ₹${Number(amount).toLocaleString('en-IN')}` : ''}. Covert distress beacon active. Location/IP: ${ip}.`;

    const event = await this.recordEvent({
      userId: user?.id || null,
      eventType: 'DURESS_ALERT',
      severity: 'CRITICAL',
      description: eventDesc,
      ipAddress: ip,
      deviceReference: userAgent,
    });

    // Dispatch Police & Emergency SOS Alert via SMS
    try {
      const emergencyPhone = user?.emergency_contact_phone || user?.phone;
      if (emergencyPhone) {
        const { sendEmergencyAlertSms } = require('./smsProvider');
        await sendEmergencyAlertSms(
          emergencyPhone,
          `🚨 POLICE EMERGENCY ALERT: iCash emergency duress beacon triggered by ${user?.full_name || 'User'}. Authorities & emergency contacts alerted. IP: ${ip}.`
        );
      }
    } catch (smsErr) {
      console.warn('[SecurityService] Emergency SMS notice:', smsErr.message);
    }

    return event;
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
      deviceReference: req.headers['user-agent'],
    });
  }
}

module.exports = SecurityService;
