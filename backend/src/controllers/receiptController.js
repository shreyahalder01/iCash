const { scanReceipt } = require('../services/receiptService');

async function scan(req, res, next) {
  try {
    if (!req.file) {
      const error = new Error('A receipt image is required.');
      error.status = 400;
      throw error;
    }
    res.status(201).json({ ok: true, receipt: await scanReceipt(req.user.id, req.file) });
  } catch (err) {
    next(err);
  }
}

module.exports = { scan };
