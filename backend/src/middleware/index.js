/**
 * Centralized Middleware Exports
 */
const auth = require('./authMiddleware');
const error = require('./errorMiddleware');
const rateLimit = require('./rateLimitMiddleware');
const role = require('./roleMiddleware');
const validate = require('./validateMiddleware');

module.exports = {
  ...auth,
  ...error,
  ...rateLimit,
  ...role,
  ...validate,
  authMiddleware: auth,
  errorMiddleware: error,
  rateLimitMiddleware: rateLimit,
  roleMiddleware: role,
  validateMiddleware: validate,
};
