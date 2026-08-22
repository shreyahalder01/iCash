/**
 * Middleware factory for validating incoming request payloads against Zod schemas.
 * @param {import('zod').ZodSchema} schema
 */
function validateRequest(schema) {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req.body);
      req.body = parsed;
      next();
    } catch (err) {
      if (err.errors) {
        return res.status(400).json({
          ok: false,
          error: 'ValidationError',
          message: err.errors[0]?.message || 'Invalid input data provided.',
          details: err.errors.map(e => ({
            field: e.path.join('.'),
            message: e.message
          }))
        });
      }
      return res.status(400).json({
        ok: false,
        error: 'ValidationError',
        message: 'Invalid request data provided.'
      });
    }
  };
}

module.exports = {
  validateRequest
};
