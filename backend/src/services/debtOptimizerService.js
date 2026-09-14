const { optimizeDebts } = require('./splitService');

/**
 * Produces a minimal settlement plan from signed user balances.
 * Positive balances are creditors and negative balances are debtors.
 */
class DebtOptimizer {
  optimize(balances) {
    return optimizeDebts(balances);
  }
}

module.exports = DebtOptimizer;
module.exports.optimizeDebts = optimizeDebts;
