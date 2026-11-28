const logger = require('./logger');
const prisma = require('./prisma');

/**
 * Purges soft-deleted records older than the retention window.
 * Logs per-table purge counts and a total summary at completion.
 */
async function runCleanup() {
  const retentionDays = 30;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  let total = 0;

  const userResult = await prisma.user.deleteMany({
    where: { deletedAt: { not: null, lt: cutoff } },
  });
  logger.info('Purge completed', { table: 'User', count: userResult.count });
  total += userResult.count;

  const postResult = await prisma.post.deleteMany({
    where: { deletedAt: { not: null, lt: cutoff } },
  });
  logger.info('Purge completed', { table: 'Post', count: postResult.count });
  total += postResult.count;

  const commentResult = await prisma.comment.deleteMany({
    where: { deletedAt: { not: null, lt: cutoff } },
  });
  logger.info('Purge completed', { table: 'Comment', count: commentResult.count });
  total += commentResult.count;

  logger.info('Purge summary', { total });

  return total;
}

module.exports = { runCleanup };
