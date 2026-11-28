const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const { Queue, Worker, UnrecoverableError } = require('bullmq');
const { createRedisConnection } = require('./config/redis');
const { logger } = require('./logger');
const { shouldFallbackToLocalRegistry } = require('./utils');
const { decryptSecret } = require('./utils/webhookSecret');
const {
  shouldFallbackToLocalRegistry,
  exponentialDelay,
} = require('./utils');
const {
  updatePaymentIntentStatus,
  VALID_TRANSITIONS,
} = require('./services/paymentIntentStateMachine');

const WEBHOOK_TIMEOUT_MS = 10_000;
const WEBHOOK_QUEUE_NAME = 'webhook-deliveries';
const MAX_WEBHOOK_ATTEMPTS = 5;
const WEBHOOK_WORKER_CONCURRENCY = Number(process.env.WEBHOOK_CONCURRENCY) || 10;
const MAX_RETRY_BACKLOG_DAYS = 3;

// Exponential backoff configuration for failed webhook deliveries.
// Base 30s, factor 2, capped at 1h, with ±10% jitter to avoid thundering herds.
const WEBHOOK_RETRY_BASE_MS = Number(process.env.WEBHOOK_RETRY_BASE_MS) || 30_000;
const WEBHOOK_RETRY_MAX_MS = Number(process.env.WEBHOOK_RETRY_MAX_MS) || 3_600_000;
const WEBHOOK_RETRY_FACTOR = Number(process.env.WEBHOOK_RETRY_FACTOR) || 2;
const WEBHOOK_RETRY_JITTER = 0.1;

// Deprecated alias header; scheduled for removal.
const WEBHOOK_SIGNATURE_ALIAS_HEADER = 'X-Stellar-Tags-Signature';
const WEBHOOK_SIGNATURE_ALIAS_REMOVAL_VERSION = 'v2.0.0';
const WEBHOOK_SIGNATURE_ALIAS_REMOVAL_DATE = '2025-12-31';

const computeRetryDelay = (attempt) => exponentialDelay(
  attempt,
  WEBHOOK_RETRY_BASE_MS,
  WEBHOOK_RETRY_MAX_MS,
  WEBHOOK_RETRY_JITTER,
  WEBHOOK_RETRY_FACTOR,
);

const WEBHOOK_JOB_OPTIONS = Object.freeze({
  attempts: MAX_WEBHOOK_ATTEMPTS,
  backoff: {
    type: 'custom',
  },
  removeOnComplete: 1_000,
  removeOnFail: 5_000,
});

let webhookQueue;
let webhookWorker;
let queueConnection;
let workerConnection;

const computeSignature = (secret, timestamp, rawBody) => {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
};

const webhookEventMatches = (webhook, eventName) => {
  const subscriptions = Array.isArray(webhook?.events) ? webhook.events : ['*'];
  const normalized = subscriptions
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);

  if (normalized.length === 0 || normalized.includes('*')) return true;
  return normalized.includes(eventName);
};

const fetchWebhooksForAddress = async (prisma, poolGetFn, stellarAddress) => {
  try {
    return await prisma.webhook.findMany({
      where: {
        user: { address: stellarAddress },
      },
      select: {
        id: true,
        username: true,
        url: true,
        secret: true,
        events: true,
        failingSince: true,
      },
    });
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error)) throw error;

    const rows = await poolGetFn(
      `SELECT w.id, w.username, w.url, w.secret, w.events, w.failing_since
       FROM webhooks w
       INNER JOIN username_registry u ON u.username = w.username
       WHERE u.address = $1`,
      [stellarAddress],
    );
    return (rows || []).map((r) => ({
      id: r.id,
      username: r.username,
      url: r.url,
      secret: r.secret,
      events: Array.isArray(r.events) ? r.events : (typeof r.events === 'string' ? JSON.parse(r.events || '[]') : ['*']),
      failingSince: r.failing_since ? new Date(r.failing_since) : null,
    }));
  }
};

