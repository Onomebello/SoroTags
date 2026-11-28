'use strict';

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 1000;

function resolveTtlMs() {
  const raw = process.env.ORIGIN_CACHE_TTL_MS;
  if (raw === undefined || raw === '') return DEFAULT_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_MS;
  return parsed;
}

// Map preserves insertion order, which we use as the LRU order:
// the first key is the least-recently-used entry.
const cache = new Map();

function isExpired(entry, now) {
  return now - entry.cachedAt >= entry.ttlMs;
}

function evictExpired(now) {
  for (const [origin, entry] of cache) {
    if (isExpired(entry, now)) {
      cache.delete(origin);
    }
  }
}

function get(origin) {
  const entry = cache.get(origin);
  if (!entry) return undefined;
  const now = Date.now();
  if (isExpired(entry, now)) {
    cache.delete(origin);
    return undefined;
  }
  // Refresh LRU position on access.
  cache.delete(origin);
  cache.set(origin, entry);
  return entry.value;
}

function set(origin, value) {
  const now = Date.now();
  const ttlMs = resolveTtlMs();

  // Remove any existing entry so the new one lands at the MRU position.
  cache.delete(origin);

  evictExpired(now);

  while (cache.size >= MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }

  cache.set(origin, { value, cachedAt: now, ttlMs });
  return value;
}

function has(origin) {
  return get(origin) !== undefined;
}

function deleteEntry(origin) {
  return cache.delete(origin);
}

function clear() {
  cache.clear();
}

function size() {
  return cache.size;
}

module.exports = {
  DEFAULT_TTL_MS,
  MAX_ENTRIES,
  get,
  set,
  has,
  delete: deleteEntry,
  clear,
  size,
};
