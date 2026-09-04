const prisma = require('../prisma');
const SecurityService = require('../services/securityService');
const crypto = require('crypto');

class MerchantController {
  static async getProfile(req, res, next) {
    try {
      let merchant = await prisma.merchantProfile.findUnique({
        where: { user_id: req.user.id },
        include: {
          payment_requests: {
            orderBy: { created_at: 'desc' },
            take: 20,
          },
        },
      });

      if (!merchant) {
        // Auto-create merchant profile if user has MERCHANT role
        merchant = await prisma.merchantProfile.create({
          data: {
            user_id: req.user.id,
            business_name: `${req.user.full_name}'s Enterprise`,
            settlement_acct: req.user.accounts[0]?.account_number_masked || '•••• 8888',
            settled_balance: 145000.0,
            pending_balance: 12500.0,
          },
          include: {
            payment_requests: true,
          },
        });
      }

      res.json({
        ok: true,
        merchant: {
          id: merchant.id,
          businessName: merchant.business_name,
          settlementAcct: merchant.settlement_acct,
          settledBalance: Number(merchant.settled_balance),
          pendingBalance: Number(merchant.pending_balance),
          paymentRequests: merchant.payment_requests,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  static async createPaymentRequest(req, res, next) {
    try {
      const { amount, description } = req.body;
      const merchant = await prisma.merchantProfile.findUnique({
        where: { user_id: req.user.id },
      });

      if (!merchant) {
        return res.status(404).json({ ok: false, message: 'Merchant profile not found.' });
      }

      const refCode = `PAY_REQ_${crypto.randomUUID()}`;
      const paymentRequest = await prisma.paymentRequest.create({
        data: {
          merchant_id: merchant.id,
          amount: Number(amount),
          description: description || 'Merchant point-of-sale payment',
          reference_code: refCode,
          expires_at: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
        },
      });

      res.status(201).json({
        ok: true,
        message: 'Payment request created.',
        paymentRequest,
      });
    } catch (err) {
      next(err);
    }
  }

  static async getTransactions(req, res, next) {
    try {
      const transactions = await prisma.transaction.findMany({
        where: { user_id: req.user.id },
        orderBy: { created_at: 'desc' },
        take: 50,
      });

      res.json({
        ok: true,
        transactions,
      });
    } catch (err) {
      next(err);
    }
  }

  static async getSettlements(req, res, next) {
    try {
      const merchant = await prisma.merchantProfile.findUnique({
        where: { user_id: req.user.id },
      });

      const settlements = [
        {
          id: 'SET_001',
          date: new Date(Date.now() - 24 * 60 * 60 * 1000),
          amount: 45000,
          status: 'SETTLED',
          utr: 'UTR98234710293',
        },
        {
          id: 'SET_002',
          date: new Date(Date.now() - 48 * 60 * 60 * 1000),
          amount: 100000,
          status: 'SETTLED',
          utr: 'UTR98234710111',
        },
        {
          id: 'SET_003',
          date: new Date(),
          amount: Number(merchant?.pending_balance || 12500),
          status: 'PROCESSING',
          utr: 'PENDING_BATCH',
        },
      ];

      res.json({
        ok: true,
        settlements,
        settledBalance: Number(merchant?.settled_balance || 145000),
        pendingBalance: Number(merchant?.pending_balance || 12500),
      });
    } catch (err) {
      next(err);
    }
  }

  static async processRefund(req, res, next) {
    try {
      const { transactionId, reason } = req.body;
      const tx = await prisma.transaction.findFirst({
        where: { id: transactionId, user_id: req.user.id },
      });

      if (!tx) {
        return res
          .status(404)
          .json({ ok: false, message: 'Transaction not found or not owned by merchant.' });
      }

      await SecurityService.recordEvent({
        userId: req.user.id,
        eventType: 'MERCHANT_REFUND_ISSUED',
        severity: 'MEDIUM',
        description: `Refund initiated for tx ${tx.reference_number}: ${reason}`,
        ipAddress: req.ip,
        deviceReference: req.headers['user-agent'],
      });

      res.json({
        ok: true,
        message: `Refund processed for ₹${Number(tx.amount).toLocaleString('en-IN')}.`,
        transactionId,
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = MerchantController;
