const prisma = require('../prisma');

class FraudService {
  static async analyze(userId, transactionId) {
    const transaction = await prisma.transaction.findFirst({
      where: { id: transactionId, user_id: userId },
      include: { fraud_analysis: true },
    });
    if (!transaction) {
      const error = new Error('Transaction not found or access denied.');
      error.status = 404;
      throw error;
    }

    const amount = Number(transaction.amount);
    const indicators = [];
    let score = 0;
    if (amount >= 50000) { score += 0.45; indicators.push('HIGH_VALUE'); }
    else if (amount >= 20000) { score += 0.25; indicators.push('ELEVATED_VALUE'); }
    const recent = await prisma.transaction.count({
      where: { user_id: userId, created_at: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
    });
    if (recent >= 5) { score += 0.3; indicators.push('HIGH_FREQUENCY'); }
    if (transaction.transaction_type === 'TRANSFER' && !transaction.recipient_name) {
      score += 0.15; indicators.push('UNKNOWN_RECIPIENT');
    }
    score = Math.min(1, score);
    const riskLevel = score >= 0.75 ? 'CRITICAL' : score >= 0.5 ? 'HIGH' : score >= 0.25 ? 'MEDIUM' : 'LOW';
    const analysis = await prisma.fraudAnalysis.upsert({
      where: { transaction_id: transactionId },
      create: { transaction_id: transactionId, risk_score: score, risk_level: riskLevel, indicators },
      update: { risk_score: score, risk_level: riskLevel, indicators },
    });
    return { ...analysis, riskScore: Number(analysis.risk_score), riskLevel: analysis.risk_level, indicators: analysis.indicators || [] };
  }

  static async getAnalysis(userId, transactionId) {
    const transaction = await prisma.transaction.findFirst({ where: { id: transactionId, user_id: userId }, include: { fraud_analysis: true } });
    if (!transaction) { const error = new Error('Transaction not found or access denied.'); error.status = 404; throw error; }
    return transaction.fraud_analysis ? { ...transaction.fraud_analysis, riskScore: Number(transaction.fraud_analysis.risk_score), riskLevel: transaction.fraud_analysis.risk_level } : null;
  }
}

module.exports = FraudService;
