const prisma = require('../prisma');
const AIProvider = require('./aiProvider');

function formatTransaction(transaction) {
  return [
    `date=${transaction.created_at.toISOString().slice(0, 10)}`,
    `amount=₹${Number(transaction.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
    `type=${transaction.transaction_type}`,
    `description=${transaction.description}`,
    `status=${transaction.status}`,
  ].join(' ');
}

class AICopilotService {
  constructor({ provider = new AIProvider() } = {}) {
    this.provider = provider;
  }

  async chat(userId, message) {
    const transactions = await prisma.transaction.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      take: 100,
      select: {
        amount: true,
        transaction_type: true,
        description: true,
        status: true,
        created_at: true,
      },
    });

    const context = transactions.map(formatTransaction).join('\n');
    const userMessage = await prisma.aIConversation.create({
      data: { user_id: userId, role: 'USER', message },
    });
    const answer = await this.provider.generate({ question: message, context });
    await prisma.aIConversation.create({
      data: { user_id: userId, role: 'ASSISTANT', message: answer },
    });

    return {
      conversationId: userMessage.id,
      answer,
      groundedTransactions: transactions.length,
    };
  }

  async history(userId, { limit = 50, offset = 0 } = {}) {
    const conversations = await prisma.aIConversation.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'asc' },
      take: Math.min(Math.max(Number(limit) || 50, 1), 100),
      skip: Math.max(Number(offset) || 0, 0),
    });
    return conversations.map((entry) => ({
      id: entry.id,
      role: entry.role,
      message: entry.message,
      timestamp: entry.created_at,
    }));
  }
}

module.exports = AICopilotService;
