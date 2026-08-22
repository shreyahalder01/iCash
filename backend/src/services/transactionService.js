const prisma = require('../prisma');
const SecurityService = require('./securityService');
const { hashValue, compareValue } = require('../utils/hash');

class TransactionService {
  /**
   * Get transaction history for user.
   */
  static async getUserTransactions(userId, { limit = 50, offset = 0, type = null } = {}) {
    const where = { user_id: userId };
    if (type) where.transaction_type = type;

    const transactions = await prisma.transaction.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: Number(limit),
      skip: Number(offset),
      include: {
        account: {
          select: {
            bank_name: true,
            account_number_masked: true,
          },
        },
      },
    });

    return transactions.map((t) => ({
      id: t.id,
      accountId: t.account_id,
      bankName: t.account?.bank_name,
      accountMasked: t.account?.account_number_masked,
      type: t.transaction_type,
      amount: Number(t.amount),
      currency: t.currency,
      description: t.description,
      status: t.status,
      referenceNumber: t.reference_number,
      recipientName: t.recipient_name,
      recipientAccount: t.recipient_account,
      createdAt: t.created_at,
    }));
  }

  /**
   * Get single transaction details.
   */
  static async getTransactionById(userId, transactionId) {
    const tx = await prisma.transaction.findFirst({
      where: {
        id: transactionId,
        user_id: userId,
      },
      include: {
        account: true,
        complaints: true,
      },
    });

    if (!tx) {
      const err = new Error('Transaction not found or access denied.');
      err.status = 404;
      throw err;
    }

    return {
      id: tx.id,
      accountId: tx.account_id,
      bankName: tx.account?.bank_name,
      accountMasked: tx.account?.account_number_masked,
      type: tx.transaction_type,
      amount: Number(tx.amount),
      currency: tx.currency,
      description: tx.description,
      status: tx.status,
      referenceNumber: tx.reference_number,
      recipientName: tx.recipient_name,
      recipientAccount: tx.recipient_account,
      createdAt: tx.created_at,
      complaints: tx.complaints,
    };
  }

  /**
   * Process financial transaction atomically using PostgreSQL transaction block.
   */
  static async processTransaction(userId, payload, req) {
    const {
      accountId,
      transactionType,
      amount,
      description,
      recipientName,
      recipientAccount,
      recipientUserId,
      verifyMethod,
    } = payload;
    const numAmount = Number(amount);

    if (isNaN(numAmount) || numAmount <= 0) {
      const err = new Error('Invalid transaction amount.');
      err.status = 400;
      throw err;
    }

    return await prisma.$transaction(async (tx) => {
      // 1. Fetch user's target account (or primary account if none specified)
      let account;
      if (accountId) {
        account = await tx.bankAccount.findFirst({
          where: { id: accountId, user_id: userId, status: 'ACTIVE' },
        });
      } else {
        account = await tx.bankAccount.findFirst({
          where: { user_id: userId, is_primary: true, status: 'ACTIVE' },
        });
      }

      if (!account) {
        const err = new Error('Active banking account not found for this user.');
        err.status = 404;
        throw err;
      }

      const currentBalance = Number(account.balance);
      const refNumber = `TX_${Date.now()}_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

      // 2. Handle specific transaction types
      if (transactionType === 'WITHDRAWAL') {
        if (currentBalance < numAmount) {
          const err = new Error(
            `Insufficient funds. Your balance is ₹${currentBalance.toLocaleString('en-IN')}.`
          );
          err.status = 400;
          throw err;
        }

        const newBalance = currentBalance - numAmount;
        await tx.bankAccount.update({
          where: { id: account.id },
          data: { balance: newBalance },
        });

        const createdTx = await tx.transaction.create({
          data: {
            user_id: userId,
            account_id: account.id,
            transaction_type: 'WITHDRAWAL',
            amount: numAmount,
            description: description || 'ATM cash withdrawal (biometric verified)',
            status: 'COMPLETED',
            reference_number: refNumber,
          },
        });

        await tx.securityEvent.create({
          data: {
            user_id: userId,
            event_type: 'TRANSACTION_SUCCESS',
            severity: numAmount >= 10000 ? 'MEDIUM' : 'LOW',
            description: `Withdrawal of ₹${numAmount.toLocaleString('en-IN')} authorized via ${verifyMethod}.`,
            ip_address: req?.ip,
            device_reference: req?.headers['user-agent'],
          },
        });

        return {
          transaction: createdTx,
          newBalance,
          accountMasked: account.account_number_masked,
        };
      } else if (transactionType === 'TRANSFER') {
        if (currentBalance < numAmount) {
          const err = new Error(
            `Insufficient funds. Your balance is ₹${currentBalance.toLocaleString('en-IN')}.`
          );
          err.status = 400;
          throw err;
        }

        // Deduct from sender
        const senderNewBalance = currentBalance - numAmount;
        await tx.bankAccount.update({
          where: { id: account.id },
          data: { balance: senderNewBalance },
        });

        const senderTx = await tx.transaction.create({
          data: {
            user_id: userId,
            account_id: account.id,
            transaction_type: 'TRANSFER',
            amount: numAmount,
            description: description || `Transfer to ${recipientName || 'recipient'}`,
            recipient_name: recipientName || null,
            recipient_account: recipientAccount || null,
            status: 'COMPLETED',
            reference_number: refNumber,
          },
        });

        // If recipient is another internal registered user, credit their primary account atomically
        if (recipientUserId) {
          const recipientPrimaryAccount = await tx.bankAccount.findFirst({
            where: { user_id: recipientUserId, is_primary: true, status: 'ACTIVE' },
          });

          if (recipientPrimaryAccount) {
            await tx.bankAccount.update({
              where: { id: recipientPrimaryAccount.id },
              data: { balance: Number(recipientPrimaryAccount.balance) + numAmount },
            });

            const senderUser = await tx.user.findUnique({
              where: { id: userId },
              select: { full_name: true },
            });

            await tx.transaction.create({
              data: {
                user_id: recipientUserId,
                account_id: recipientPrimaryAccount.id,
                transaction_type: 'DEPOSIT',
                amount: numAmount,
                description: `Received transfer from ${senderUser?.full_name || 'iCash user'}`,
                recipient_name: senderUser?.full_name || null,
                status: 'COMPLETED',
                reference_number: `TX_REC_${Date.now()}_${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
              },
            });
          }
        }

        await tx.securityEvent.create({
          data: {
            user_id: userId,
            event_type: 'TRANSFER_SUCCESS',
            severity: numAmount >= 20000 ? 'HIGH' : 'LOW',
            description: `Transfer of ₹${numAmount.toLocaleString('en-IN')} to ${recipientName || 'external'} authorized via ${verifyMethod}.`,
            ip_address: req?.ip,
            device_reference: req?.headers['user-agent'],
          },
        });

        return {
          transaction: senderTx,
          newBalance: senderNewBalance,
          accountMasked: account.account_number_masked,
        };
      } else if (transactionType === 'DEPOSIT') {
        const newBalance = currentBalance + numAmount;
        await tx.bankAccount.update({
          where: { id: account.id },
          data: { balance: newBalance },
        });

        const createdTx = await tx.transaction.create({
          data: {
            user_id: userId,
            account_id: account.id,
            transaction_type: 'DEPOSIT',
            amount: numAmount,
            description: description || 'Account top-up / deposit',
            status: 'COMPLETED',
            reference_number: refNumber,
          },
        });

        return {
          transaction: createdTx,
          newBalance,
          accountMasked: account.account_number_masked,
        };
      }

      throw new Error(`Unsupported transaction type: ${transactionType}`);
    });
  }

  /**
   * Senior citizen generates delegation OTP for trusted contact.
   */
  static async generateDelegationOtp(seniorUserId, amount, req) {
    const numAmount = Number(amount);
    if (!numAmount || numAmount <= 0) {
      const err = new Error('Enter a valid authorization amount.');
      err.status = 400;
      throw err;
    }

    const senior = await prisma.user.findUnique({
      where: { id: seniorUserId },
      include: {
        accounts: { where: { is_primary: true } },
      },
    });

    if (!senior || !senior.is_senior) {
      const err = new Error(
        'Delegated withdrawal is only available for registered senior citizens.'
      );
      err.status = 403;
      throw err;
    }

    const primaryAccount = senior.accounts[0];
    if (!primaryAccount || Number(primaryAccount.balance) < numAmount) {
      const err = new Error('Insufficient balance in your primary account.');
      err.status = 400;
      throw err;
    }

    const rawOtp = String(Math.floor(100000 + Math.random() * 900000));
    const otpHash = await hashValue(rawOtp);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    // Invalidate existing pending delegations
    await prisma.delegatedWithdrawal.updateMany({
      where: { user_id: seniorUserId, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });

    await prisma.delegatedWithdrawal.create({
      data: {
        user_id: seniorUserId,
        amount: numAmount,
        otp_hash: otpHash,
        status: 'PENDING',
        expires_at: expiresAt,
      },
    });

    await SecurityService.recordEvent({
      userId: seniorUserId,
      eventType: 'DELEGATION_OTP_GENERATED',
      severity: 'MEDIUM',
      description: `Senior citizen generated delegation OTP for ₹${numAmount} to trusted contact (${senior.emergency_contact_phone || 'registered contact'}).`,
      ipAddress: req?.ip,
      deviceReference: req?.headers['user-agent'],
    });

    return {
      otp: rawOtp,
      amount: numAmount,
      expiresAt,
      contactName: senior.emergency_contact_name,
      contactPhone: senior.emergency_contact_phone,
    };
  }

  /**
   * Trusted contact claims senior citizen's authorized funds using OTP.
   */
  static async claimDelegatedWithdrawal(seniorName, otp, req) {
    const senior = await prisma.user.findFirst({
      where: {
        full_name: { equals: seniorName.trim(), mode: 'insensitive' },
        is_senior: true,
        status: 'ACTIVE',
      },
      include: {
        accounts: { where: { is_primary: true, status: 'ACTIVE' } },
        delegations: {
          where: { status: 'PENDING' },
          orderBy: { created_at: 'desc' },
          take: 1,
        },
      },
    });

    if (!senior) {
      const err = new Error('No active senior citizen account found with that name.');
      err.status = 404;
      throw err;
    }

    const delegation = senior.delegations[0];
    if (!delegation) {
      const err = new Error(
        'No active authorization OTP found. Please ask the senior citizen to generate a new code.'
      );
      err.status = 400;
      throw err;
    }

    if (new Date() > delegation.expires_at) {
      await prisma.delegatedWithdrawal.update({
        where: { id: delegation.id },
        data: { status: 'EXPIRED' },
      });
      const err = new Error(
        'The OTP has expired (valid for 5 minutes). Please request a new code.'
      );
      err.status = 400;
      throw err;
    }

    const isMatch = await compareValue(otp, delegation.otp_hash);
    if (!isMatch) {
      const err = new Error('Incorrect OTP. Please check with the senior citizen.');
      err.status = 400;
      throw err;
    }

    const primaryAccount = senior.accounts[0];
    const amount = Number(delegation.amount);

    if (!primaryAccount || Number(primaryAccount.balance) < amount) {
      const err = new Error("Senior citizen's account balance is insufficient.");
      err.status = 400;
      throw err;
    }

    // Atomically release funds
    return await prisma.$transaction(async (tx) => {
      await tx.delegatedWithdrawal.update({
        where: { id: delegation.id },
        data: { status: 'USED' },
      });

      const newBalance = Number(primaryAccount.balance) - amount;
      await tx.bankAccount.update({
        where: { id: primaryAccount.id },
        data: { balance: newBalance },
      });

      const transaction = await tx.transaction.create({
        data: {
          user_id: senior.id,
          account_id: primaryAccount.id,
          transaction_type: 'WITHDRAWAL',
          amount,
          description: `Withdrawal by trusted emergency contact (OTP verified)`,
          status: 'COMPLETED',
          reference_number: `TX_DEL_${Date.now()}`,
        },
      });

      await tx.securityEvent.create({
        data: {
          user_id: senior.id,
          event_type: 'DELEGATED_WITHDRAWAL_SUCCESS',
          severity: 'MEDIUM',
          description: `₹${amount} released to trusted contact via OTP authorization.`,
          ip_address: req?.ip,
          device_reference: req?.headers['user-agent'],
        },
      });

      return {
        amount,
        seniorName: senior.full_name,
        referenceNumber: transaction.reference_number,
      };
    });
  }
}

module.exports = TransactionService;
