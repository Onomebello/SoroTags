const logger = require('../utils/logger');

/**
 * Central error handler middleware.
 * Logs every error with its correlation ID, using `warn` for 4xx and
 * `error` (with stack) for 5xx, then sends a consistent JSON response.
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const statusCode = err.statusCode || err.status || 500;
  const code = err.code || (statusCode >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR');
  const correlationId = req.correlationId || req.id || err.correlationId;

  const meta = { correlationId, statusCode, code };

  if (statusCode >= 500) {
    logger.error(err.message || 'Internal server error', { ...meta, stack: err.stack });
  } else {
    logger.warn(err.message || 'Request error', meta);
  }

  const body = {
    error: {
      message: statusCode >= 500 ? 'Internal server error' : err.message,
      code,
      correlation_id: correlationId,
    },
  };

  if (statusCode >= 500) {
    body.error.reference_id = correlationId;
  }

  res.status(statusCode).json(body);
}

module.exports = errorHandler;
