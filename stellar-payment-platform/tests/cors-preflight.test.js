'use strict';

/**
 * tests/cors-preflight.test.js
 *
 * Browser preflight (OPTIONS) requests to /admin/* must be answered by the
 * CORS middleware with 200 OK and CORS headers, not 405 Method Not Allowed.
 */

const request = require('supertest');

jest.mock('redis', () => ({ createClient: jest.fn(() => null) }));
jest.mock('../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));

jest.mock('../prismaClient', () => ({
  prisma: {
    user: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    auditLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]), count: jest.fn() },
    approvedOrigin: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn().mockResolvedValue([0, []]),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $metrics: { json: jest.fn().mockResolvedValue({ counters: [], gauges: [], histograms: [] }) },
  },
  isPrismaConnectionError: () => false,
}));

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn().mockImplementation(() => ({ payments: jest.fn() })) },
  StrKey: { isValidEd25519PublicKey: jest.fn((v) => typeof v === 'string' && v.startsWith('G')) },
  Keypair: { fromPublicKey: jest.fn(() => ({ verify: jest.fn(() => true) })) },
}));
jest.mock('pdfkit', () => jest.fn());

process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key';

const { app } = require('../server');

const ORIGIN = 'http://localhost:5173';

const preflight = (path, method = 'GET') =>
  request(app)
    .options(path)
    .set('Origin', ORIGIN)
    .set('Access-Control-Request-Method', method)
    .set('Access-Control-Request-Headers', 'x-api-key,content-type');

describe('CORS preflight for admin endpoints', () => {
  test('OPTIONS /admin/audit-logs returns 200 with CORS headers', async () => {
    const res = await preflight('/admin/audit-logs');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  test('Access-Control-Allow-Methods includes GET', async () => {
    const res = await preflight('/admin/audit-logs');

    const methods = res.headers['access-control-allow-methods']
      .split(',')
      .map((m) => m.trim().toUpperCase());
    expect(methods).toContain('GET');
  });

  test('Access-Control-Allow-Headers includes the admin API key header', async () => {
    const res = await preflight('/admin/audit-logs');

    expect(res.headers['access-control-allow-headers'].toLowerCase()).toContain('x-api-key');
  });

  test('OPTIONS preflight does not require admin authentication', async () => {
    // No x-api-key header is sent; the preflight must still succeed.
    const res = await preflight('/admin/audit-logs');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(405);
  });

  test('OPTIONS on the versioned admin path also returns 200', async () => {
    const res = await preflight('/api/v1/admin/audit-logs');
    expect(res.status).toBe(200);
  });

  test('OPTIONS on a route with a method-not-allowed handler returns 200, not 405', async () => {
    const res = await preflight('/register', 'POST');
    expect(res.status).toBe(200);
  });
});
