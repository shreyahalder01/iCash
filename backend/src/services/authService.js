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
      emergencyContactName,
      emergencyContactPhone,
      descriptors,
      role = 'USER'
    } = data;

    // Check if phone already registered
    const existingPhone = await prisma.user.findUnique({
      where: { phone }
    });
    if (existingPhone) {
      const err = new Error('A user with this mobile number is already registered.');
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

    // Atomic creation of user, default bank account, and biometric profile
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          full_name: fullName,
          phone,
          email: email || null,
          aadhaar_reference: aadhaarReference,
          aadhaar_last4: aadhaarLast4,
          aadhaar_verified: true,
          password_hash: passwordHash,
          emergency_pin_hash: emergencyPinHash,
          dob: dob ? new Date(dob) : null,
          age,
          is_senior: computedSenior,
          emergency_contact_name: computedSenior ? emergencyContactName : null,
          emergency_contact_phone: computedSenior ? emergencyContactPhone : null,
          role: role || 'USER',
          status: 'ACTIVE'
        }
      });

      // Primary Savings account with initial starting balance
      const initialBalance = 25000.00;
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
          status: 'ACTIVE'
        }
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
          reference_number: `TX_OPEN_${Date.now()}`
        }
      });

      // Biometric profile
      const bioEnrollment = await biometricService.enroll(user.id, descriptors);
      await tx.biometricProfile.create({
        data: {
          user_id: user.id,
          biometric_provider: bioEnrollment.provider,
          biometric_reference: bioEnrollment.reference,
          enrollment_status: 'ENROLLED',
          face_descriptors: bioEnrollment.descriptors
        }
      });

      // If registered as MERCHANT, create Merchant Profile
      if (role === 'MERCHANT') {
        await tx.merchantProfile.create({
          data: {
            user_id: user.id,
            business_name: `${fullName}'s Enterprise`,
            settlement_acct: accountMasked
          }
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
      deviceReference: req?.headers['user-agent']
    });

    // Create session token
    const token = signToken({ userId: result.user.id, role: result.user.role });
    await prisma.loginSession.create({
      data: {
        user_id: result.user.id,
        session_reference: `SES_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        ip_address: req?.ip,
        user_agent: req?.headers['user-agent'],
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000)
      }
    });

    return {
      user: this.toSafeUser(result.user, result.primaryAccount),
      token
    };
  }

  /**
   * Find candidate users matching last 4 digits of Aadhaar.
   */
  static async findByAadhaarLast4(aadhaarLast4) {
    const users = await prisma.user.findMany({
      where: {
        aadhaar_last4: aadhaarLast4,
        status: { not: 'SUSPENDED' }
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
        locked_until: true
      }
    });

    return users.map(u => ({
      id: u.id,
      name: u.full_name,
      phone: u.phone,
      aadhaarLast4: u.aadhaar_last4,
      isSenior: u.is_senior,
      role: u.role,
      isLocked: u.status === 'LOCKED' || (u.locked_until && u.locked_until > new Date())
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
          orderBy: { is_primary: 'desc' }
        },
        biometric_profile: true,
        merchant_profile: true
      }
    });

    if (!user) {
      const err = new Error('The credentials you entered are incorrect.');
      err.status = 401;
      throw err;
    }

    // Check lock status
    if (user.status === 'LOCKED' || (user.locked_until && user.locked_until > new Date())) {
      const err = new Error('For your protection, access to this account has been temporarily restricted.');
      err.status = 403;
      throw err;
    }

    // Verify Primary PIN
    const isPrimaryPin = await compareValue(pin, user.password_hash);
    
    // Check if Emergency Duress PIN was entered
    const isDuressPin = user.emergency_pin_hash ? await compareValue(pin, user.emergency_pin_hash) : false;

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
      await SecurityService.handleDuressAlert(user, req);
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
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000)
      }
    });

    return {
      user: this.toSafeUser(user, user.accounts[0]),
      token,
      isDuress: isDuressPin
    };
  }

  /**
   * Verify authenticated phone credentials via Phone.email user_json_url
   */
  static async verifyPhoneEmailUrl(userJsonUrl, req) {
    if (!userJsonUrl || typeof userJsonUrl !== 'string') {
      const err = new Error('Invalid user_json_url provided.');
      err.status = 400;
      throw err;
    }

    // Security check: Must be on https://user.phone.email/ or *.phone.email
    const parsedUrl = new URL(userJsonUrl);
    if (parsedUrl.protocol !== 'https:' || !parsedUrl.hostname.endsWith('phone.email')) {
      const err = new Error('Unauthorized verification source.');
      err.status = 403;
      throw err;
    }

    // Fetch the JSON from the provider
    let jsonData = null;
    try {
      const response = await fetch(userJsonUrl);
      if (!response.ok) throw new Error('Fetch failed with status ' + response.status);
      jsonData = await response.json();
    } catch (fetchErr) {
      // Fallback to https.get
      jsonData = await new Promise((resolve, reject) => {
        const https = require('https');
        https.get(userJsonUrl, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
            }
          });
        }).on('error', reject);
      });
    }

    if (!jsonData) {
      const err = new Error('Could not retrieve verified phone details from provider.');
      err.status = 502;
      throw err;
    }

    const user_country_code = jsonData.user_country_code || '';
    const user_phone_number = jsonData.user_phone_number || '';
    const user_first_name = jsonData.user_first_name || '';
    const user_last_name = jsonData.user_last_name || '';

    console.log("User Country Code:", user_country_code);
    console.log("User Phone Number:", user_phone_number);
    console.log("User First Name:", user_first_name);
    console.log("User Last name:", user_last_name);

    let phone = String(user_phone_number).trim();
    const countryCode = String(user_country_code).trim();
    const firstName = user_first_name;
    const lastName = user_last_name;

    // Standardize 10-digit mobile number if country code attached
    if (phone.length > 10 && (countryCode === '91' || countryCode === '+91' || phone.startsWith('91'))) {
      phone = phone.slice(-10);
    }

    // Check if user exists
    const existingUser = await prisma.user.findUnique({
      where: { phone },
      include: {
        accounts: {
          where: { status: 'ACTIVE' },
          orderBy: { is_primary: 'desc' }
        }
      }
    });

    if (existingUser) {
      return {
        ok: true,
        phone,
        countryCode,
        fullName: existingUser.full_name,
        isExistingUser: true,
        user: {
          id: existingUser.id,
          name: existingUser.full_name,
          phone: existingUser.phone,
          aadhaarLast4: existingUser.aadhaar_last4,
          isSenior: existingUser.is_senior,
          role: existingUser.role,
          isLocked: existingUser.status === 'LOCKED' || (existingUser.locked_until && existingUser.locked_until > new Date())
        }
      };
    }

    return {
      ok: true,
      phone,
      countryCode,
      fullName: `${firstName} ${lastName}`.trim(),
      isExistingUser: false,
      user: null
    };
  }

  /**
   * Log out session.
   */
  static async logout(userId) {
    if (!userId) return;
    await prisma.loginSession.updateMany({
      where: {
        user_id: userId,
        revoked_at: null
      },
      data: {
        revoked_at: new Date()
      }
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
      emergencyContact: user.is_senior ? {
        name: user.emergency_contact_name,
        phone: user.emergency_contact_phone
      } : null,
      role: user.role,
      status: user.status,
      lastLoginAt: user.last_login_at,
      primaryAccount: primaryAccount ? {
        id: primaryAccount.id,
        bankName: primaryAccount.bank_name,
        accountNumberMasked: primaryAccount.account_number_masked,
        accountType: primaryAccount.account_type,
        balance: Number(primaryAccount.balance),
        currency: primaryAccount.currency
      } : null
    };
  }
}

module.exports = AuthService;
