const prisma = require('../prisma');

const OUTFLOWS = new Set(['WITHDRAWAL', 'PAYMENT', 'TRANSFER']);

async function getForecast(userId, { days = 30, lookback = 90 } = {}) {
  const horizon = Math.min(Math.max(Number(days) || 30, 1), 365);
  const historyDays = Math.min(Math.max(Number(lookback) || 90, 30), 730);
  const since = new Date(Date.now() - historyDays * 86400000);
  const [transactions, accounts] = await Promise.all([
    prisma.transaction.findMany({
      where: { user_id: userId, status: 'COMPLETED', created_at: { gte: since } },
      orderBy: { created_at: 'asc' },
      select: { transaction_type: true, amount: true, created_at: true },
    }),
    prisma.bankAccount.findMany({
      where: { user_id: userId, status: 'ACTIVE' },
      select: { balance: true },
    }),
  ]);
  let inflows = 0;
  let outflows = 0;
  for (const tx of transactions) {
    const amount = Math.abs(Number(tx.amount));
    if (OUTFLOWS.has(tx.transaction_type)) outflows += amount;
    else inflows += amount;
  }
  const weeks = Math.max(historyDays / 7, 1);
  const weeklyInflow = inflows / weeks;
  const weeklyOutflow = outflows / weeks;
  const currentBalance = accounts.reduce((sum, account) => sum + Number(account.balance), 0);
  const netWeekly = weeklyInflow - weeklyOutflow;
  const projectedNet = netWeekly * (horizon / 7);
  const dailyChange = projectedNet / horizon;
  const dailyForecast = Array.from({ length: horizon }, (_, index) => ({
    date: new Date(Date.now() + (index + 1) * 86400000).toISOString().slice(0, 10),
    predictedBalance: Number((currentBalance + dailyChange * (index + 1)).toFixed(2)),
  }));
  return {
    horizonDays: horizon,
    lookbackDays: historyDays,
    currentBalance: Number(currentBalance.toFixed(2)),
    projectedBalance: Number((currentBalance + projectedNet).toFixed(2)),
    predictedBalance: Number((currentBalance + projectedNet).toFixed(2)),
    confidence: transactions.length >= 10 ? 0.75 : transactions.length ? 0.45 : 0.2,
    dailyForecast,
    projectedNetCashFlow: Number(projectedNet.toFixed(2)),
    averageWeeklyInflow: Number(weeklyInflow.toFixed(2)),
    averageWeeklyOutflow: Number(weeklyOutflow.toFixed(2)),
    trend: netWeekly > 0.005 ? 'POSITIVE' : netWeekly < -0.005 ? 'NEGATIVE' : 'STABLE',
    dataPoints: transactions.length,
  };
}

module.exports = { getForecast };
