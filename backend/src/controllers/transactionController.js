const TransactionService = require('../services/transactionService');

class TransactionController {
  static async getTransactions(req, res, next) {
    try {
      const { limit, offset, type } = req.query;
      const transactions = await TransactionService.getUserTransactions(req.user.id, {
        limit,
        offset,
        type,
      });
      res.json({
        ok: true,
        transactions,
      });
    } catch (err) {
      next(err);
    }
  }

  static async getTransactionById(req, res, next) {
    try {
      const tx = await TransactionService.getTransactionById(req.user.id, req.params.id);
      res.json({
        ok: true,
        transaction: tx,
      });
    } catch (err) {
      next(err);
    }
  }

  static async createTransaction(req, res, next) {
    try {
      const result = await TransactionService.processTransaction(req.user.id, req.body, req);
      res.status(201).json({
        ok: true,
        message: 'Transaction completed successfully.',
        transaction: result.transaction,
        newBalance: result.newBalance,
        accountMasked: result.accountMasked,
      });
    } catch (err) {
      next(err);
    }
  }

  static async topUpDemoFunds(req, res, next) {
    try {
      if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_TOPUP !== 'true') {
        return res.status(404).json({ ok: false, error: 'NotFound', message: 'Endpoint not found.' });
      }
      const amount = Number(req.body.amount) || 5000;
      const result = await TransactionService.processTransaction(
        req.user.id,
        {
          transactionType: 'DEPOSIT',
          amount,
          description: 'Instant demo funds top-up',
        },
        req
      );
      res.json({
        ok: true,
        message: `₹${amount.toLocaleString('en-IN')} deposited successfully.`,
        newBalance: result.newBalance,
        transaction: result.transaction,
      });
    } catch (err) {
      next(err);
    }
  }

  static async requestEmergencyWithdrawal(req, res, next) {
    try {
      const result = await TransactionService.requestEmergencyWithdrawal(req.body, req);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async verifyEmergencyWithdrawal(req, res, next) {
    try {
      const result = await TransactionService.verifyEmergencyWithdrawal(req.body, req);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async getEmergencyContacts(req, res, next) {
    try {
      const contacts = await TransactionService.getEmergencyContacts(req.user.id);
      res.json({
        ok: true,
        contacts,
      });
    } catch (err) {
      next(err);
    }
  }

  static async updateEmergencyContacts(req, res, next) {
    try {
      const { contacts } = req.body;
      const updated = await TransactionService.updateEmergencyContacts(req.user.id, contacts, req);
      res.json({
        ok: true,
        message: 'Emergency contacts updated successfully.',
        contacts: updated,
      });
    } catch (err) {
      next(err);
    }
  }

  static async generateDelegateOtp(req, res, next) {
    try {
      const { amount } = req.body;
      const result = await TransactionService.generateDelegatedOtp(req.user.id, amount, req);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async claimDelegateWithdrawal(req, res, next) {
    try {
      const { seniorName, otp } = req.body;
      const result = await TransactionService.claimDelegatedWithdrawal(seniorName, otp, req);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = TransactionController;
