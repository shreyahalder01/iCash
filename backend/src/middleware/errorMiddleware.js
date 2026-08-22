/**
 * Centralized Error Handling Middleware
 * Ensures technical details (PrismaClientKnownRequestError, ECONNREFUSED, SQL queries, stack traces)
 * are NEVER returned to the end-user.
 */
function errorHandler(err, req, res, next) {
  if (process.env.NODE_ENV !== 'test') {
    console.error('Unhandled Error caught by middleware:', {
      message: err.message,
      name: err.name,
      code: err.code,
      status: err.status || err.statusCode
    });
  }

  // Handle explicit HTTP status codes attached to errors
  if (err.status || err.statusCode) {
    const status = err.status || err.statusCode;
    return res.status(status).json({
      ok: false,
      error: err.name || 'RequestError',
      message: err.message || 'An error occurred while processing your request.'
    });
  }

  if (err.name === 'UnauthorizedError' || err.status === 401) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized',
      message: err.message || 'Your secure session has expired. Please authenticate again.'
    });
  }

  if (err.name === 'ForbiddenError' || err.status === 403) {
    return res.status(403).json({
      ok: false,
      error: 'Forbidden',
      message: err.message || 'You do not have permission to perform this action.'
    });
  }

  if (err.code === 'P2002') {
    // Unique constraint failed in Prisma
    return res.status(409).json({
      ok: false,
      error: 'Conflict',
      message: 'A record with this phone number, email, or Aadhaar identity already exists.'
    });
  }

  if (err.code === 'P2025') {
    // Record not found in Prisma
    return res.status(404).json({
      ok: false,
      error: 'NotFound',
      message: 'The requested resource was not found.'
    });
  }

  // Generic internal server error response
  return res.status(500).json({
    ok: false,
    error: 'ServerError',
    message: "We're unable to connect to banking services right now. Please try again."
  });
}

/**
 * 404 Not Found Middleware for unmatched routes
 */
function notFoundHandler(req, res) {
  return res.status(404).json({
    ok: false,
    error: 'NotFound',
    message: `Endpoint ${req.method} ${req.originalUrl} not found.`
  });
}

module.exports = {
  errorHandler,
  notFoundHandler
};