const getWebhooksExhaustedRetries = async (prisma, poolAllFn) => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_RETRY_BACKLOG_DAYS);

  try {
    return await prisma.webhook.findMany({
      where: {
        failingSince: { not: null, lt: cutoff },
      },
      select: {
        id: true,
        username: true,
        url: true,
        secret: true,
        failingSince: true,
      },
    });
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error) || typeof poolAllFn !== 'function') {
      throw error;
    }
    const rows = await poolAllFn(
      `SELECT id, username, url, secret, failing_since
       FROM webhooks
       WHERE failing_since IS NOT NULL AND failing_since < $1`,
      [cutoff.toISOString()],
    );
    return (rows || []).map((row) => ({
      id: row.id,
      username: row.username,
      url: row.url,
      secret: row.secret,
      failingSince: row.failing_since ? new Date(row.failing_since) : null,
    }));
  }
};

// ── SSRF protection ─────────────────────────────────────────────────────────
//
// Webhook URLs are user-controlled and stored long before delivery, so every
// delivery re-validates the target. Only HTTPS endpoints that resolve to
// public unicast addresses are allowed.

const SSRF_ERROR_CODE = 'SSRF_BLOCKED';

// Non-public IPv4 ranges: [network, prefix length, label].
const BLOCKED_IPV4_RANGES = [
  ['0.0.0.0', 8, 'reserved'], //          "this" network
  ['10.0.0.0', 8, 'private'], //          RFC 1918
  ['100.64.0.0', 10, 'private'], //       RFC 6598 carrier-grade NAT
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'], //   incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12, 'private'], //       RFC 1918
  ['192.0.0.0', 24, 'reserved'], //       IETF protocol assignments
  ['192.0.2.0', 24, 'reserved'], //       TEST-NET-1
  ['192.168.0.0', 16, 'private'], //      RFC 1918
  ['198.18.0.0', 15, 'reserved'], //      benchmarking
  ['198.51.100.0', 24, 'reserved'], //    TEST-NET-2
  ['203.0.113.0', 24, 'reserved'], //     TEST-NET-3
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'], //        incl. 255.255.255.255 broadcast
];

const ipv4ToInt = (ip) =>
  ip.split('.').reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0);

const classifyIpv4 = (ip) => {
  const value = ipv4ToInt(ip);
  for (const [network, prefix, label] of BLOCKED_IPV4_RANGES) {
    const mask = (~0 << (32 - prefix)) >>> 0;
    if (((value & mask) >>> 0) === ((ipv4ToInt(network) & mask) >>> 0)) return label;
  }
  return null;
};

/** Expands an IPv6 address into its eight 16-bit groups. */
const expandIpv6 = (ip) => {
  let address = ip.toLowerCase();
  // Convert a trailing embedded IPv4 (e.g. ::ffff:10.0.0.1) into two groups.
  const embedded = address.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) {
    const v = ipv4ToInt(embedded[1]);
    address = address.slice(0, -embedded[1].length)
      + `${(v >>> 16).toString(16)}:${(v & 0xffff).toString(16)}`;
  }
  const [head, tail] = address.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const groups = tail !== undefined
    ? [...headGroups, ...Array(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups]
    : headGroups;
  return groups.map((g) => parseInt(g, 16) || 0);
};

