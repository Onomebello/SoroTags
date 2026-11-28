'use strict';

/**
 * Database seed script.
 *
 * Safety guard: refuses to run against a non-allowlisted database host unless
 * SEED_ALLOW_REMOTE=1 is explicitly set. Allowed hosts are configured via the
 * comma-separated SEED_ALLOWED_HOSTS env var (defaults to localhost hosts).
 *
 * Usage:
 *   node scripts/seed.js            # seed the database
 *   node scripts/seed.js --dry-run  # print upsert targets without writing
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'];

function parseAllowedHosts() {
  const raw = process.env.SEED_ALLOWED_HOSTS;
  if (!raw || !raw.trim()) {
    return DEFAULT_ALLOWED_HOSTS;
  }
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function resolveDatabaseHost(databaseUrl) {
  if (!databaseUrl) {
    return null;
  }
  try {
    // Prisma URLs may carry a scheme like postgresql://; URL handles it.
    const parsed = new URL(databaseUrl);
    return parsed.hostname ? parsed.hostname.toLowerCase() : null;
  } catch (err) {
    return null;
  }
}

function assertSafeTarget(databaseUrl) {
  const host = resolveDatabaseHost(databaseUrl);
  const allowRemote = process.env.SEED_ALLOW_REMOTE === '1';

  if (!host) {
    if (!allowRemote) {
      console.error(
        '✖ Refusing to seed: could not determine database host from DATABASE_URL.\n' +
          '  Set SEED_ALLOW_REMOTE=1 to override.'
      );
      process.exit(1);
    }
    return;
  }

  const allowedHosts = parseAllowedHosts();
  if (allowedHosts.includes(host)) {
    return;
  }

  if (!allowRemote) {
    console.error(
      `✖ Refusing to seed: database host "${host}" is not in SEED_ALLOWED_HOSTS ` +
        `(${allowedHosts.join(', ')}).\n` +
        '  Set SEED_ALLOW_REMOTE=1 to explicitly allow seeding a remote database.'
    );
    process.exit(1);
  }
}

function printWarning() {
  console.warn('');
  console.warn('⚠ WARNING: This will modify the database');
  console.warn('');
}

async function seed({ dryRun }) {
  const upserts = [
    {
      model: 'user',
      where: { email: 'admin@example.com' },
      data: { email: 'admin@example.com', name: 'Admin' },
    },
  ];

  if (dryRun) {
    console.log('Dry run — the following upserts would be performed:');
    for (const op of upserts) {
      console.log(`  • ${op.model} where ${JSON.stringify(op.where)}`);
    }
    console.log('Dry run complete. No changes were written.');
    return;
  }

  printWarning();

  for (const op of upserts) {
    await prisma[op.model].upsert({
      where: op.where,
      update: op.data,
      create: op.data,
    });
  }

  console.log('Seed complete.');
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  assertSafeTarget(process.env.DATABASE_URL);

  try {
    await seed({ dryRun });
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  parseAllowedHosts,
  resolveDatabaseHost,
  assertSafeTarget,
};
