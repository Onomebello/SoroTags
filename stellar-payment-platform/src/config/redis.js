const IORedis = require('ioredis');

const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';

/**
 * Creates a BullMQ-compatible IORedis connection.
 *
 * Returns null when REDIS_URL is unset so callers can distinguish
 * "Redis not configured" from "Redis configured but unreachable".
 * The health endpoint maps null → "not configured" rather than probing
 * a default localhost address that was never intentionally configured.
 *
 * @returns {import('ioredis').Redis | null}
 */
const createRedisConnection = () => {
  if (!process.env.REDIS_URL) return null;

  return new IORedis(process.env.REDIS_URL, {
    // BullMQ workers require blocking Redis commands to wait indefinitely.
    maxRetriesPerRequest: null,
  });
};

module.exports = {
  createRedisConnection,
  DEFAULT_REDIS_URL,
};