const embeddedIpv4 = (g) => [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.');

const classifyIpv6 = (ip) => {
  const g = expandIpv6(ip);

  if (g.every((x) => x === 0)) return 'reserved'; //                            ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback'; //  ::1

  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64
  // (64:ff9b::a.b.c.d) addresses reach the embedded IPv4 host.
  const zeroPrefix = g.slice(0, 5).every((x) => x === 0);
  if (zeroPrefix && (g[5] === 0xffff || g[5] === 0)) return classifyIpv4(embeddedIpv4(g));
  if (g[0] === 0x0064 && g[1] === 0xff9b) return classifyIpv4(embeddedIpv4(g));

  if ((g[0] & 0xfe00) === 0xfc00) return 'private'; //      fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local'; //   fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return 'private'; //      fec0::/10 site-local
  if ((g[0] & 0xff00) === 0xff00) return 'multicast'; //    ff00::/8
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'reserved'; // documentation
  return null;
};

/**
 * Returns a label ('private', 'loopback', 'link-local', ...) when `ip` is not
 * a public unicast address, `null` when it is public, or 'invalid' for
 * non-IP input.
 *
 * @param {string} ip
 * @returns {string|null}
 */
const classifyIpAddress = (ip) => {
  const family = net.isIP(ip);
  if (family === 4) return classifyIpv4(ip);
  if (family === 6) return classifyIpv6(ip);
  return 'invalid';
};

const blockedMessage = (label, rawUrl, detail = '') =>
  `Webhook URL targets a ${label} address${detail} (SSRF blocked): ${rawUrl}`;

/**
 * Synchronous URL check: scheme, embedded credentials, localhost aliases and
 * IP literals. Returns an error message when the URL must be blocked, or
 * `null`. Hostnames are not resolved here; see {@link assertSafeWebhookUrl}.
 *
 * @param {string} rawUrl
 * @returns {string|null}
 */
const detectSsrfTarget = (rawUrl) => {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return `Webhook URL is not a valid URL: ${rawUrl}`;
  }

  // Only HTTPS is permitted; reject http://, file://, ftp://, gopher://, etc.
  if (parsed.protocol !== 'https:') {
    return `Webhook URL must use HTTPS (got ${parsed.protocol}): ${rawUrl}`;
  }

  if (parsed.username || parsed.password) {
    return `Webhook URL must not contain credentials: ${parsed.origin}`;
  }

  // WHATWG URL already normalises decimal/hex/octal IPv4 forms
  // (https://2130706433/ -> 127.0.0.1), so IP literals are canonical here.
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === 'localhost.localdomain'
  ) {
    return blockedMessage('loopback', rawUrl, ' (localhost)');
  }

  if (net.isIP(hostname)) {
    const label = classifyIpAddress(hostname);
    if (label) return blockedMessage(label, rawUrl);
  }

  return null;
};

const buildSsrfError = (message) =>
  Object.assign(new Error(message), { code: SSRF_ERROR_CODE });

/**
 * Delivery-time URL validation. Runs {@link detectSsrfTarget}, then resolves
 * the hostname and rejects it if ANY resolved address is non-public, so a
 * public-looking hostname that points at 10.0.0.5 is refused too.
 *
 * @param {string} rawUrl
 * @param {{ lookup?: Function }} [opts] DNS lookup override (tests)
 * @throws {Error} with `code === 'SSRF_BLOCKED'` when the URL is rejected
 */
const assertSafeWebhookUrl = async (rawUrl, { lookup = dns.promises.lookup } = {}) => {
  const syncError = detectSsrfTarget(rawUrl);
  if (syncError) throw buildSsrfError(syncError);

  const hostname = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) return; // IP literal already validated above.

  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw buildSsrfError(
      `Webhook URL host could not be resolved (${err.code || err.message}): ${rawUrl}`,
    );
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw buildSsrfError(`Webhook URL host resolved to no addresses: ${rawUrl}`);
  }

  for (const { address } of addresses) {
    const label = classifyIpAddress(address);
    if (label) {
      throw buildSsrfError(blockedMessage(label, rawUrl, ` via DNS (${hostname} -> ${address})`));
    }
  }
};

const sendWebhook = async (url, payload, secret) => {
  // ── SSRF guard ─────────────────────────────────────────────────────────────
  // Reject non-HTTPS schemes and private/loopback IP targets before opening
  // any connection, so the worker cannot be used as an SSRF proxy.
  // Hostnames are resolved and every address checked. Redirects are not
  // followed, so a 3xx cannot bounce the request to an internal target.
  await assertSafeWebhookUrl(url);
  const ssrfError = detectSsrfTarget(url);
  if (ssrfError) {
    throw Object.assign(new Error(ssrfError), {
      code: 'SSRF_BLOCKED',
      retryable: false,
    });
  }
  // ── end SSRF guard ─────────────────────────────────────────────────────────

  const rawBody = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = computeSignature(secret, timestamp, rawBody);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Canonical signature header — always sent.
        'X-Webhook-Signature': signature,
        // Deprecated alias kept for backward compatibility.
        // Scheduled for removal in ${WEBHOOK_SIGNATURE_ALIAS_REMOVAL_VERSION}
        // (${WEBHOOK_SIGNATURE_ALIAS_REMOVAL_DATE}). See docs/webhook-signature-verification.md.
        [WEBHOOK_SIGNATURE_ALIAS_HEADER]: signature,
        'X-Webhook-Timestamp': timestamp,
        // Deprecation notice surfaced to the receiving server.
        Deprecation: `X-Stellar-Tags-Signature; removal-version=${WEBHOOK_SIGNATURE_ALIAS_REMOVAL_VERSION}; removal-date=${WEBHOOK_SIGNATURE_ALIAS_REMOVAL_DATE}`,
      },
      body: rawBody,
      signal: controller.signal,
      redirect: 'manual',
    });
    if (!response.ok) {
      throw Object.assign(
        new Error(`Webhook responded with HTTP ${response.status}`),
        {
          retryable: [429, 500, 502, 503, 504].includes(response.status),
        },
      );
    }
    return { ok: true };
  } finally {
    clearTimeout(timeoutId);
  }
};

