'use strict';

/**
 * Webhook signing-secret encryption at rest (AES-256-GCM).
 *
 * Webhook secrets are HMAC keys: anyone who learns one can forge valid
 * signatures for a merchant's endpoint. They are therefore encrypted before
 * being written to the `Webhook.secret` column and decrypted only when a
 * delivery is signed.
 *
 * The 32-byte key is read from the `WEBHOOK_SECRET_KEY` environment variable
 * as 64 hex characters. When the variable is not configured the helpers
 * degrade to a pass-through so local development and existing deployments keep
 * working; production deployments must set it.
 *
 * Ciphertext format: `v1.<iv base64>.<authTag base64>.<ciphertext base64>`.
 * Values that do not start with `v1.` are treated as legacy plain-text secrets
 * and returned unchanged, which makes the migration to encrypted storage
 * incremental and non-breaking.
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_ENV = 'WEBHOOK_SECRET_KEY';
const VERSION = 'v1';
const IV_BYTES = 12;
const PREFIX = `${VERSION}.`;

const getKey = () => {
  const hex = process.env[KEY_ENV];
  if (!hex) {
    throw new Error(`${KEY_ENV} is not configured`);
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error(`${KEY_ENV} must be 32 bytes (64 hex characters)`);
  }
  return key;
};

const isConfigured = () => Boolean(process.env[KEY_ENV]);

const isEncrypted = (value) =>
  typeof value === 'string' && value.startsWith(PREFIX);

/**
 * Encrypt a plain-text secret. Returns the input unchanged when no key is
 * configured (pass-through for local/dev) or when the value is already
 * ciphertext.
 *
 * @param {string|null|undefined} plaintext
 * @returns {string|null|undefined}
 */
const encryptSecret = (plaintext) => {
  if (plaintext === null || plaintext === undefined) return plaintext;
  if (!isConfigured()) return plaintext;
  if (isEncrypted(plaintext)) return plaintext;

  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('base64')}.${authTag.toString('base64')}.${ciphertext.toString('base64')}`;
};

/**
 * Decrypt a stored secret. Legacy plain-text values (no `v1.` prefix) and a
 * missing key configuration pass through unchanged.
 *
 * @param {string|null|undefined} stored
 * @returns {string|null|undefined}
 */
const decryptSecret = (stored) => {
  if (stored === null || stored === undefined) return stored;
  if (!isEncrypted(stored)) return stored;
  if (!isConfigured()) {
    throw new Error(`${KEY_ENV} is required to decrypt webhook secrets`);
  }

  const [version, ivB64, tagB64, dataB64] = String(stored).split('.');
  if (version !== VERSION) {
    throw new Error(`Unsupported webhook secret format: ${version}`);
  }

  const key = getKey();
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
};

module.exports = {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  isConfigured,
  KEY_ENV,
};