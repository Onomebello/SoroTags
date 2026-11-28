'use strict';

const axios = require('axios');
const { logger } = require('../utils/logger');

const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

/**
 * Build a 503 ApiError signalling that Horizon rate-limiting persisted
 * through all retry attempts.
 */
function makeRateLimitError() {
  const err = new Error('Horizon rate limit exceeded');
  err.statusCode = 503;
  err.code = 'SERVICE_UNAVAILABLE';
  return err;
}

function isTransientHorizonError(err) {
  if (!err) return false;
  const status = err.response && err.response.status;
  if (status === 429 || status === 503) return true;
  // Network timeouts / connection failures have no response.
  if (!err.response) {
    return (
      err.code === 'ECONNABORTED' ||
      err.code === 'ETIMEDOUT' ||
      err.code === 'ECONNRESET' ||
      err.code === 'ENOTFOUND' ||
      err.code === 'EAI_AGAIN'
    );
  }
  return false;
}

/**
 * Return the number of milliseconds to wait before the next retry.
 *
 * For 429 responses the Retry-After header is honoured when present
 * (value in whole seconds).  Falls back to exponential backoff otherwise.
 */
function retryDelay(err, attempt) {
  const is429 = err.response && err.response.status === 429;
  if (is429) {
    const retryAfterHeader =
      err.response.headers && err.response.headers['retry-after'];
    if (retryAfterHeader) {
      const seconds = parseInt(retryAfterHeader, 10);
      if (!Number.isNaN(seconds) && seconds > 0) {
        return seconds * 1000;
      }
    }
  }
  return RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryHorizonRequest(fn, maxAttempts = RETRY_MAX_ATTEMPTS) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientHorizonError(err)) {
        throw err;
      }
      if (attempt === maxAttempts) {
        // All retries exhausted on a 429 → surface as 503 to callers.
        if (err.response && err.response.status === 429) {
          throw makeRateLimitError();
        }
        throw err;
      }
      const delay = retryDelay(err, attempt);
      logger.warn(
        { attempt, maxAttempts, delay, status: err.response && err.response.status },
        'Transient Horizon error, retrying'
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

async function getAccount(accountId) {
  return retryHorizonRequest(async () => {
    const response = await axios.get(`${HORIZON_URL}/accounts/${accountId}`);
    return response.data;
  });
}

async function getAccountBalance(accountId) {
  return retryHorizonRequest(async () => {
    const response = await axios.get(`${HORIZON_URL}/accounts/${accountId}`);
    const balances = response.data.balances || [];
    const native = balances.find((b) => b.asset_type === 'native');
    return native ? native.balance : '0';
  });
}

async function getTransactions(accountId, limit = 10) {
  return retryHorizonRequest(async () => {
    const response = await axios.get(`${HORIZON_URL}/accounts/${accountId}/transactions`, {
      params: { limit, order: 'desc' },
    });
    return response.data._embedded && response.data._embedded.records
      ? response.data._embedded.records
      : [];
  });
}

async function submitTransaction(envelopeXdr) {
  return retryHorizonRequest(async () => {
    const response = await axios.post(
      `${HORIZON_URL}/transactions`,
      `tx=${encodeURIComponent(envelopeXdr)}`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return response.data;
  });
}

module.exports = {
  retryHorizonRequest,
  retryDelay,
  isTransientHorizonError,
  makeRateLimitError,
  getAccount,
  getAccountBalance,
  getTransactions,
  submitTransaction,
};