const markWebhookSuccess = async (prisma, poolRunFn, webhookId, now) => {
  try {
    await prisma.webhook.update({
      where: { id: webhookId },
      data: { lastSentAt: now, failingSince: null },
    });
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error)) throw error;
    await poolRunFn(
      'UPDATE webhooks SET last_sent_at = $1, failing_since = NULL WHERE id = $2',
      [now.toISOString(), webhookId],
    );
  }
};

const markWebhookFailure = async (prisma, poolRunFn, webhookId, now) => {
  try {
    const current = await prisma.webhook.findUnique({
      where: { id: webhookId },
      select: { failingSince: true },
    });
    await prisma.webhook.update({
      where: { id: webhookId },
      data: {
        lastSentAt: now,
        failingSince: current?.failingSince || now,
      },
    });
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error)) throw error;
    await poolRunFn(
      `UPDATE webhooks
       SET last_sent_at = $1, failing_since = COALESCE(failing_since, $2)
       WHERE id = $3`,
      [now.toISOString(), now.toISOString(), webhookId],
    );
  }
};

/**
 * Apply a payment intent status transition driven by a webhook event.
 *
 * All writes go through the guarded helper so illegal state machine jumps
 * (e.g. COMPLETED -> PROCESSING) are rejected with ApiError('CONFLICT')
 * instead of silently corrupting the payment record.
 *
 * @param {object} params
 * @param {object} params.prisma
 * @param {string} params.paymentIntentId
 * @param {string} params.nextStatus
 * @param {object} [params.data] extra fields to persist alongside the status
 * @returns {Promise<object>} the updated payment intent
 */
const applyWebhookPaymentIntentStatus = async ({
  prisma,
  paymentIntentId,
  nextStatus,
  data = {},
}) => {
  if (!paymentIntentId) {
    throw new Error('paymentIntentId is required to update payment intent status');
  }
  if (!Object.prototype.hasOwnProperty.call(VALID_TRANSITIONS, nextStatus)) {
    throw new Error(`Unknown payment intent status: ${nextStatus}`);
  }

  return updatePaymentIntentStatus(prisma, paymentIntentId, nextStatus, data);
};

const recordWebhookEventAttempt = async (prisma, webhook, payload) => {
  const serializedPayload = JSON.stringify(payload);
  let event = await prisma.webhookEvent.findFirst({
    where: {
      eventType: payload.event,
      payload: serializedPayload,
      merchantId: webhook.id,
    },
    select: { id: true },
  });

  if (!event) {
    event = await prisma.webhookEvent.create({
      data: {
        eventType: payload.event,
        payload: serializedPayload,
        merchantId: webhook.id,
      },
      select: { id: true },
    });
  }

  await prisma.webhookEvent.update({
    where: { id: event.id },
    data: {
      attemptCount: { increment: 1 },
      status: 'pending',
      lastError: null,
      deliveredAt: null,
    },
  });

  return event.id;
};

const markWebhookEventDeadLetter = async (prisma, webhook, payload, error) => {
  const event = await prisma.webhookEvent.findFirst({
    where: {
      eventType: payload.event,
      payload: JSON.stringify(payload),
      merchantId: webhook.id,
    },
    select: { id: true },
  });

  if (event) {
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { status: 'dead_letter', lastError: error.message },
    });
  }
};

