'use strict';

const { CONFLICT } = require('../errors');

/**
 * Registration service.
 *
 * Handles username registration against an address. Registration is
 * idempotent for an identical username+address pair: re-registering the
 * same pair returns success with `already_registered: true` instead of
 * throwing a conflict. A username that belongs to a different address is
 * still a genuine conflict.
 *
 * Concurrency: the existence check is not relied upon for correctness. The
 * unique constraint on the username is the source of truth; a `P2002`
 * violation from a concurrent insert is translated into a CONFLICT.
 */

const MAX_ALIASES_PER_ADDRESS = 5;

function isUniqueViolation(err) {
  return err && err.code === 'P2002';
}

class RegistrationService {
  constructor(db) {
    this.db = db;
  }

  /**
   * Register a username for an address.
   *
   * @param {string} username
   * @param {string} address
   * @returns {Promise<{ ok: true, already_registered: boolean }>}
   * @throws {Error} CONFLICT when the username is taken by a different address
   *                 or the address has reached its alias limit.
   */
  async register(username, address) {
    const aliasCount = await this.db.countAliasesForAddress(address);
    if (aliasCount >= MAX_ALIASES_PER_ADDRESS) {
      throw new CONFLICT('Address has reached the maximum number of aliases');
    }

    try {
      await this.db.createRegistration(username, address);
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }

      // A concurrent request won the race. Distinguish an idempotent
      // re-registration of the same pair from a genuine conflict.
      const existing = await this.db.getRegistration(username);
      if (existing && existing.address === address) {
        return { ok: true, already_registered: true };
      }

      throw new CONFLICT('Username is already taken.');
    }

    return { ok: true, already_registered: false };
  }
}

module.exports = RegistrationService;
