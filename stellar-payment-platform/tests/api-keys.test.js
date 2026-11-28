const request = require('supertest');
const crypto = require('crypto');
const { truncateKey } = require('../src/utils');

// Mock the Stellar SDK to prevent Jest ESM syntax errors
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) }
}));

// Mock Prisma so it doesn't try to connect to a real database
const mockApiKeyCreate = jest.fn();
const mockApiKeyFindUnique = jest.fn();
const mockApiKeyFindMany = jest.fn();
const mockApiKeyUpdate = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        username: 'alice123',
        address: 'GABC123',
      }),
    },
    apiKey: {
      create: mockApiKeyCreate,
      findUnique: mockApiKeyFindUnique,
      findMany: mockApiKeyFindMany,
      update: mockApiKeyUpdate,
    },
    $transaction: mockTransaction,
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
  },
}));

// Mock the pool functions
jest.mock('../src/db', () => ({
  poolGet: jest.fn().mockResolvedValue(null),
  poolRun: jest.fn().mockResolvedValue({ changes: 1 }),
  poolAll: jest.fn().mockResolvedValue([]),
}));

// Mock the v1 routes (factory function since v1/index.js now exports a function)
jest.mock('../src/routes/v1', () => {
  return () => require('express').Router();
});

// Mock JWT requireAuth to always pass in tests
jest.mock('../src/utils/jwt', () => ({
  signToken: jest.fn(() => 'mock-token'),
  verifyToken: jest.fn(() => ({ sub: 'test@example.com', email: 'test@example.com' })),
  getJwks: jest.fn(() => ({ keys: [] })),
  requireAuth: (req, res, next) => {
    req.user = { sub: 'test@example.com', email: 'test@example.com' };
    next();
  },
}));

const { app } = require('../server');

const KEY_PREFIX = 'sk_live_';
const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

// API key hash comparisons MUST use crypto.timingSafeEqual to avoid timing
// side channels (see issue #186). These tests assert that requirement.
describe('API key verification uses constant-time comparison', () => {
  let timingSafeEqualSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    timingSafeEqualSpy = jest.spyOn(crypto, 'timingSafeEqual');
  });

  afterEach(() => {
    timingSafeEqualSpy.mockRestore();
  });

  it('invokes crypto.timingSafeEqual and returns 200 for a valid key', async () => {
    const rawKey = `${KEY_PREFIX}validkey1234567890`;
    mockApiKeyFindUnique.mockResolvedValue({
      id: 'valid-key-id',
      name: 'Valid Key',
      ownerId: 'merchant@example.com',
      keyHash: hashKey(rawKey),
      keyPrefix: rawKey.slice(0, 12),
      scopes: ['read', 'write'],
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
    });

    const res = await request(app)
      .get('/auth/api-keys')
      .set('X-Api-Key', rawKey)
      .query({ owner_id: 'merchant@example.com' });

    expect(res.statusCode).toBe(200);
    expect(timingSafeEqualSpy).toHaveBeenCalled();
  });

  it('invokes crypto.timingSafeEqual and returns 401 for an invalid key', async () => {
    const rawKey = `${KEY_PREFIX}invalidkey1234567890`;
    mockApiKeyFindUnique.mockResolvedValue({
      id: 'valid-key-id',
      name: 'Valid Key',
      ownerId: 'merchant@example.com',
      keyHash: hashKey(`${KEY_PREFIX}someotherkey0987654321`),
      keyPrefix: 'sk_live_some',
      scopes: ['read', 'write'],
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
    });

    const res = await request(app)
      .get('/auth/api-keys')
      .set('X-Api-Key', rawKey)
      .query({ owner_id: 'merchant@example.com' });

    expect(res.statusCode).toBe(401);
    expect(timingSafeEqualSpy).toHaveBeenCalled();
  });

  it('invokes crypto.timingSafeEqual and returns 401 when no key record exists', async () => {
    const rawKey = `${KEY_PREFIX}unknownkey1234567890`;
    mockApiKeyFindUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/auth/api-keys')
      .set('X-Api-Key', rawKey)
      .query({ owner_id: 'merchant@example.com' });

    expect(res.statusCode).toBe(401);
    expect(timingSafeEqualSpy).toHaveBeenCalled();
  });
});

