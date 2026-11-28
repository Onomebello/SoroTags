const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getFederationRecord } = require('../services/federation');

const CACHE_CONTROL_SUCCESS = 'public, max-age=60, stale-while-revalidate=30';
const CACHE_CONTROL_NOT_FOUND = 'no-store';

const FEDERATION_QUERY_PATTERN = /^[^\s*]+\*[^\s*]+$/;

function computeETag(body) {
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  return `"${hash}"`;
}

router.get('/', async (req, res, next) => {
  try {
    const { username } = req.query;

    if (!username) {
      res.set('Cache-Control', CACHE_CONTROL_NOT_FOUND);
      return res.status(400).json({ error: 'username query parameter is required' });
    }

    if (typeof username !== 'string' || !FEDERATION_QUERY_PATTERN.test(username)) {
      res.set('Cache-Control', CACHE_CONTROL_NOT_FOUND);
      return res.status(400).json({
        error: 'INVALID_INPUT',
        message: 'username must be in the format name*domain',
      });
    }

    const record = await getFederationRecord(username);

    if (!record) {
      res.set('Cache-Control', CACHE_CONTROL_NOT_FOUND);
      return res.status(404).json({ error: 'Federation record not found' });
    }

    const body = JSON.stringify(record);
    const etag = computeETag(body);

    res.set('Cache-Control', CACHE_CONTROL_SUCCESS);
    res.set('ETag', etag);

    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    res.type('application/json').send(body);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
