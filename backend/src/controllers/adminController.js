const prisma = require('../prisma');
const SecurityService = require('../services/securityService');

class AdminController {
  static async getAllUsers(req, res, next) {
    try {
      const users = await prisma.user.findMany({
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          full_name: true,
          phone: true,
          email: true,
          aadhaar_last4: true,
          role: true,
          status: true,
          failed_login_attempts: true,
          locked_until: true,
          is_senior: true,
          created_at: true,
          last_login_at: true,
          accounts: {
            select: {
              id: true,
              bank_name: true,
              account_number_masked: true,
              balance: true,
              is_primary: true
            }
          }
        }
      });

      res.json({
        ok: true,
        users: users.map(u => ({
          ...u,
          totalBalance: u.accounts.reduce((sum, a) => sum + Number(a.balance), 0)
        }))
      });
    } catch (err) {
      next(err);
    }
  }

  static async getUserById(req, res, next) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.params.id },
        include: {
          accounts: true,
          transactions: { take: 20, orderBy: { created_at: 'desc' } },
          security_events: { take: 20, orderBy: { created_at: 'desc' } },
          complaints: true,
          biometric_profile: { select: { biometric_provider: true, enrollment_status: true, updated_at: true } }
        }
      });

      if (!user) {
        return res.status(404).json({ ok: false, message: 'User not found.' });
      }

      // Safe user view without hashes
      const { password_hash, emergency_pin_hash, ...safeData } = user;

      res.json({
        ok: true,
        user: safeData
      });
    } catch (err) {
      next(err);
    }
  }

  static async updateUserStatus(req, res, next) {
    try {
      const { status } = req.body;
      const user = await prisma.user.findUnique({ where: { id: req.params.id } });

      if (!user) {
        return res.status(404).json({ ok: false, message: 'User not found.' });
      }

      const updated = await prisma.user.update({
        where: { id: req.params.id },
        data: {
          status,
          failed_login_attempts: status === 'ACTIVE' ? 0 : user.failed_login_attempts,
          locked_until: status === 'ACTIVE' ? null : user.locked_until
        }
      });

      await SecurityService.recordEvent({
        userId: user.id,
        eventType: 'ADMIN_USER_STATUS_CHANGE',
        severity: 'HIGH',
        description: `Admin (${req.user.full_name}) updated user status from ${user.status} to ${status}.`,
        ipAddress: req.ip,
        deviceReference: req.headers['user-agent']
      });

      res.json({
        ok: true,
        message: `User status changed to ${status}.`,
        user: { id: updated.id, status: updated.status }
      });
    } catch (err) {
      next(err);
    }
  }

  static async getAllTransactions(req, res, next) {
    try {
      const transactions = await prisma.transaction.findMany({
        orderBy: { created_at: 'desc' },
        take: 100,
        include: {
          user: { select: { full_name: true, phone: true, aadhaar_last4: true } },
          account: { select: { bank_name: true, account_number_masked: true } }
        }
      });

      res.json({
        ok: true,
        transactions
      });
    } catch (err) {
      next(err);
    }
  }

  static async getAllSecurityEvents(req, res, next) {
    try {
      const events = await prisma.securityEvent.findMany({
        orderBy: { created_at: 'desc' },
        take: 100,
        include: {
          user: { select: { full_name: true, phone: true, aadhaar_last4: true } }
        }
      });

      res.json({
        ok: true,
        events
      });
    } catch (err) {
      next(err);
    }
  }

  static async getAllComplaints(req, res, next) {
    try {
      const complaints = await prisma.complaint.findMany({
        orderBy: { created_at: 'desc' },
        include: {
          user: { select: { full_name: true, phone: true } },
          transaction: { select: { reference_number: true, amount: true, transaction_type: true } }
        }
      });

      res.json({
        ok: true,
        complaints
      });
    } catch (err) {
      next(err);
    }
  }

  static async resolveComplaint(req, res, next) {
    try {
      const { status, adminResponse } = req.body;
      const complaint = await prisma.complaint.update({
        where: { id: req.params.id },
        data: {
          status,
          admin_response: adminResponse
        }
      });

      res.json({
        ok: true,
        message: 'Complaint resolved.',
        complaint
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = AdminController;
