const express = require('express');
const axios = require('axios');

const router = express.Router();

const DEFAULT_HORIZON_BASE = 'https://horizon-testnet.stellar.org';

function getHorizonBase() {
  const base = process.env.HORIZON_BASE || DEFAULT_HORIZON_BASE;
  return base.replace(/\/+$/, '');
}

router.get('/', async (req, res) => {
  const horizonBase = getHorizonBase();
  const horizonUrl = `${horizonBase}/`;
  const timeout = Number(process.env.HEALTH_HORIZON_TIMEOUT_MS) || 5000;

  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    checks: {
      horizon: { status: 'unknown', url: horizonUrl },
    },
  };

  try {
    await axios.get(horizonUrl, { timeout });
    health.checks.horizon.status = 'ok';
  } catch (err) {
    health.status = 'degraded';
    health.checks.horizon.status = 'error';
    health.checks.horizon.error = err.message;
  }

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

module.exports = router;
