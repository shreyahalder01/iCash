/**
 * Role-based authorization middleware.
 * Ensures the authenticated user has one of the specified roles.
 * @param  {...string} allowedRoles
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        ok: false,
        error: 'Unauthorized',
        message: 'Your secure session has expired. Please authenticate again.'
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        ok: false,
        error: 'Forbidden',
        message: 'You do not have authorization to access this banking resource.'
      });
    }

    next();
  };
}

module.exports = {
  requireRole
};
