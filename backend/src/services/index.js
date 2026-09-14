/**
 * Centralized Services Registry
 */
const accountService = require('./accountService');
const aiCopilotService = require('./aiCopilotService');
const aiProvider = require('./aiProvider');
const authService = require('./authService');
const biometricService = require('./biometricService');
const debtOptimizerService = require('./debtOptimizerService');
const forecastService = require('./forecastService');
const fraudService = require('./fraudService');
const healthScoreService = require('./healthScoreService');
const notificationService = require('./notificationService');
const otpService = require('./otpService');
const receiptService = require('./receiptService');
const savingsService = require('./savingsService');
const securityService = require('./securityService');
const smartExpenseService = require('./smartExpenseService');
const smsProvider = require('./smsProvider');
const splitService = require('./splitService');
const subscriptionService = require('./subscriptionService');
const transactionService = require('./transactionService');
const emailService = require('./emailService');
const emailTemplate = require('./emailTemplate');

module.exports = {
  accountService,
  aiCopilotService,
  aiProvider,
  authService,
  biometricService,
  debtOptimizerService,
  forecastService,
  fraudService,
  healthScoreService,
  notificationService,
  otpService,
  receiptService,
  savingsService,
  securityService,
  smartExpenseService,
  smsProvider,
  splitService,
  subscriptionService,
  transactionService,
  emailService,
  emailTemplate,
};
