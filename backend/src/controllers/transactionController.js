const TransactionService = require('../services/transactionService');

class TransactionController {
  static async getTransactions(req, res, next) {
    try {
      const { limit, offset, type } = req.query;
      const transactions = await TransactionService.getUserTransactions(req.user.id, { limit, offset, type });
      res.json({
        ok: true,
        transactions
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
        transaction: tx
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
        accountMasked: result.accountMasked
      });
    } catch (err) {
      next(err);
    }
  }

  static async topUpDemoFunds(req, res, next) {
    try {
      const amount = Number(req.body.amount) || 5000;
      const result = await TransactionService.processTransaction(req.user.id, {
        transactionType: 'DEPOSIT',
        amount,
        description: 'Instant demo funds top-up'
      }, req);
      res.json({
        ok: true,
        message: `₹${amount.toLocaleString('en-IN')} deposited successfully.`,
        newBalance: result.newBalance,
        transaction: result.transaction
      });
    } catch (err) {
      next(err);
    }
  }

  static async generateDelegateOtp(req, res, next) {
    try {
      const { amount } = req.body;
      const result = await TransactionService.generateDelegationOtp(req.user.id, amount, req);
      res.json({
        ok: true,
        message: 'Delegation OTP generated successfully.',
        ...result
      });
    } catch (err) {
      next(err);
    }
  }

  static async claimDelegateWithdrawal(req, res, next) {
    try {
      const { seniorName, otp } = req.body;
      const result = await TransactionService.claimDelegatedWithdrawal(seniorName, otp, req);
      res.json({
        ok: true,
        message: `₹${result.amount.toLocaleString('en-IN')} released successfully for ${result.seniorName}.`,
        ...result
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = TransactionController;