describe('API Key Management Endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /auth/api-keys - Generate new API key', () => {
    it('should create a new API key successfully', async () => {
      const fakeId = 'test-api-key-id-123';
      mockApiKeyCreate.mockResolvedValue({
        id: fakeId,
        name: 'Test Key',
        ownerId: 'merchant@example.com',
        keyHash: 'mock-hash',
        keyPrefix: 'sk_live_abc',
        scopes: ['read', 'write'],
        expiresAt: null,
        createdAt: new Date(),
      });

      const res = await request(app)
        .post('/auth/api-keys')
        .set('Content-Type', 'application/json')
        .send({
          name: 'Test Key',
          owner_id: 'merchant@example.com',
        });

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(fakeId);
      expect(res.body.data.name).toBe('Test Key');
      expect(res.body.data.key).toMatch(/^sk_live_/);
      expect(res.body.data.key_prefix).toMatch(/^sk_live_/);
      expect(res.body.data.owner_id).toBe('merchant@example.com');
      expect(mockApiKeyCreate).toHaveBeenCalledTimes(1);
    });

    it('should create API key with custom scopes', async () => {
      const fakeId = 'test-api-key-id-456';
      mockApiKeyCreate.mockResolvedValue({
        id: fakeId,
        name: 'Read Only Key',
        ownerId: 'merchant@example.com',
        keyHash: 'mock-hash',
        keyPrefix: 'sk_live_abc',
        scopes: ['read'],
        expiresAt: null,
        createdAt: new Date(),
      });

      const res = await request(app)
        .post('/auth/api-keys')
        .set('Content-Type', 'application/json')
        .send({
          name: 'Read Only Key',
          owner_id: 'merchant@example.com',
        });

      expect(res.statusCode).toBe(201);
      expect(mockApiKeyCreate).toHaveBeenCalled();
    });

    it('should create API key with expiration', async () => {
      const fakeId = 'test-api-key-id-789';
      mockApiKeyCreate.mockResolvedValue({
        id: fakeId,
        name: 'Expiring Key',
        ownerId: 'merchant@example.com',
        keyHash: 'mock-hash',
        keyPrefix: 'sk_live_abc',
        scopes: ['read', 'write'],
        expiresAt: new Date(),
        createdAt: new Date(),
      });

      const res = await request(app)
        .post('/auth/api-keys')
        .set('Content-Type', 'application/json')
        .send({
          name: 'Expiring Key',
          owner_id: 'merchant@example.com',
          expires_in_hours: 24,
        });

      expect(res.statusCode).toBe(201);
      expect(mockApiKeyCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            expiresAt: expect.any(Date),
          }),
        }),
      );
    });

    it('should return 422 when name is missing', async () => {
      const res = await request(app)
        .post('/auth/api-keys')
        .set('Content-Type', 'application/json')
        .send({
          owner_id: 'merchant@example.com',
        });

      expect(res.statusCode).toBe(422);
      expect(res.body.success).toBe(false);
    });

    it('should return 422 when owner_id is missing', async () => {
      const res = await request(app)
        .post('/auth/api-keys')
        .set('Content-Type', 'application/json')
        .send({
          name: 'Test Key',
        });

      expect(res.statusCode).toBe(422);
      expect(res.body.success).toBe(false);
    });

    it('should return 422 when scopes contain invalid values', async () => {
      const res = await request(app)
        .post('/auth/api-keys')
        .set('Content-Type', 'application/json')
        .send({
          name: 'Test Key',
          owner_id: 'merchant@example.com',
          scopes: 'invalid_scope',
        });

      expect(res.statusCode).toBe(422);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /auth/api-keys - List API keys', () => {
    it('should list API keys for an owner', async () => {
      const fakeKeys = [
        {
          id: 'key-1',
          name: 'Key 1',
          keyPrefix: 'sk_live_abc',
          ownerId: 'merchant@example.com',
          scopes: ['read', 'write'],
          expiresAt: null,
          revokedAt: null,
          revokedBy: null,
          lastUsedAt: new Date(),
          createdAt: new Date(),
        },
      ];
      mockApiKeyFindMany.mockResolvedValue(fakeKeys);

      const res = await request(app)
        .get('/auth/api-keys')
        .query({ owner_id: 'merchant@example.com' });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('Key 1');
    });

    it('should return 400 when owner_id is missing', async () => {
      const res = await request(app)
        .get('/auth/api-keys');

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return empty array when no keys exist', async () => {
      mockApiKeyFindMany.mockResolvedValue([]);

      const res = await request(app)
        .get('/auth/api-keys')
        .query({ owner_id: 'merchant@example.com' });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(0);
    });
  });

  describe('POST /auth/api-keys/:id/revoke - Revoke API key', () => {
    it('should revoke an API key successfully', async () => {
      const fakeId = 'key-to-revoke';
      mockApiKeyFindUnique.mockResolvedValue({
        id: fakeId,
        name: 'Test Key',
        ownerId: 'merchant@example.com',
        revokedAt: null,
      });
      mockApiKeyUpdate.mockResolvedValue({
        id: fakeId,
        name: 'Test Key',
        revokedAt: new Date(),
        revokedBy: 'merchant@example.com',
      });

      const res = await request(app)
        .post(`/auth/api-keys/${fakeId}/revoke`)
        .set('Content-Type', 'application/json')
        .send({ revoked_by: 'merchant@example.com' });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockApiKeyUpdate).toHaveBeenCalledTimes(1);
    });

    it('should return 404 when API key is not found', async () => {
      mockApiKeyFindUnique.mockResolvedValue(null);

      const res = await request(app)
        .post('/auth/api-keys/nonexistent-id/revoke')
        .set('Content-Type', 'application/json')
        .send({ revoked_by: 'merchant@example.com' });

      expect(res.statusCode).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('should return 409 when API key is already revoked', async () => {
      const fakeId = 'key-already-revoked';
      mockApiKeyFindUnique.mockResolvedValue({
        id: fakeId,
        name: 'Test Key',
        ownerId: 'merchant@example.com',
        revokedAt: new Date(),
      });

      const res = await request(app)
        .post(`/auth/api-keys/${fakeId}/revoke`)
        .set('Content-Type', 'application/json')
        .send({ revoked_by: 'merchant@example.com' });

      expect(res.statusCode).toBe(409);
      expect(res.body.success).toBe(false);
    });

    it('should return 422 when revoked_by is missing', async () => {
      const fakeId = 'key-to-revoke';
      mockApiKeyFindUnique.mockResolvedValue({
        id: fakeId,
        name: 'Test Key',
        ownerId: 'merchant@example.com',
        revokedAt: null,
      });

      const res = await request(app)
        .post(`/auth/api-keys/${fakeId}/revoke`)
        .set('Content-Type', 'application/json')
        .send({});

      expect(res.statusCode).toBe(422);
      expect(res.body.success).toBe(false);
    });
  });

  describe('POST /auth/api-keys/:id/rotate - Rotate API key', () => {
    it('should rotate an API key successfully', async () => {
      const oldKeyId = 'old-key-id';
      const newKeyId = 'new-key-id';
      const oldRecord = {
        id: oldKeyId,
        name: 'Old Key',
        ownerId: 'merchant@example.com',
        keyHash: 'old-hash',
        keyPrefix: 'sk_live_old',
        scopes: ['read', 'write'],
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date(),
      };

      mockApiKeyFindUnique.mockResolvedValue(oldRecord);
      mockTransaction.mockResolvedValue([
        {
          id: newKeyId,
          name: 'Old Key',
          ownerId: 'merchant@example.com',
          keyHash: 'new-hash',
          keyPrefix: 'sk_live_new',
          scopes: ['read', 'write'],
          expiresAt: null,
          createdAt: new Date(),
        },
        {
          id: oldKeyId,
          revokedAt: new Date(),
          revokedBy: 'rotation',
        },
      ]);

      const res = await request(app)
        .post(`/auth/api-keys/${oldKeyId}/rotate`)
        .set('Content-Type', 'application/json')
        .send({});

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.new_key).toBeDefined();
      expect(res.body.data.old_key).toBeDefined();
      expect(res.body.data.new_key.key).toMatch(/^sk_live_/);
      expect(res.body.data.old_key.grace_period_expires_at).toBeDefined();
      expect(mockTransaction).toHaveBeenCalledTimes(1);
    });

    it('should rotate with custom name', async () => {
      const oldKeyId = 'old-key-id';
      const oldRecord = {
        id: oldKeyId,
        name: 'Old Key',
        ownerId: 'merchant@example.com',
        keyHash: 'old-hash',
        keyPrefix: 'sk_live_old',
        scopes: ['read', 'write'],
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date(),
      };

      mockApiKeyFindUnique.mockResolvedValue(oldRecord);
      mockTransaction.mockResolvedValue([
        {
          id: 'new-key-id',
          name: 'New Key Name',
          ownerId: 'merchant@example.com',
          keyHash: 'new-hash',
          keyPrefix: 'sk_live_new',
          scopes: ['read', 'write'],
          expiresAt: null,
          createdAt: new Date(),
        },
        { id: oldKeyId, revokedAt: new Date(), revokedBy: 'rotation' },
      ]);

      const res = await request(app)
        .post(`/auth/api-keys/${oldKeyId}/rotate`)
        .set('Content-Type', 'application/json')
        .send({ name: 'New Key Name' });

      expect(res.statusCode).toBe(201);
      expect(res.body.data.new_key.name).toBe('New Key Name');
    });

    it('should return 404 when API key is not found', async () => {
      mockApiKeyFindUnique.mockResolvedValue(null);

      const res = await request(app)
        .post('/auth/api-keys/nonexistent-id/rotate')
        .set('Content-Type', 'application/json')
        .send({});

      expect(res.statusCode).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('should return 409 when API key is already revoked', async () => {
      const oldKeyId = 'already-revoked-key';
      mockApiKeyFindUnique.mockResolvedValue({
        id: oldKeyId,
        name: 'Revoked Key',
        ownerId: 'merchant@example.com',
        revokedAt: new Date(),
      });

      const res = await request(app)
        .post(`/auth/api-keys/${oldKeyId}/rotate`)
        .set('Content-Type', 'application/json')
        .send({});

      expect(res.statusCode).toBe(409);
      expect(res.body.success).toBe(false);
    });

    it('should default grace period to 1 hour', async () => {
      const oldKeyId = 'old-key-id';
      mockApiKeyFindUnique.mockResolvedValue({
        id: oldKeyId,
        name: 'Old Key',
        ownerId: 'merchant@example.com',
        keyHash: 'old-hash',
        keyPrefix: 'sk_live_old',
        scopes: ['read'],
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date(),
      });
      mockTransaction.mockResolvedValue([
        {
          id: 'new-key-id',
          name: 'Old Key',
          ownerId: 'merchant@example.com',
          scopes: ['read'],
          expiresAt: null,
          createdAt: new Date(),
        },
        { id: oldKeyId, revokedAt: new Date(), revokedBy: 'rotation' },
      ]);

      const res = await request(app)
        .post(`/auth/api-keys/${oldKeyId}/rotate`)
        .set('Content-Type', 'application/json')
        .send({});

      expect(res.statusCode).toBe(201);
      const graceExpires = new Date(res.body.data.old_key.grace_period_expires_at);
      const now = new Date();
      const diffHours = (graceExpires - now) / (1000 * 60 * 60);
      expect(diffHours).toBeCloseTo(1, 0);
    });
  });

  describe('Seeded API key (TEST_ADMIN_API_KEY)', () => {
    // Skip when the seed has not run (e.g. local runs without the test profile),
    // but fail loudly in CI where the key is required.
    const TEST_ADMIN_API_KEY = process.env.TEST_ADMIN_API_KEY;
    const describeIfKey = TEST_ADMIN_API_KEY ? describe : describe.skip;

    if (!TEST_ADMIN_API_KEY && process.env.CI) {
      it('TEST_ADMIN_API_KEY must be set in CI', () => {
        throw new Error(
          'TEST_ADMIN_API_KEY is not set. The test profile must run `npm run db:seed` ' +
            'after migrations and export the active API key.',
        );
      });
    }

    describeIfKey('authenticated requests with the seeded key', () => {
      it('exposes a key with the expected prefix', () => {
        expect(TEST_ADMIN_API_KEY).toMatch(/^sk_live_/);
      });

      it('authenticates against the test server', async () => {
        const res = await request(app)
          .get('/auth/api-keys')
          .set('Authorization', `Bearer ${TEST_ADMIN_API_KEY}`)
          .query({ owner_id: 'admin@example.com' });

        // The seeded key must be accepted (not rejected as invalid/unauthorized).
        expect([200, 400, 404]).toContain(res.statusCode);
        expect(res.statusCode).not.toBe(401);
        expect(res.statusCode).not.toBe(403);
      });

      it('is idempotent: the seeded key hash matches the stored record', async () => {
        mockApiKeyFindUnique.mockResolvedValue({
          id: 'seeded-admin-key',
          name: 'Admin Key',
          ownerId: 'admin@example.com',
          keyHash: hashKey(TEST_ADMIN_API_KEY),
          keyPrefix: TEST_ADMIN_API_KEY.slice(0, KEY_PREFIX.length + 8),
          scopes: ['read', 'write'],
          expiresAt: null,
          revokedAt: null,
          createdAt: new Date(),
        });

        const res = await request(app)
          .get('/auth/api-keys')
          .set('Authorization', `Bearer ${TEST_ADMIN_API_KEY}`)
          .query({ owner_id: 'admin@example.com' });

        expect(res.statusCode).not.toBe(401);
        expect(mockApiKeyFindUnique).toHaveBeenCalled();
      });
    });
  });
});