const processWebhookJob = async (job, { prisma, poolRunFn }) => {
  const { webhook, payload } = job.data;
  const now = new Date();
  const webhookEventId = await recordWebhookEventAttempt(prisma, webhook, payload);

  try {
    await sendWebhook(webhook.url, payload, webhook.secret);
  } catch (error) {
    await prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: { lastError: error.message },
    });
    try {
      await markWebhookFailure(prisma, poolRunFn, webhook.id, now);
    } catch (databaseError) {
      logger.error(
        `[webhook-worker] Failed to mark failure for webhook ${webhook.id}: ${databaseError.message}`,
      );
    }

    if (error && error.code === SSRF_ERROR_CODE) {
      logger.warn(
        { webhookId: webhook.id, eventId: payload?.event_id, reason: error.message },
        `[webhook-worker] Delivery rejected for webhook ${webhook.id}: ${error.message}`,
      );
      // A disallowed URL never becomes deliverable by retrying, so fail the
      // job permanently instead of burning the retry budget.
      if (typeof UnrecoverableError === 'function') {
        throw Object.assign(new UnrecoverableError(error.message), { code: SSRF_ERROR_CODE });
      }
    }
    throw error;
  }

  await prisma.webhookEvent.update({
    where: { id: webhookEventId },
    data: { status: 'delivered', lastError: null, deliveredAt: now },
  });

  try {
    await markWebhookSuccess(prisma, poolRunFn, webhook.id, now);
  } catch (databaseError) {
    logger.error(
      `[webhook-worker] Failed to mark success for webhook ${webhook.id}: ${databaseError.message}`,
    );
  }

  logger.info(
    `[webhook-worker] Delivered event=${payload.event_id} webhook=${webhook.id} attempt=${job.attemptsMade + 1}`,
  );

  // If the event carries a payment intent status transition, apply it through
  // the guarded helper so illegal jumps are rejected with a CONFLICT error.
  const intentUpdate = payload?.data?.payment_intent;
  if (intentUpdate && intentUpdate.id && intentUpdate.status) {
    try {
      await applyWebhookPaymentIntentStatus({
        prisma,
        paymentIntentId: intentUpdate.id,
        nextStatus: intentUpdate.status,
        data: intentUpdate.data || {},
      });
      logger.info(
        `[webhook-worker] Payment intent ${intentUpdate.id} transitioned to ${intentUpdate.status}`,
      );
    } catch (error) {
      logger.error(
        `[webhook-worker] Rejected payment intent ${intentUpdate.id} transition to ${intentUpdate.status}: ${error.message}`,
      );
      throw error;
    }
  }
};

const getWebhookQueue = () => {
  if (!webhookQueue) {
    queueConnection = createRedisConnection();
    if (!queueConnection) {
      throw new Error('Redis is not configured (REDIS_URL is unset). Cannot create webhook queue.');
    }
    webhookQueue = new Queue(WEBHOOK_QUEUE_NAME, { connection: queueConnection });
    webhookQueue.on('error', (error) => {
      logger.error(`[webhook-queue] Redis error: ${error.message}`);
    });
  }
  return webhookQueue;
};

