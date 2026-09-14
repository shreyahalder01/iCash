/**
 * Centralized Controllers Registry
 */
const accountController = require('./accountController');
const adminController = require('./adminController');
const aiController = require('./aiController');
const analyticsController = require('./analyticsController');
const authController = require('./authController');
const biometricChallengeController = require('./biometricChallengeController');
const biometricController = require('./biometricController');
const complaintController = require('./complaintController');
const fraudController = require('./fraudController');
const merchantAnalyticsController = require('./merchantAnalyticsController');
const merchantController = require('./merchantController');
const notificationController = require('./notificationController');
const receiptController = require('./receiptController');
const savingsController = require('./savingsController');
const securityController = require('./securityController');
const splitController = require('./splitController');
const subscriptionController = require('./subscriptionController');
const transactionController = require('./transactionController');

module.exports = {
  accountController,
  adminController,
  aiController,
  analyticsController,
  authController,
  biometricChallengeController,
  biometricController,
  complaintController,
  fraudController,
  merchantAnalyticsController,
  merchantController,
  notificationController,
  receiptController,
  savingsController,
  securityController,
  splitController,
  subscriptionController,
  transactionController,
};
