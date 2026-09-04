const SmartExpenseService = require('../src/services/smartExpenseService');

describe('smart expense categorization', () => {
  test('categorizes common merchant descriptions with high confidence', () => {
    expect(SmartExpenseService.categorize('Dinner at Zomato', 'PAYMENT')).toEqual({
      category: 'FOOD',
      confidence: 0.95,
    });
  });

  test('uses transaction type fallback when description has no match', () => {
    expect(SmartExpenseService.categorize('', 'WITHDRAWAL')).toEqual({
      category: 'CASH',
      confidence: 0.98,
    });
  });
});
