'use strict';

// Mock external dependencies that are not installed at the root workspace.
jest.mock('axios', () => ({}), { virtual: true });
jest.mock('../src/utils/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn() } }), { virtual: true });

const { retryHorizonRequest, retryDelay, isTransientHorizonError } = require('../src/services/stellarService');

function makeError(status, { code, retryAfter } = {}) {
  const err = new Error(`Horizon error ${status}`);
  if (status !== undefined) {
    err.response = {
      status,
      headers: retryAfter ? { 'retry-after': String(retryAfter) } : {},
    };
  }
  if (code) err.code = code;
  return err;
}

// ---------------------------------------------------------------------------
// isTransientHorizonError
// ---------------------------------------------------------------------------
describe('isTransientHorizonError', () => {
  it('returns true for 429', () => {
    expect(isTransientHorizonError(makeError(429))).toBe(true);
  });

  it('returns true for 503', () => {
    expect(isTransientHorizonError(makeError(503))).toBe(true);
  });

  it('returns false for 404', () => {
    expect(isTransientHorizonError(makeError(404))).toBe(false);
  });

  it('returns false for 400', () => {
    expect(isTransientHorizonError(makeError(400))).toBe(false);
  });

  it('returns true for ETIMEDOUT (no response)', () => {
    expect(isTransientHorizonError(makeError(undefined, { code: 'ETIMEDOUT' }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// retryDelay
// ---------------------------------------------------------------------------
describe('retryDelay', () => {
  it('honours a Retry-After header on 429', () => {
    const err = makeError(429, { retryAfter: 2 });
    expect(retryDelay(err, 1)).toBe(2000);
  });

  it('falls back to exponential backoff when Retry-After is absent', () => {
    const err = makeError(429);
    // attempt 1 → 500ms, attempt 2 → 1000ms, attempt 3 → 2000ms
    expect(retryDelay(err, 1)).toBe(500);
    expect(retryDelay(err, 2)).toBe(1000);
    expect(retryDelay(err, 3)).toBe(2000);
  });

  it('uses exponential backoff for 503', () => {
    const err = makeError(503);
    expect(retryDelay(err, 1)).toBe(500);
    expect(retryDelay(err, 2)).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// retryHorizonRequest – existing 503 / network paths
// ---------------------------------------------------------------------------
describe('retryHorizonRequest', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('retries a single 503 and eventually succeeds', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(makeError(503))
      .mockResolvedValueOnce({ ok: true });

    const promise = retryHorizonRequest(fn, 3);
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after three consecutive 503s', async () => {
    const fn = jest.fn().mockRejectedValue(makeError(503));

    const promise = retryHorizonRequest(fn, 3);
    const assertion = expect(promise).rejects.toMatchObject({
      response: { status: 503 },
    });
    await jest.runAllTimersAsync();
    await assertion;

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 404', async () => {
    const fn = jest.fn().mockRejectedValue(makeError(404));

    await expect(retryHorizonRequest(fn, 3)).rejects.toMatchObject({
      response: { status: 404 },
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 400', async () => {
    const fn = jest.fn().mockRejectedValue(makeError(400));

    await expect(retryHorizonRequest(fn, 3)).rejects.toMatchObject({
      response: { status: 400 },
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries network timeouts', async () => {
    const timeout = makeError(undefined, { code: 'ETIMEDOUT' });
    const fn = jest
      .fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({ ok: true });

    const promise = retryHorizonRequest(fn, 3);
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // 429-specific paths (issue #34)
  // -------------------------------------------------------------------------

  it('retries a single 429 and succeeds on the second attempt', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(makeError(429))
      .mockResolvedValueOnce({ ok: true });

    const promise = retryHorizonRequest(fn, 3);
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('succeeds on the second retry (third call overall) after two 429s', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(makeError(429))
      .mockRejectedValueOnce(makeError(429))
      .mockResolvedValueOnce({ ok: true });

    const promise = retryHorizonRequest(fn, 3);
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws SERVICE_UNAVAILABLE / 503 after three consecutive 429s', async () => {
    const fn = jest.fn().mockRejectedValue(makeError(429));

    const promise = retryHorizonRequest(fn, 3);
    // Attach the rejection handler BEFORE advancing timers to avoid an
    // unhandled-rejection warning (same pattern as the 503 test above).
    const assertion = expect(promise).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Horizon rate limit exceeded',
    });
    await jest.runAllTimersAsync();
    await assertion;

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('honours the Retry-After header when backing off on 429', async () => {
    // The timer should advance by exactly the Retry-After value (2 s = 2000 ms)
    // for the first retry, then by exponential backoff (500 ms) for the second.
    const fn = jest
      .fn()
      .mockRejectedValueOnce(makeError(429, { retryAfter: 2 }))
      .mockRejectedValueOnce(makeError(429))
      .mockResolvedValueOnce({ ok: true });

    const advanceSpy = jest.spyOn(global, 'setTimeout');

    const promise = retryHorizonRequest(fn, 3);
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(3);

    // The first setTimeout should have been called with 2000 ms (Retry-After: 2).
    const delays = advanceSpy.mock.calls.map((c) => c[1]);
    expect(delays).toContain(2000);
  });
});
