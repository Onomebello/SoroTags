'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const MODULE_PATH = require.resolve('./src/originCache');

function loadFresh() {
  delete require.cache[MODULE_PATH];
  return require('./src/originCache');
}

let originalTtl;

beforeEach(() => {
  originalTtl = process.env.ORIGIN_CACHE_TTL_MS;
});

afterEach(() => {
  if (originalTtl === undefined) {
    delete process.env.ORIGIN_CACHE_TTL_MS;
  } else {
    process.env.ORIGIN_CACHE_TTL_MS = originalTtl;
  }
  delete require.cache[MODULE_PATH];
});

test('entries expire after the configured TTL', () => {
  process.env.ORIGIN_CACHE_TTL_MS = '50';
  const cache = loadFresh();

  cache.set('https://example.com');
  assert.strictEqual(cache.has('https://example.com'), true);

  const start = Date.now();
  while (Date.now() - start < 80) {
    // busy-wait past the TTL
  }

  assert.strictEqual(cache.has('https://example.com'), false);
  assert.strictEqual(cache.get('https://example.com'), undefined);
});

test('cache does not exceed 1000 entries and evicts least recently used', () => {
  process.env.ORIGIN_CACHE_TTL_MS = '600000';
  const cache = loadFresh();

  for (let i = 0; i < 1000; i += 1) {
    cache.set(`https://origin-${i}.example.com`);
  }
  assert.strictEqual(cache.size(), 1000);

  // Touch the first entry so it becomes most recently used.
  assert.strictEqual(cache.has('https://origin-0.example.com'), true);

  cache.set('https://origin-1000.example.com');

  assert.strictEqual(cache.size(), 1000);
  assert.strictEqual(cache.has('https://origin-0.example.com'), true);
  assert.strictEqual(cache.has('https://origin-1.example.com'), false);
  assert.strictEqual(cache.has('https://origin-1000.example.com'), true);
});
