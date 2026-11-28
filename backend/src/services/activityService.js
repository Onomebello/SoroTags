const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');

const prisma = new PrismaClient();

const dateSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'Invalid date format',
});

const auditLogQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).optional(),
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
});

async function getAuditLogs(query = {}) {
  const parsed = auditLogQuerySchema.safeParse(query);
  if (!parsed.success) {
    const error = new Error('Invalid input');
    error.code = 'INVALID_INPUT';
    error.status = 400;
    error.details = parsed.error.flatten();
    throw error;
  }

  const { limit, startDate, endDate } = parsed.data;

  const where = {};
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) {
      where.createdAt.gte = new Date(startDate);
    }
    if (endDate) {
      where.createdAt.lte = new Date(endDate);
    }
  }

  return prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit || 100,
  });
}

module.exports = {
  getAuditLogs,
  auditLogQuerySchema,
/**
 * @typedef {Object} ActivityEvent
 * @property {string} userId
 * @property {string} action
 * @property {string} [entityType]
 * @property {string} [entityId]
 * @property {Object} [metadata]
 */

/**
 * Build the pagination meta block shared by all paginated responses.
 * `totalPages` is always a number, defaulting to 0 when there are no results.
 * @param {number} total
 * @param {number} limit
 * @returns {{ total: number, totalPages: number }}
 */
function buildMeta(total, limit) {
  const safeTotal = Number.isFinite(total) && total > 0 ? total : 0;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 1;
  return {
    total: safeTotal,
    totalPages: safeTotal === 0 ? 0 : Math.ceil(safeTotal / safeLimit),
  };
}

/**
 * Persist a single activity log entry.
 * @param {ActivityEvent} event
 * @returns {Promise<Object>}
 */
async function log(event) {
  return prisma.activityLog.create({
    data: {
      userId: event.userId,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      metadata: event.metadata,
    },
  });
}

/**
 * Persist multiple activity log entries in a single Prisma call.
 * @param {ActivityEvent[]} events
 * @returns {Promise<{ count: number }>}
 */
async function logMany(events) {
  if (!Array.isArray(events) || events.length === 0) {
  return { count: 0 };
  }

  return prisma.activityLog.createMany({
    data: events.map((event) => ({
      userId: event.userId,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      metadata: event.metadata,
    })),
    skipDuplicates: false,
  });
}

/**
 * Fetch a page of activity logs for a user.
 *
 * Supports two pagination strategies:
 * - Cursor-based (preferred for large, time-ordered tables): pass `cursor`
 *   (the last seen `id`) to fetch the next page after that ID. This avoids
 *   the large `skip` scans that make deep offset pagination slow.
 * - Offset-based (backward compatible): used when no `cursor` is provided.
 *
 * The `userId` scope is always enforced at the service layer and cannot be
 * overridden by pagination params (page/limit/cursor).
 *
 * @param {string} userId
 * @param {Object} [options]
 * @param {number} [options.page=1]
 * @param {number} [options.limit=20]
 * @param {string} [options.cursor] last seen activity log id
 * @returns {Promise<{ data: Object[], total: number, page: number, limit: number, totalPages: number, nextCursor: string|null }>}
 */
async function listByUser(userId, options = {}) {
  if (!userId) {
    throw new Error('listByUser requires a userId to scope activity queries');
  }

  const page = Math.max(1, Number.parseInt(options.page, 10) || 1);
  const limit = Math.max(1, Number.parseInt(options.limit, 10) || 20);
  const cursor = options.cursor || null;

  // Always scope by userId. Pagination params must never widen this filter.
  const where = { userId };

  if (cursor) {
    // Cursor-based pagination: fetch the page after the given id.
    const rows = await prisma.activityLog.findMany({
      where,
      orderBy: { id: 'desc' },
      take: limit + 1,
      cursor: { id: cursor },
      skip: 1,
    });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? data[data.length - 1].id : null;

    const total = await prisma.activityLog.count({ where });
    const meta = buildMeta(total, limit);

    return {
      data,
      total: meta.total,
      page,
      limit,
      totalPages: meta.totalPages,
      nextCursor,
    };
  }

  // Offset-based pagination: retained for clients without a cursor.
  const [data, total] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      orderBy: { id: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.activityLog.count({ where }),
  ]);

  const nextCursor = data.length === limit ? data[data.length - 1].id : null;
  const meta = buildMeta(total, limit);

  return {
    data,
    total: meta.total,
    page,
    limit,
    totalPages: meta.totalPages,
    nextCursor,
  };
}

module.exports = {
  log,
  logMany,
  listByUser,
  buildMeta,
};
