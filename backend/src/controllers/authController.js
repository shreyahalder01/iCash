const AuthService = require('../services/authService');
const { COOKIE_NAME, getCookieOptions } = require('../utils/token');

class AuthController {
  static async register(req, res, next) {
    try {
      const { user, token } = await AuthService.registerUser(req.body, req);
      res.cookie(COOKIE_NAME, token, getCookieOptions());
      res.status(201).json({
        ok: true,
        message: 'Registration completed successfully.',
        user,
        token
      });
    } catch (err) {
      next(err);
    }
  }

  static async lookupAadhaar(req, res, next) {
    try {
      const { aadhaarLast4 } = req.body;
      const matchingUsers = await AuthService.findByAadhaarLast4(aadhaarLast4);
      res.json({
        ok: true,
        users: matchingUsers
      });
    } catch (err) {
      next(err);
    }
  }

  static async loginPin(req, res, next) {
    try {
      const { userId, pin } = req.body;
      const { user, token, isDuress } = await AuthService.loginWithPin(userId, pin, req);
      res.cookie(COOKIE_NAME, token, getCookieOptions());
      res.json({
        ok: true,
        message: isDuress ? 'Emergency access mode active.' : 'Authenticated successfully.',
        user,
        token,
        isDuress
      });
    } catch (err) {
      next(err);
    }
  }

  static async getMe(req, res, next) {
    try {
      const primaryAccount = req.user.accounts && req.user.accounts[0];
      const safeUser = AuthService.toSafeUser(req.user, primaryAccount);
      res.json({
        ok: true,
        user: safeUser
      });
    } catch (err) {
      next(err);
    }
  }

  static async logout(req, res, next) {
    try {
      if (req.user) {
        await AuthService.logout(req.user.id);
      }
      res.clearCookie(COOKIE_NAME, getCookieOptions());
      res.json({
        ok: true,
        message: 'Logged out successfully.'
      });
    } catch (err) {
      next(err);
    }
  }

  static async verifyPhoneEmail(req, res, next) {
    try {
      const { user_json_url } = req.body;
      const result = await AuthService.verifyPhoneEmailUrl(user_json_url, req);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async refresh(req, res, next) {
    try {
      if (!req.user) {
        return res.status(401).json({ ok: false, message: 'Session expired.' });
      }
      const token = require('../utils/token').signToken({ userId: req.user.id, role: req.user.role });
      res.cookie(COOKIE_NAME, token, getCookieOptions());
      res.json({
        ok: true,
        token
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = AuthController;
