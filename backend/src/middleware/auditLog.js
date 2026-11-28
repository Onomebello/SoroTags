const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

/**
 * Keys whose values must never be written to logs in plain text.
 * Shared with the Winston logger (src/logger.js) so redaction stays
 * consistent across audit logging and application logging.
 */
const SENSITIVE_KEYS = [
  'password',
  'privateKey',
  'seed',
  'signature',
];

/**
 * Recursively replaces the values of sensitive keys with `[REDACTED]`.
 * Returns a new object; the input is not mutated.
 */
function redact(value) {
  if (Array.isArray(value)) {
    return value.map(redact);
  }

  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = SENSITIVE_KEYS.includes(key) ? '[REDACTED]' : redact(val);
    }
    return result;
  }

  return value;
}

/**
 * Middleware that records admin actions in the AuditLog table.
 *
 * The insert is fire-and-forget: it is scheduled with setImmediate so it
 * runs after the response lifecycle, and any failure is logged without
 * being propagated to the response.
 */
function auditLog(action) {
  return (req, res, next) => {
    const entry = {
      action,
      userId: req.user ? req.user.id : null,
      method: req.method,
      path: req.originalUrl,
      ip: req.ip,
      createdAt: new Date(),
    };

    setImmediate(() => {
      prisma.auditLog
        .create({ data: entry })
        .catch((err) => {
          // console.error is the single allowed exception to the backend
          // `no-console` rule (see eslint.config.mjs) for top-level catch blocks.
          console.error('Failed to write audit log entry:', err);
        });
    });

    next();
  };
}

module.exports = auditLog;
module.exports.SENSITIVE_KEYS = SENSITIVE_KEYS;
module.exports.redact = redact;
