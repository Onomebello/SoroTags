const { z } = require('zod');

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

/**
 * Shared pagination query schema.
 *
 * Accepts `page` (default 1) and `limit` (default 10, clamped to a max of 100).
 * Values are coerced from query strings and validated as positive integers.
 */
const paginationSchema = z.object({
  page: z.coerce
    .number()
    .int()
    .min(1)
    .default(DEFAULT_PAGE),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT),
});

/**
 * Optional `assetCode` filter schema.
 *
 * Accepts any 1-12 character alphanumeric asset code (e.g. `XLM`, `yXLM`,
 * `EURC`). The validated value is passed to Prisma as a parameterised
 * `where` clause filter, never interpolated into SQL.
 */
const assetCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(12)
  .regex(/^[A-Za-z0-9]+$/, 'assetCode must be alphanumeric');

/**
 * Optional `cursor` schema for cursor-based pagination.
 *
 * The cursor is the last seen record `id`. Accepts a positive integer
 * (coerced from the query string) so it can be used directly as a Prisma
 * `cursor`/`where` value.
 */
const cursorSchema = z.coerce
  .number()
  .int()
  .positive();

/**
 * Optional ISO date schema for time-range filters.
 *
 * Accepts an ISO-8601 date or datetime string (e.g. `2026-09-01` or
 * `2026-09-01T00:00:00Z`) and coerces it to a `Date`. Invalid formats fail
 * validation so callers can return `400 INVALID_INPUT`.
 */
const dateSchema = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'must be a valid ISO date',
  })
  .transform((value) => new Date(value));

/**
 * Routing stats query schema: pagination plus an optional `assetCode` filter.
 */
const routingStatsQuerySchema = paginationSchema.extend({
  assetCode: assetCodeSchema.optional(),
});

/**
 * Audit log query schema: pagination plus optional `startDate`/`endDate`
 * time-range filters.
 */
const auditLogQuerySchema = paginationSchema.extend({
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
});

/**
 * Parse pagination query params, clamping `limit` to MAX_LIMIT and
 * falling back to defaults for invalid values.
 *
 * @param {object} [query]
 * @returns {{ page: number, limit: number, offset: number }}
 */
function parsePagination(query = {}) {
  const result = paginationSchema.safeParse(query);

  if (!result.success) {
    const page = Number.parseInt(query.page, 10);
    const limit = Number.parseInt(query.limit, 10);

    return {
      page: Number.isInteger(page) && page > 0 ? page : DEFAULT_PAGE,
      limit:
        Number.isInteger(limit) && limit > 0
          ? Math.min(limit, MAX_LIMIT)
          : DEFAULT_LIMIT,
      offset: 0,
    };
  }

  const { page, limit } = result.data;
  const clampedLimit = Math.min(limit, MAX_LIMIT);

  return {
    page,
    limit: clampedLimit,
    offset: (page - 1) * clampedLimit,
  };
}

/**
 * Parse an optional `cursor` query param for cursor-based pagination.
 *
 * Returns the cursor as a positive integer, or `null` when absent/invalid
 * so callers can fall back to offset-based pagination.
 *
 * @param {object} [query]
 * @returns {number | null}
 */
function parseCursor(query = {}) {
  if (query.cursor === undefined || query.cursor === null || query.cursor === '') {
    return null;
  }

  const result = cursorSchema.safeParse(query.cursor);
  return result.success ? result.data : null;
}

/**
 * Build the pagination `meta` block returned alongside `data`.
 *
 * Always includes every meta field so clients can safely read
 * `meta.totalPages` even when there are no results (defaults to 0).
 * `nextCursor` is the last seen `id` for cursor-based pagination, or `null`
 * when there are no further pages.
 *
 * @param {{ total: number, page: number, limit: number, nextCursor?: number | null }} params
 * @returns {{ total: number, page: number, limit: number, totalPages: number, nextCursor: number | null }}
 */
function buildPaginationMeta({ total, page, limit, nextCursor = null }) {
  const safeLimit = limit > 0 ? limit : DEFAULT_LIMIT;
  const safeTotal = Number.isFinite(total) && total > 0 ? total : 0;
  const totalPages = safeTotal === 0 ? 0 : Math.ceil(safeTotal / safeLimit);

  return {
    total: safeTotal,
    page,
    limit: safeLimit,
    totalPages,
    nextCursor: nextCursor ?? null,
  };
}

module.exports = {
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  paginationSchema,
  assetCodeSchema,
  cursorSchema,
  dateSchema,
  routingStatsQuerySchema,
  auditLogQuerySchema,
  parsePagination,
  parseCursor,
  buildPaginationMeta,
};