const startWebhookWorker = ({ prisma, poolRunFn }) => {
  if (webhookWorker) return webhookWorker;

  workerConnection = createRedisConnection();
  if (!workerConnection) {
    throw new Error('Redis is not configured (REDIS_URL is unset). Cannot start webhook worker.');
  }
  webhookWorker = new Worker(
    WEBHOOK_QUEUE_NAME,
    (job) => processWebhookJob(job, { prisma, poolRunFn }),
    {
      connection: workerConnection,
      concurrency: WEBHOOK_WORKER_CONCURRENCY,
      settings: {
        backoffStrategy: (attemptsMade, _type, error) =>
          error?.retryable === false ? -1 : computeRetryDelay(attemptsMade),
      },
    },
  );

  webhookWorker.on('failed', async (job, error) => {
    const maxAttempts = job?.opts?.attempts || MAX_WEBHOOK_ATTEMPTS;
    const attemptsMade = job?.attemptsMade ?? 1;

    if (
      (attemptsMade >= maxAttempts || error?.retryable === false) &&
      job?.data?.webhook
    ) {
      logger.error(`[webhook-worker] Delivery failed job=${job?.id || 'unknown'}: ${error.message}; retries exhausted (${attemptsMade}/${maxAttempts})`);
      try {
        await moveToDLQ(prisma, poolRunFn, job.data.webhook, error);
      } catch (dlqErr) {
        logger.error(`[webhook-worker] Failed to move webhook ${job.data.webhook.id} to DLQ: ${dlqErr.message}`);
      }
      try {
        await markWebhookEventDeadLetter(
          prisma,
          job.data.webhook,
          job.data.payload,
          error,
        );
      } catch (eventErr) {
        logger.error(`[webhook-worker] Failed to mark event dead letter for job=${job?.id || 'unknown'}: ${eventErr.message}`);
      }
    } else {
      const nextDelayMs = computeRetryDelay(attemptsMade + 1);
      logger.error(
        `[webhook-worker] Delivery failed job=${job?.id || 'unknown'}: ${error.message}; ` +
        `retry scheduled in ${nextDelayMs}ms (${attemptsMade}/${maxAttempts})`,
      );
    }
  });

  webhookWorker.on('error', (error) => {
    logger.error(`[webhook-worker] Redis error: ${error.message}`);
  });

  logger.info(
    `[webhook-worker] Started queue=${WEBHOOK_QUEUE_NAME} concurrency=${WEBHOOK_WORKER_CONCURRENCY}`,
  );
  return webhookWorker;
};

const buildJobId = (webhookId, eventId) => {
  return crypto.createHash('sha256').update(`${webhookId}:${eventId}`).digest('hex');
};

const enqueueWebhookDelivery = async (webhook, payload, queue = getWebhookQueue()) => {
  return queue.add(
    'deliver',
    { webhook, payload },
    {
      ...WEBHOOK_JOB_OPTIONS,
      backoff: { ...WEBHOOK_JOB_OPTIONS.backoff },
      jobId: buildJobId(webhook.id, payload.event_id),
    },
  );
};

const formatAsset = (payment) => {
  if (!payment || payment.asset_type === 'native') return 'native';
  return `${payment.asset_code}:${payment.asset_issuer}`;
};

const dispatchPaymentWebhooks = async ({ prisma, poolGetFn, payment, queue }) => {
  if (!payment || (payment.type !== 'payment' && payment.type_i !== 1)) return;

  const recipientAddress = payment.to;
  if (!recipientAddress) return;

  const webhooks = await fetchWebhooksForAddress(prisma, poolGetFn, recipientAddress);
  if (!webhooks.length) return;

  const payload = {
    event: 'payment.received',
    event_id: `${payment.transaction_hash || ''}-${payment.id || crypto.randomBytes(8).toString('hex')}`,
    timestamp: new Date().toISOString(),
    network: process.env.HORIZON_NETWORK || 'testnet',
    data: {
      transaction_hash: payment.transaction_hash || null,
      from: payment.from || null,
      to: recipientAddress,
      amount: payment.amount || null,
      asset: formatAsset(payment),
      asset_type: payment.asset_type || 'native',
      asset_code: payment.asset_code || null,
      asset_issuer: payment.asset_issuer || null,
      created_at: payment.created_at || null,
      paging_token: payment.paging_token || null,
      metadata: payment.metadata ?? null,
    },
  };

  const deliveryQueue = queue || getWebhookQueue();
  await Promise.all(webhooks.map(async (webhook) => {
    if (!webhookEventMatches(webhook, payload.event)) {
      logger.info(`[webhook-worker] Skipping webhook id=${webhook.id} url=${webhook.url} for event=${payload.event} due to subscription filter`);
      return;
    }
    await enqueueWebhookDelivery(webhook, payload, deliveryQueue);
    logger.info(
      `[webhook-queue] Enqueued event=${payload.event_id} webhook=${webhook.id} recipient=${recipientAddress}`,
    );
  }));
};

const closeWebhookQueue = async () => {
  const resources = [webhookWorker, webhookQueue].filter(Boolean);
  await Promise.all(resources.map((resource) => resource.close()));

  const connections = [workerConnection, queueConnection].filter(Boolean);
  await Promise.all(connections.map((connection) => connection.quit()));

  webhookWorker = undefined;
  webhookQueue = undefined;
  workerConnection = undefined;
  queueConnection = undefined;
};

