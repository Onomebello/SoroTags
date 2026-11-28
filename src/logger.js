const winston = require('winston');
const path = require('path');

const SENSITIVE_KEYS = [
  'password',
  'privateKey',
  'seed',
  'signature',
  'secret',
  'token',
  'mnemonic',
  'apiKey',
];

const REDACTED = '[REDACTED]';

function redactValue(value, seen) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }

  const result = {};
  for (const key of Object.keys(value)) {
    if (SENSITIVE_KEYS.includes(key)) {
      result[key] = REDACTED;
    } else {
      result[key] = redactValue(value[key], seen);
    }
  }
  return result;
}

function redact(info) {
  const seen = new WeakSet();
  const redacted = {};
  for (const key of Object.keys(info)) {
    if (SENSITIVE_KEYS.includes(key)) {
      redacted[key] = REDACTED;
    } else {
      redacted[key] = redactValue(info[key], seen);
    }
  }
  return redacted;
}

const redactFormat = winston.format((info) => redact(info));

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    redactFormat(),
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({
      filename: path.join('logs', 'application-error.log'),
      level: 'error',
    }),
    new winston.transports.File({
      filename: path.join('logs', 'application.log'),
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        redactFormat(),
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

logger.redact = redact;
logger.SENSITIVE_KEYS = SENSITIVE_KEYS;

module.exports = logger;
