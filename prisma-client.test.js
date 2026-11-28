'use strict';

// Verifies that src/db.js exports a singleton PrismaClient instance.
// Jest clears the module cache between test files, so the client must be
// stored on the global object to avoid opening a new connection pool per file.

describe('Prisma client singleton', () => {
  afterEach(() => {
    jest.resetModules();
  });

  test('repeated requires return the same instance', () => {
    const first = require('./src/db');
    const second = require('./src/db');

    expect(second).toBe(first);
  });

  test('instance is reused after module cache is cleared', () => {
    const first = require('./src/db');

    jest.resetModules();

    const second = require('./src/db');

    expect(second).toBe(first);
  });

  test('client is stored on the global object', () => {
    const client = require('./src/db');

    expect(global.__prisma).toBe(client);
  });
});