// ── Dead Letter Queue (DLQ) ──────────────────────────────────────────────

/**
 * Move a permanently-failed webhook delivery to the dead-letter queue.
 * The webhook row itself is left intact so the user can re-register if needed;
 * only the delivery record is preserved for manual replay.
 */
const moveToDLQ = async (prisma, poolRunFn, webhook, lastError = null) => {
  const payload = {
    event: 'webhook.delivery_failed',
    event_id: `dlq-${webhook.id}-${crypto.randomBytes(8).toString('hex')}`,
    timestamp: new Date().toISOString(),
    data: {
      webhook_id: webhook.id,
      webhook_url: webhook.url,
      username: webhook.username,
      failing_since: webhook.failingSince ? (webhook.failingSince instanceof Date
        ? webhook.failingSince
        : new Date(webhook.failingSince)
      ).toISOString() : null,
    },
  };

  const now = new Date();
  try {
    await prisma.webhookDLQ.create({
      data: {
        webhookId: webhook.id,
        webhookUrl: webhook.url,
        webhookSecret: webhook.secret,
        username: webhook.username,
        eventType: payload.event,
        eventPayload: JSON.stringify(payload),
        failureReason: `Delivery exhausted after ${MAX_WEBHOOK_ATTEMPTS} attempts`,
        deliveryAttempts: 0,
        movedAt: now,
        replayed: false,
      },
    });
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error)) throw error;
    await poolRunFn(
      `INSERT INTO webhook_dlq
         (id, webhook_id, webhook_url, webhook_secret, username,
          event_type, event_payload, failure_reason, delivery_attempts, moved_at, replayed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, FALSE)`,
      [
        `dlq-${webhook.id}-${crypto.randomBytes(8).toString('hex')}`,
        webhook.id,
        webhook.url,
        webhook.secret,
        webhook.username,
        payload.event,
        JSON.stringify(payload),
        `Delivery exhausted after ${MAX_WEBHOOK_ATTEMPTS} attempts`,
        now.toISOString(),
      ],
    );
  }

  // Clear failingSince on the webhook so it's not repeatedly moved to DLQ.
  // The webhook stays registered; a new payment will retry fresh.
  await markWebhookSuccess(prisma, poolRunFn, webhook.id, now);

  const lastError = lastError && lastError.message ? lastError.message : (lastError ? String(lastError) : null);

  // Emit a structured warning so operators can alert on DLQ transitions
  // without polling the DLQ API.
  logger.warn('Webhook moved to DLQ', {
    webhookId: webhook.id,
    eventId: payload.event_id,
    username: webhook.username,
    url: webhook.url,
    lastError,
  });

  // Optionally notify an external operator endpoint when configured. Failures
  // here must never prevent the DLQ write from succeeding, so they are
  // swallowed and logged.
  const notifyUrl = process.env.WEBHOOK_DLQ_NOTIFY_URL;
  if (notifyUrl && typeof fetch === 'function') {
    try {
      await fetch(notifyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'webhook.dlq',
          webhookId: webhook.id,
          eventId: payload.event_id,
          username: webhook.username,
          url: webhook.url,
          lastError,
          movedAt: now.toISOString(),
        }),
      });
    } catch (notifyErr) {
      logger.error(`[webhook-worker] Failed to POST DLQ notification: ${notifyErr.message}`);
    }
  }
};

/**
 * List dead-letter-queue entries with optional username filter and pagination.
 */
