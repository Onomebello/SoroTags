const express = require('express');
const { StrKey } = require('@stellar/stellar-sdk');
const { PrismaClient } = require('@prisma/client');
const { ApiError } = require('../errors');
const { rejectNestedObjects } = require('../middleware/rejectNestedObjects');

const router = express.Router();
const prisma = new PrismaClient();

router.post('/register', rejectNestedObjects, async (req, res, next) => {
  try {
    // Registration mutates state; never let CDNs/proxies cache the response.
    res.set('Cache-Control', 'no-store');

    const { address, memo } = req.body || {};

    if (!address || typeof address !== 'string') {
      throw new ApiError('INVALID_INPUT', 'address is required');
    }

    if (!StrKey.isValidEd25519PublicKey(address)) {
      throw new ApiError('INVALID_INPUT', 'Invalid Stellar address');
    }

    let account;
    try {
      account = await prisma.account.create({
        data: { address, memo: memo || null },
      });
    } catch (err) {
      if (err && err.code === 'P2002') {
        // Unique constraint violation: another concurrent request won the race.
        throw new ApiError('CONFLICT', 'Username is already taken.');
      }
      throw err;
    }

    res.status(201).json({ ok: true, already_registered: false, address: account.address, memo: account.memo });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