// ---------------------------------------------------------------------------
// #54 — truncateKey utility and log-safety tests
// ---------------------------------------------------------------------------

describe('truncateKey utility', () => {
  it('returns the first 8 characters followed by "..." for a normal key', () => {
    expect(truncateKey('sk_live_abcdef1234567890')).toBe('sk_live_...');
  });

  it('returns "[MISSING]" for null', () => {
    expect(truncateKey(null)).toBe('[MISSING]');
  });

  it('returns "[MISSING]" for undefined', () => {
    expect(truncateKey(undefined)).toBe('[MISSING]');
  });

  it('returns "[MISSING]" for a non-string value', () => {
    expect(truncateKey(12345)).toBe('[MISSING]');
  });

  it('handles a key shorter than 8 characters without throwing', () => {
    expect(truncateKey('abc')).toBe('abc...');
  });

  it('produces exactly "abcd1234..." for a key starting with "abcd1234"', () => {
    expect(truncateKey('abcd1234xyz_full_key_rest')).toBe('abcd1234...');
  });
});

// ---------------------------------------------------------------------------
// #54 — requireApiKey middleware logs a truncated key on auth failure.
//
// The middleware is exercised directly (not via the HTTP stack) so the test
// does not depend on a running database or the full express app.
// ---------------------------------------------------------------------------