const listDLQEntries = async (prisma, poolAllFn, opts = {}) => {
  const { username, limit = 50, offset = 0 } = opts;
  try {
    const where = username
      ? { username: { equals: username, mode: 'insensitive' } }
      : {};

    const [entries, total] = await prisma.$transaction([
      prisma.webhookDLQ.findMany({
        where,
        orderBy: { movedAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      prisma.webhookDLQ.count({ where }),
    ]);

    return { entries, total };
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error)) throw error;
    let rows;
    let countRow;
    if (username) {
      rows = await poolAllFn(
        `SELECT * FROM webhook_dlq WHERE username = $1
         ORDER BY moved_at DESC LIMIT $2 OFFSET $3`,
        [username, limit, offset],
      );
      countRow = await poolAllFn(
        'SELECT COUNT(*) AS total FROM webhook_dlq WHERE username = $1',
        [username],
      );
    } else {
      rows = await poolAllFn(
        `SELECT * FROM webhook_dlq ORDER BY moved_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      countRow = await poolAllFn(
        'SELECT COUNT(*) AS total FROM webhook_dlq',
        [],
      );
    }
    return {
      entries: (rows || []).map((r) => ({
        ...r,
        movedAt: r.moved_at ? new Date(r.moved_at) : null,
        replayedAt: r.replayed_at ? new Date(r.replayed_at) : null,
      })),
      total: Number(countRow?.[0]?.total || 0),
    };
  }
};

/**
 * Replay a single DLQ entry.
 */
const replayFromDLQ = async (prisma, poolRunFn, dqlId) => {
  let entry;
  try {
    entry = await prisma.webhookDLQ.findUnique({
      where: { id: dqlId },
    });
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error)) throw error;
    const rows = await poolRunFn(
      'SELECT * FROM webhook_dlq WHERE id = $1 LIMIT 1',
      [dqlId],
    );
    entry = rows?.[0] || null;
  }

  if (!entry) {
    return { ok: false, error: 'DLQ entry not found' };
  }
  if (entry.replayed) {
    return { ok: false, error: 'DLQ entry has already been replayed' };
  }

  const payload = typeof entry.eventPayload === 'string'
    ? JSON.parse(entry.eventPayload)
    : entry.eventPayload;
  const secret = entry.webhookSecret;

  try {
    await sendWebhook(entry.webhookUrl, payload, secret);
    const now = new Date();
    try {
      await prisma.webhookDLQ.update({
        where: { id: dqlId },
        data: { replayed: true, replayedAt: now },
      });
    } catch (err) {
      if (!shouldFallbackToLocalRegistry(err)) throw err;
      await poolRunFn(
        'UPDATE webhook_dlq SET replayed = TRUE, replayed_at = $1 WHERE id = $2',
        [now.toISOString(), dqlId],
      );
    }
    logger.info(`[webhook-worker] DLQ entry ${dqlId} replayed successfully`);
    return { ok: true };
  } catch (err) {
    try {
      await prisma.webhookDLQ.update({
        where: { id: dqlId },
        data: { deliveryAttempts: (entry.deliveryAttempts || 0) + 1 },
      });
    } catch (dbErr) {
      if (!shouldFallbackToLocalRegistry(dbErr)) {
        logger.error(`[webhook-worker] Failed to update DLQ attempt count for ${dqlId}: ${dbErr.message}`);
      } else {
        await poolRunFn(
          'UPDATE webhook_dlq SET delivery_attempts = delivery_attempts + 1 WHERE id = $1',
          [dqlId],
        );
      }
    }
    logger.error(`[webhook-worker] DLQ replay failed for ${dqlId}: ${err.message}`);
    return { ok: false, error: err.message };
  }
};

module.exports = {
  dispatchPaymentWebhooks,
  enqueueWebhookDelivery,
  startWebhookWorker,
  closeWebhookQueue,
  processWebhookJob,
  applyWebhookPaymentIntentStatus,
  sendWebhook,
  computeSignature,
  detectSsrfTarget,
  assertSafeWebhookUrl,
  classifyIpAddress,
  SSRF_ERROR_CODE,
  computeRetryDelay,
  WEBHOOK_TIMEOUT_MS,
  WEBHOOK_QUEUE_NAME,
  MAX_WEBHOOK_ATTEMPTS,
  WEBHOOK_RETRY_BASE_MS,
  WEBHOOK_RETRY_MAX_MS,
  WEBHOOK_RETRY_FACTOR,
  WEBHOOK_RETRY_JITTER,
  WEBHOOK_SIGNATURE_ALIAS_HEADER,
  WEBHOOK_SIGNATURE_ALIAS_REMOVAL_VERSION,
  WEBHOOK_SIGNATURE_ALIAS_REMOVAL_DATE,
  WEBHOOK_JOB_OPTIONS,
  MAX_RETRY_BACKLOG_DAYS,
  getWebhooksExhaustedRetries,
  moveToDLQ,
  listDLQEntries,
  replayFromDLQ,
};
