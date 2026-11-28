'use strict';

const { Horizon } = require('@stellar/stellar-sdk');
const logger = require('../utils/logger');

const NETWORK_PASSPHRASES = {
  mainnet: 'Public Global Stellar Network ; September 2015',
  testnet: 'Test SDF Network ; September 2015',
  futurenet: 'Test SDF Future Network ; October 2022',
};

const CURSOR_KEY = 'horizon:cursor';

function getExpectedPassphrase(network) {
  const key = String(network || '').toLowerCase();
  return NETWORK_PASSPHRASES[key] || null;
}

async function verifyNetwork(server, network) {
  const expected = getExpectedPassphrase(network);
  if (!expected) {
    logger.warn(`Unknown HORIZON_NETWORK "${network}"; skipping network verification`);
    return;
  }

  let root;
  try {
    root = await server.serverURL ? await fetchRoot(server) : await fetchRoot(server);
  } catch (err) {
    logger.error(`Failed to fetch Horizon root for network verification: ${err.message}`);
    throw err;
  }

  const actual = root && root.network_passphrase;
  if (actual !== expected) {
    logger.error(
      `Horizon network mismatch: expected "${expected}" for HORIZON_NETWORK=${network}, but Horizon reports "${actual}". Halting event processing.`
    );
    throw new Error('Horizon network passphrase mismatch');
  }
}

async function fetchRoot(server) {
  const response = await server.root();
  return response;
}

async function readCursor(redis) {
  if (!redis || typeof redis.get !== 'function') {
    return null;
  }
  try {
    const stored = await redis.get(CURSOR_KEY);
    return stored || null;
  } catch (err) {
    logger.error(`Failed to read Horizon cursor from Redis: ${err.message}`);
    return null;
  }
}

async function writeCursor(redis, pagingToken) {
  if (!redis || typeof redis.set !== 'function' || !pagingToken) {
    return;
  }
  try {
    await redis.set(CURSOR_KEY, String(pagingToken));
  } catch (err) {
    logger.error(`Failed to persist Horizon cursor to Redis: ${err.message}`);
  }
}

async function startHorizonListener(config) {
  const server = new Horizon.Server(config.horizonUrl);

  await verifyNetwork(server, config.horizonNetwork);

  logger.info(`Horizon listener connected to ${config.horizonUrl} (${config.horizonNetwork})`);

  const storedCursor = await readCursor(config.redis);
  const startCursor = storedCursor || 'now';
  logger.info(`Horizon listener starting from cursor ${startCursor}`);

  const closeStream = server
    .payments()
    .cursor(startCursor)
    .stream({
      onmessage: (payment) => {
        try {
          handlePayment(payment, config);
          writeCursor(config.redis, payment && payment.paging_token);
        } catch (err) {
          logger.error(`Error handling payment event: ${err.message}`);
        }
      },
      onerror: (err) => {
        logger.error(`Horizon stream error: ${err.message}`);
      },
    });

  return closeStream;
}

function handlePayment(payment, config) {
  logger.info(`Received payment event ${payment.id} of type ${payment.type}`);
  if (typeof config.onPayment === 'function') {
    config.onPayment(payment);
  }
}

function handleContractEvent(event, config) {
  const topic = Array.isArray(event.topic) ? event.topic : [];
  const eventType = topic.length > 0 ? String(topic[0]) : '';

  if (eventType !== 'refund_claimed') {
    return;
  }

  const user = topic.length > 1 ? String(topic[1]) : undefined;
  const token = topic.length > 2 ? String(topic[2]) : undefined;
  const amount = event.value;

  logger.info(
    `Received refund_claimed event ${event.id}: user=${user} token=${token} amount=${amount}`
  );

  if (typeof config.onRefundClaimed === 'function') {
    config.onRefundClaimed({ user, token, amount, event });
  }
}

module.exports = {
  startHorizonListener,
  verifyNetwork,
  getExpectedPassphrase,
  readCursor,
  writeCursor,
  CURSOR_KEY,
  handleContractEvent,
  NETWORK_PASSPHRASES,
};
