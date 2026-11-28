'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SENSITIVE_KEYS = [
  'password',
  'privateKey',
  'seed',
  'signature',
  'secret',
  'token',
  'apiKey',
];

function redact(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  const result = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEYS.includes(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redact(val, seen);
    }
  }
  return result;
}

describe('logger redaction', () => {
  let tmpDir;
  let logger;

  beforeEach(() => {
    jest.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
    process.env.LOG_DIR = tmpDir;
    logger = require('./logger');
  });

  afterEach(() => {
    if (logger && typeof logger.close === 'function') {
      logger.close();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.LOG_DIR;
  });

  it('redacts top-level sensitive fields', () => {
    const redacted = redact({ password: 'secret', username: 'alice' });
    expect(redacted.password).toBe('[REDACTED]');
    expect(redacted.username).toBe('alice');
  });

  it('redacts nested sensitive fields', () => {
    const redacted = redact({
      user: { password: 'secret', profile: { privateKey: 'abc', seed: 'xyz' } },
    });
    expect(redacted.user.password).toBe('[REDACTED]');
    expect(redacted.user.profile.privateKey).toBe('[REDACTED]');
    expect(redacted.user.profile.seed).toBe('[REDACTED]');
  });

  it('writes [REDACTED] to the log file for a password field', () => {
    logger.info('test', { password: 'secret' });

    const files = fs.readdirSync(tmpDir);
    expect(files.length).toBeGreaterThan(0);

    const contents = files
      .map((file) => fs.readFileSync(path.join(tmpDir, file), 'utf8'))
      .join('\n');

    expect(contents).toContain('[REDACTED]');
    expect(contents).not.toContain('secret');
  });
});
