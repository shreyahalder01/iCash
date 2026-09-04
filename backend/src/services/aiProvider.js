const fetch = require('node-fetch');

/**
 * Provider abstraction for grounded finance responses.
 * Configure OPENAI_API_KEY to enable the hosted model.
 */
class AIProvider {
  constructor({ apiKey = process.env.OPENAI_API_KEY, model = process.env.OPENAI_MODEL || 'gpt-4o-mini' } = {}) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async generate({ question, context }) {
    if (!this.apiKey) {
      return this.localResponse(question, context);
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'You are iCash Financial Copilot. Answer only from the supplied transaction context. If the context is insufficient, say so. Never invent transactions, balances, or advice. Be concise and use INR formatting.',
          },
          {
            role: 'user',
            content: `Transaction context:\n${context}\n\nQuestion: ${question}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      const error = new Error(`AI provider request failed with status ${response.status}.`);
      error.status = 502;
      error.providerDetail = detail.slice(0, 500);
      throw error;
    }

    const payload = await response.json();
    const answer = payload.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      const error = new Error('AI provider returned an empty response.');
      error.status = 502;
      throw error;
    }
    return answer;
  }

  localResponse(question, context) {
    const lines = context.split('\n').filter(Boolean);
    if (!lines.length) {
      return 'I could not find any transactions to analyze yet.';
    }
    const total = lines.reduce((sum, line) => {
      const match = line.match(/amount=₹([0-9,.]+)/);
      return sum + (match ? Number(match[1].replace(/,/g, '')) : 0);
    }, 0);
    return `I found ${lines.length} recent transactions related to your question. Their recorded total is ₹${total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}. Add an OPENAI_API_KEY for conversational AI analysis.`;
  }
}

module.exports = AIProvider;
