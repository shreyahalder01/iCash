const AccountService = require('../services/accountService');

class AccountController {
  static async getAccounts(req, res, next) {
    try {
      const accounts = await AccountService.getUserAccounts(req.user.id);
      res.json({
        ok: true,
        accounts,
      });
    } catch (err) {
      next(err);
    }
  }

  static async createAccount(req, res, next) {
    try {
      const account = await AccountService.createAccount(req.user.id, req.body);
      res.status(201).json({
        ok: true,
        message: 'Account linked successfully.',
        account,
      });
    } catch (err) {
      next(err);
    }
  }

  static async updateAccount(req, res, next) {
    try {
      const account = await AccountService.updateAccount(req.user.id, req.params.id, req.body);
      res.json({
        ok: true,
        message: 'Account updated successfully.',
        account,
      });
    } catch (err) {
      next(err);
    }
  }

  static async deleteAccount(req, res, next) {
    try {
      await AccountService.deleteAccount(req.user.id, req.params.id);
      res.json({
        ok: true,
        message: 'Account closed successfully.',
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = AccountController;