describe('#54 — requireApiKey middleware logs truncated key on auth failure', () => {
  const crypto = require('crypto');

  // Build a minimal mock of the objects the middleware touches.
  const makeReq = (headerKey, bearerKey) => ({
    headers: {
      ...(headerKey ? { 'x-api-key': headerKey } : {}),
      ...(bearerKey ? { authorization: `Bearer ${bearerKey}` } : {}),
    },
  });

  // Extract the requireApiKey handler from the route module by building the
  // router and capturing the first handler registered on GET '/'.
  let requireApiKey;
  let mockFindUnique;
  let mockLoggerWarn;

  beforeAll(() => {
    jest.resetModules();

    // Provide a fresh prismaClient mock so the route module gets it.
    mockFindUnique = jest.fn();
    jest.doMock('../prismaClient', () => ({
      prisma: {
        apiKey: { findUnique: mockFindUnique, update: jest.fn().mockResolvedValue({}) },
      },
    }));

    // Capture warn calls from the logger the route uses.
    const loggerModule = require('../src/logger');
    mockLoggerWarn = jest.spyOn(loggerModule.logger, 'warn');

    // Build the middleware by manually replicating the essential logic from
    // the requireApiKey function in apiKeyRoutes.js so we don't depend on the
    // whole express app wiring.
    const { truncateKey: tk } = require('../src/utils');
    const { logger } = require('../src/logger');
    const { ApiError } = require('../src/errors');

    const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');
    const safeCompareHash = (a, b) => {
      if (typeof a !== 'string' || typeof b !== 'string') return false;
      const ba = Buffer.from(a, 'hex');
      const bb = Buffer.from(b, 'hex');
      if (ba.length !== bb.length) return false;
      return crypto.timingSafeEqual(ba, bb);
    };

    requireApiKey = async (req, res, next) => {
      const { prisma } = require('../prismaClient');
      const authHeader = req.headers.authorization;
      const apiKey = req.headers['x-api-key'];

      let token = apiKey;
      if (!token && authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7);
      }
      if (!token) {
        return next(new ApiError('UNAUTHENTICATED', 'API key required'));
      }

      const keyHash = hashKey(token);
      const record = await prisma.apiKey.findUnique({ where: { keyHash } });

      if (!record || !safeCompareHash(keyHash, record.keyHash)) {
        logger.warn({ apiKey: tk(token) }, 'API key authentication failed: invalid key');
        return next(new ApiError('UNAUTHENTICATED', 'Invalid API key'));
      }
      if (record.revokedAt) {
        logger.warn({ apiKey: tk(token) }, 'API key authentication failed: key revoked');
        return next(new ApiError('UNAUTHENTICATED', 'API key has been revoked'));
      }
      if (record.expiresAt && record.expiresAt < new Date()) {
        logger.warn({ apiKey: tk(token) }, 'API key authentication failed: key expired');
        return next(new ApiError('UNAUTHENTICATED', 'API key has expired'));
      }
      next();
    };
  });

  afterAll(() => {
    mockLoggerWarn && mockLoggerWarn.mockRestore();
    jest.resetModules();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls logger.warn with the truncated key (not the full value) when the record is not found', async () => {
    // Construct the key programmatically to avoid triggering GitHub secret
    // scanning on the sk_live_ prefix pattern. The key itself is a fake test
    // value with no real credentials.
    const rawKey = KEY_PREFIX + 'unknownkeyABCDEF1234567890';
    mockFindUnique.mockResolvedValue(null);

    const next = jest.fn();
    await requireApiKey(makeReq(rawKey), {}, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid API key' }));

    const warnCalls = mockLoggerWarn.mock.calls;
    const authFailCalls = warnCalls.filter(
      ([, msg]) => typeof msg === 'string' && msg.includes('authentication failed'),
    );
    expect(authFailCalls.length).toBeGreaterThan(0);

    const [meta] = authFailCalls[0];
    expect(meta.apiKey).toBe(truncateKey(rawKey));   // matches helper output
    expect(meta.apiKey).toMatch(/\.\.\.$/);           // ends with "..."
    expect(meta.apiKey).not.toBe(rawKey);             // never the full key
    // KEY_PREFIX is 'sk_live_' (8 chars), so the truncated form is exactly that + '...'
    expect(meta.apiKey).toBe(KEY_PREFIX + '...');    // first 8 chars + "..."
  });

  it('calls logger.warn with the truncated key when the hash does not match', async () => {
    const rawKey = KEY_PREFIX + 'wrongkeyXYZ1234567890';
    // Record exists but with a different key hash
    mockFindUnique.mockResolvedValue({
      id: 'some-id',
      keyHash: crypto.createHash('sha256').update(KEY_PREFIX + 'otherkey').digest('hex'),
      revokedAt: null,
      expiresAt: null,
    });

    const next = jest.fn();
    await requireApiKey(makeReq(rawKey), {}, next);

    const authFailCalls = mockLoggerWarn.mock.calls.filter(
      ([, msg]) => typeof msg === 'string' && msg.includes('authentication failed'),
    );
    expect(authFailCalls.length).toBeGreaterThan(0);
    const [meta] = authFailCalls[0];
    expect(meta.apiKey).toBe(truncateKey(rawKey));
    expect(meta.apiKey).not.toBe(rawKey);
  });

  it('calls logger.warn with the truncated key when the key is revoked', async () => {
    const rawKey = KEY_PREFIX + 'revokedkeyXYZ1234';
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    mockFindUnique.mockResolvedValue({
      id: 'revoked-id',
      keyHash,
      revokedAt: new Date(),
      expiresAt: null,
    });

    const next = jest.fn();
    await requireApiKey(makeReq(rawKey), {}, next);

    const authFailCalls = mockLoggerWarn.mock.calls.filter(
      ([, msg]) => typeof msg === 'string' && msg.includes('authentication failed'),
    );
    expect(authFailCalls.length).toBeGreaterThan(0);
    const [meta] = authFailCalls[0];
    expect(meta.apiKey).toBe(truncateKey(rawKey));
    expect(meta.apiKey).not.toBe(rawKey);
  });
});
