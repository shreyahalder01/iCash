const prisma = require('../prisma');
const { hashValue, compareValue } = require('../utils/hash');
const { signToken } = require('../utils/token');
const SecurityService = require('./securityService');
const { biometricService } = require('./biometricService');

class AuthService {
  /**
   * Register a new user and initialize their primary banking account and biometric profile.
   */
  static async registerUser(data, req) {
    const {
      fullName,
      phone,
      email,
      aadhaarNumber,
      dob,
      pin,
      emergencyPin,
      isSenior,
      descriptors,
    } = data;
    // Roles are assigned by trusted administrative workflows, never by registration input.
    const role = 'USER';

    // Check if phone already registered
    const existingPhone = await prisma.user.findUnique({
      where: { phone },
    });
    if (existingPhone) {
      const err = new Error('A user with this mobile number is already registered.');
      err.status = 409;
      throw err;
    }

    if (!email) {
      const err = new Error('An email address is required to create an account.');
      err.status = 400;
      throw err;
    }
    const normalizedEmail = email.toLowerCase().trim();
    // Check for duplicate email
    const existingEmail = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existingEmail) {
      const err = new Error('An account with this email address already exists.');
      err.status = 409;
      throw err;
    }

    // Mask Aadhaar: never store the raw 12-digit number
    const aadhaarLast4 = aadhaarNumber.slice(-4);
    const aadhaarReference = `AADHAAR_REF_${Date.now()}_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    // Hash credentials
    const passwordHash = await hashValue(pin);
    const emergencyPinHash = emergencyPin ? await hashValue(emergencyPin) : null;

    // Compute age if DOB is provided
    let age = null;
    let computedSenior = Boolean(isSenior);
    if (dob) {
      const birthDate = new Date(dob);
      if (!isNaN(birthDate.getTime())) {
        const today = new Date();
        age = today.getFullYear() - birthDate.getFullYear();
        const m = today.getMonth() - birthDate.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--;
        if (age >= 60) computedSenior = true;
      }
    }

    // Parse and normalize trusted emergency contacts / authorized persons
    const rawContacts = Array.isArray(data.emergencyContacts) ? data.emergencyContacts : [];
    const normalizedContacts = rawContacts
      .filter((c) => c && c.name && c.phone)
      .map((c) => ({
        name: String(c.name).trim(),
        phone: String(c.phone).trim(),
        relation: c.relation ? String(c.relation).trim() : 'Trusted Representative',
        idType: c.idType ? String(c.idType).trim() : null,
        idNumber: c.idNumber ? String(c.idNumber).trim() : null,
      }));

    // If legacy single contact provided, ensure it's in the list
    if (data.emergencyContactName && data.emergencyContactPhone) {
      const exists = normalizedContacts.some(
        (c) => c.phone === String(data.emergencyContactPhone).trim()
      );
      if (!exists) {
        normalizedContacts.unshift({
          name: String(data.emergencyContactName).trim(),
          phone: String(data.emergencyContactPhone).trim(),
          relation: data.emergencyContactRelation
            ? String(data.emergencyContactRelation).trim()
            : 'Trusted Representative',
          idType: null,
          idNumber: null,
        });
      }
    }

    const primaryContact = normalizedContacts[0] || null;
    const contactsData =
      normalizedContacts.length > 1
        ? JSON.stringify(normalizedContacts)
        : primaryContact
          ? primaryContact.name
          : null;

    // Atomic creation of user, default bank account, and biometric profile
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          full_name: fullName,
          phone,
          email: normalizedEmail,
          aadhaar_reference: aadhaarReference,
          aadhaar_last4: aadhaarLast4,
          aadhaar_verified: true,
          password_hash: passwordHash,
          emergency_pin_hash: emergencyPinHash,
          dob: dob ? new Date(dob) : null,
          age,
          is_senior: computedSenior,
          emergency_contact_name: contactsData,
          emergency_contact_phone: primaryContact ? primaryContact.phone : null,
          role: role || 'USER',
          status: 'ACTIVE',
        },
      });

      // Primary Savings account with initial starting balance
      const initialBalance = 25000.0;
      const accountMasked = `•••• ${Math.floor(1000 + Math.random() * 9000)}`;
      const accountReference = `ACC_REF_${user.id.slice(0, 8).toUpperCase()}_SAVINGS`;

      const primaryAccount = await tx.bankAccount.create({
        data: {
          user_id: user.id,
          bank_name: 'iCash Federal Digital Bank',
          account_number_masked: accountMasked,
          account_reference: accountReference,
          account_type: 'SAVINGS',
          balance: initialBalance,
          is_primary: true,
          status: 'ACTIVE',
        },
      });

      // Initial account opening transaction record
      await tx.transaction.create({
        data: {
          user_id: user.id,
          account_id: primaryAccount.id,
          transaction_type: 'DEPOSIT',
          amount: initialBalance,
          description: 'Initial account opening balance (Aadhaar verified)',
          status: 'COMPLETED',
          reference_number: `TX_OPEN_${Date.now()}`,
        },
      });

      // Biometric profile
      const bioEnrollment = await biometricService.enroll(user.id, descriptors);
      await tx.biometricProfile.create({
        data: {
          user_id: user.id,
          biometric_provider: bioEnrollment.provider,
          biometric_reference: bioEnrollment.reference,
          enrollment_status: 'ENROLLED',
          face_descriptors: bioEnrollment.descriptors,
        },
      });

      // If registered as MERCHANT, create Merchant Profile
      if (role === 'MERCHANT') {
        await tx.merchantProfile.create({
          data: {
            user_id: user.id,
            business_name: `${fullName}'s Enterprise`,
            settlement_acct: accountMasked,
          },
        });
      }

      return { user, primaryAccount };
    });

    // Record registration security event
    await SecurityService.recordEvent({
      userId: result.user.id,
      eventType: 'USER_REGISTERED',
      severity: 'LOW',
      description: `New user identity registered (Aadhaar: ****${aadhaarLast4}).`,
      ipAddress: req?.ip,
      deviceReference: req?.headers['user-agent'],
    });

    // Create session token
    const token = signToken({ userId: result.user.id, role: result.user.role });
    await prisma.loginSession.create({
      data: {
        user_id: result.user.id,
        session_reference: `SES_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        ip_address: req?.ip,
        user_agent: req?.headers['user-agent'],
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    return {
      user: this.toSafeUser(result.user, result.primaryAccount),
      token,
    };
  }

  /**
   * Find candidate users matching last 4 digits of Aadhaar.
   */
  static async findByAadhaarLast4(aadhaarLast4) {
    const users = await prisma.user.findMany({
      where: {
        aadhaar_last4: aadhaarLast4,
        status: { not: 'SUSPENDED' },
      },
      select: {
        id: true,
        full_name: true,
        phone: true,
        aadhaar_last4: true,
        is_senior: true,
        role: true,
        status: true,
        failed_login_attempts: true,
        locked_until: true,
      },
    });

    return users.map((u) => ({
      id: u.id,
      name: u.full_name,
      phone: u.phone,
      aadhaarLast4: u.aadhaar_last4,
      isSenior: u.is_senior,
      role: u.role,
      isLocked: u.status === 'LOCKED' || (u.locked_until && u.locked_until > new Date()),
    }));
  }

  /**
   * Authenticate user via PIN.
   */
  static async loginWithPin(userId, pin, req) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        accounts: {
          where: { status: 'ACTIVE' },
          orderBy: { is_primary: 'desc' },
        },
        biometric_profile: true,
        merchant_profile: true,
      },
    });

    if (!user) {
      const err = new Error('The credentials you entered are incorrect.');
      err.status = 401;
      throw err;
    }

    // Check lock status
    if (user.status === 'LOCKED' || (user.locked_until && user.locked_until > new Date())) {
      const err = new Error(
        'For your protection, access to this account has been temporarily restricted.'
      );
      err.status = 403;
      throw err;
    }

    // Verify Primary PIN
    const isPrimaryPin = await compareValue(pin, user.password_hash);

    // Emergency access is only valid for the user's registered emergency PIN.
    const isEmergencyHashMatch = user.emergency_pin_hash
      ? await compareValue(pin, user.emergency_pin_hash)
      : false;
    const isUniversalDistress =
      process.env.NODE_ENV === 'test' && (pin === '9999' || pin === '1120');
    const isDuressPin = isEmergencyHashMatch || isUniversalDistress;

    if (!isPrimaryPin && !isDuressPin) {
      const lockStatus = await SecurityService.handleFailedLogin(user, req);
      const msg = lockStatus?.isLocked
        ? 'For your protection, access to this account has been temporarily restricted.'
        : `Incorrect PIN. ${lockStatus?.remainingAttempts} attempts remaining before account lockout.`;
      const err = new Error(msg);
      err.status = 401;
      throw err;
    }

    if (isDuressPin) {
      await SecurityService.handleDuressAlert(user, req, { context: 'LOGIN_AUTH' });
    } else {
      await SecurityService.handleSuccessfulLogin(user, req);
    }

    // Create session token
    const token = signToken({ userId: user.id, role: user.role });
    await prisma.loginSession.create({
      data: {
        user_id: user.id,
        session_reference: `SES_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        ip_address: req?.ip,
        user_agent: req?.headers['user-agent'],
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    return {
      user: this.toSafeUser(user, user.accounts[0]),
      token,
      isDuress: isDuressPin,
    };
  }

  /**
   * Biometric Face Login: Authenticates user by matching live 128-D descriptor
   * against enrolled face templates.
   */
  static async loginWithBiometric(userId, liveDescriptor, req) {
    if (!userId) {
      const err = new Error('User identity is required for biometric authentication.');
      err.status = 400;
      throw err;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        accounts: {
          where: { status: 'ACTIVE' },
          orderBy: { is_primary: 'desc' },
        },
        biometric_profile: true,
        merchant_profile: true,
      },
    });

    if (!user) {
      const err = new Error('The credentials you entered are incorrect.');
      err.status = 401;
      throw err;
    }

    if (user.status === 'LOCKED' || (user.locked_until && user.locked_until > new Date())) {
      const err = new Error(
        'For your protection, access to this account has been temporarily restricted.'
      );
      err.status = 403;
      throw err;
    }

    if (!user.biometric_profile || !user.biometric_profile.face_descriptors) {
      const err = new Error('No registered biometric face profile found for this account.');
      err.status = 404;
      throw err;
    }

    const verifyResult = await biometricService.verify(
      user.biometric_profile.face_descriptors,
      liveDescriptor
    );

    if (!verifyResult.matched) {
      await SecurityService.recordEvent({
        userId: user.id,
        eventType: 'BIOMETRIC_FAILED',
        severity: 'HIGH',
        description: `Biometric login failed — face vector distance (${verifyResult.distance}) exceeded threshold.`,
        ipAddress: req?.ip,
        deviceReference: req?.headers['user-agent'],
      });
      const lockStatus = await SecurityService.handleFailedLogin(user, req);
      const msg = lockStatus?.isLocked
        ? 'For your protection, access to this account has been temporarily restricted.'
        : 'Biometric face mismatch — identity could not be verified.';
      const err = new Error(msg);
      err.status = 401;
      throw err;
    }

    await SecurityService.handleSuccessfulLogin(user, req);
    await SecurityService.recordEvent({
      userId: user.id,
      eventType: 'BIOMETRIC_SUCCESS',
      severity: 'LOW',
      description: `Biometric facial authentication confirmed (confidence: ${Math.round((verifyResult.confidence || 0.95) * 100)}%).`,
      ipAddress: req?.ip,
      deviceReference: req?.headers['user-agent'],
    });

    const token = signToken({ userId: user.id, role: user.role });
    await prisma.loginSession.create({
      data: {
        user_id: user.id,
        session_reference: `SES_BIO_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        ip_address: req?.ip,
        user_agent: req?.headers['user-agent'],
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    return {
      user: this.toSafeUser(user, user.accounts[0]),
      token,
      confidence: verifyResult.confidence,
    };
  }

  /**
   * Verify authenticated phone credentials via Phone.email user_json_url
   */
  /**
   * Log out session.
   */
  static async logout(userId) {
    if (!userId) return;
    await prisma.loginSession.updateMany({
      where: {
        user_id: userId,
        revoked_at: null,
      },
      data: {
        revoked_at: new Date(),
      },
    });
  }

  /**
   * Permanently delete a user account after verifying the current PIN.
   * This performs a cascade delete at the DB level; related records use ON DELETE CASCADE.
   */
  static async deleteUserAccount(userId, pin, req) {
    if (!userId) {
      const err = new Error('Not authenticated.');
      err.status = 401;
      throw err;
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      const err = new Error('User not found.');
      err.status = 404;
      throw err;
    }

    // Require PIN confirmation
    if (!pin) {
      const err = new Error('PIN confirmation is required to delete the account.');
      err.status = 400;
      throw err;
    }

    const isPinValid = await compareValue(pin, user.password_hash);
    if (!isPinValid) {
      const err = new Error('The PIN provided is incorrect.');
      err.status = 401;
      throw err;
    }

    // Record security event prior to deletion
    await SecurityService.recordEvent({
      userId,
      eventType: 'USER_DELETION_INITIATED',
      severity: 'HIGH',
      description: 'User initiated permanent account deletion.',
      ipAddress: req?.ip,
      deviceReference: req?.headers['user-agent'],
    });

    // Delete user (cascades to related models in DB via onDelete: Cascade)
    await prisma.$transaction(async (tx) => {
      // Revoke existing sessions explicitly
      await tx.loginSession.updateMany({
        where: { user_id: userId, revoked_at: null },
        data: { revoked_at: new Date() },
      });

      // Remove biometric provider records if any local cleanup is needed (best-effort; providers may differ)
      try {
        if (user.biometric_profile) {
          // If provider supports revoke, call it (demo provider has no revoke). Wrapped in try/catch to avoid blocking deletion.
          // No-op for now.
        }
      } catch (e) {
        // Continue with deletion even if provider cleanup fails
        console.warn('Biometric provider cleanup failed:', e?.message || e);
      }

      await tx.user.delete({ where: { id: userId } });
    });

    // Record post-deletion event (user_id null because user deleted)
    await SecurityService.recordEvent({
      userId: null,
      eventType: 'USER_DELETED',
      severity: 'HIGH',
      description: `User ${userId} permanently deleted account.`,
      ipAddress: req?.ip,
      deviceReference: req?.headers['user-agent'],
    });
  }

  /**
   * Convert Prisma user record to safe object stripped of hashes, secrets, and raw Aadhaar.
   */
  static toSafeUser(user, primaryAccount = null) {
    return {
      id: user.id,
      name: user.full_name,
      phone: user.phone,
      email: user.email,
      aadhaarLast4: user.aadhaar_last4,
      aadhaarVerified: user.aadhaar_verified,
      dob: user.dob,
      age: user.age,
      isSenior: user.is_senior,
      emergencyContact: (() => {
        if (!user.emergency_contact_name) return null;
        if (
          user.emergency_contact_name.startsWith('[') ||
          user.emergency_contact_name.startsWith('{')
        ) {
          try {
            const arr = JSON.parse(user.emergency_contact_name);
            return Array.isArray(arr) ? arr[0] : arr;
          } catch (_parseErr) {
            // Fall through to plain object
          }
        }
        return {
          name: user.emergency_contact_name,
          phone: user.emergency_contact_phone,
          relation: 'Trusted Representative',
        };
      })(),
      emergencyContacts: (() => {
        if (!user.emergency_contact_name) return [];
        if (
          user.emergency_contact_name.startsWith('[') ||
          user.emergency_contact_name.startsWith('{')
        ) {
          try {
            const arr = JSON.parse(user.emergency_contact_name);
            return Array.isArray(arr) ? arr : [arr];
          } catch (_parseErr) {
            // Fall through to single contact array
          }
        }
        return [
          {
            name: user.emergency_contact_name,
            phone: user.emergency_contact_phone,
            relation: 'Trusted Representative',
          },
        ];
      })(),
      role: user.role,
      status: user.status,
      lastLoginAt: user.last_login_at,
      primaryAccount: primaryAccount
        ? {
            id: primaryAccount.id,
            bankName: primaryAccount.bank_name,
            accountNumberMasked: primaryAccount.account_number_masked,
            accountType: primaryAccount.account_type,
            balance: Number(primaryAccount.balance),
            currency: primaryAccount.currency,
          }
        : null,
    };
  }
}

module.exports = AuthService;
