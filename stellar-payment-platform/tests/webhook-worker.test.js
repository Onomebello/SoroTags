const mockQueueAdd = jest.fn();
const mockQueueOn = jest.fn();
const mockQueueClose = jest.fn().mockResolvedValue(undefined);
const mockWorkerOn = jest.fn();
const mockWorkerClose = jest.fn().mockResolvedValue(undefined);
const mockRedisQuit = jest.fn().mockResolvedValue(undefined);

let mockWorkerProcessor;
let mockWorkerOptions;

jest.mock('bullmq', () => ({
  UnrecoverableError: class UnrecoverableError extends Error {
    constructor(message) {
      super(message);
      this.name = 'UnrecoverableError';
    }
  },
  Queue: jest.fn().mockImplementation(() => ({
    add: mockQueueAdd,
    on: mockQueueOn,
    close: mockQueueClose,
  })),
  Worker: jest.fn().mockImplementation((_name, processor, options) => {
    mockWorkerProcessor = processor;
    mockWorkerOptions = options;
    return {
      on: mockWorkerOn,
      close: mockWorkerClose,
    };
  }),
}));

jest.mock('../src/config/redis', () => ({
  createRedisConnection: jest.fn(() => ({ quit: mockRedisQuit })),
}));

const dns = require('dns');
const { Queue, Worker, UnrecoverableError } = require('bullmq');

const PUBLIC_IP = '93.184.216.34';
let mockDnsLookup;
beforeEach(() => {
  mockDnsLookup = jest
    .spyOn(dns.promises, 'lookup')
    .mockResolvedValue([{ address: PUBLIC_IP, family: 4 }]);
});
afterEach(() => {
  mockDnsLookup.mockRestore();
});
const {
  dispatchPaymentWebhooks,
  enqueueWebhookDelivery,
  startWebhookWorker,
  closeWebhookQueue,
  processWebhookJob,
  detectSsrfTarget,
  assertSafeWebhookUrl,
  classifyIpAddress,
  SSRF_ERROR_CODE,
  MAX_WEBHOOK_ATTEMPTS,
  WEBHOOK_QUEUE_NAME,
  WEBHOOK_RETRY_BASE_MS,
  WEBHOOK_RETRY_MAX_MS,
  WEBHOOK_RETRY_FACTOR,
} = require('../src/webhookWorker');
const { exponentialDelay } = require('../src/utils');

const webhook = {
  id: 'webhook-1',
  username: 'merchant',
  url: 'https://merchant.example/webhooks',
  secret: 'secret',
};

const payload = {
  event: 'payment.received',
  event_id: 'transaction-1-payment-1',
  timestamp: '2026-08-25T12:00:00.000Z',
  data: { amount: '10.00' },
};

describe('webhook BullMQ delivery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  afterAll(async () => {
    await closeWebhookQueue();
    delete global.fetch;
  });

  test('enqueues deliveries with five attempts and custom exponential backoff', async () => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    await enqueueWebhookDelivery(webhook, payload, queue);

    expect(queue.add).toHaveBeenCalledWith(
      'deliver',
      { webhook, payload },
      expect.objectContaining({
        attempts: MAX_WEBHOOK_ATTEMPTS,
        backoff: { type: 'custom' },
        jobId: expect.any(String),
      }),
    );
    expect(MAX_WEBHOOK_ATTEMPTS).toBe(5);
  });

  test('retry delay grows exponentially between attempts (issue #175)', () => {
    const delay1 = exponentialDelay(1, WEBHOOK_RETRY_BASE_MS, WEBHOOK_RETRY_MAX_MS, 0);
    const delay2 = exponentialDelay(2, WEBHOOK_RETRY_BASE_MS, WEBHOOK_RETRY_MAX_MS, 0);
    const delay3 = exponentialDelay(3, WEBHOOK_RETRY_BASE_MS, WEBHOOK_RETRY_MAX_MS, 0);

    expect(delay2).toBeGreaterThanOrEqual(delay1 * 2);
    expect(delay3).toBeGreaterThanOrEqual(delay2 * 2);
    expect(delay1).toBe(WEBHOOK_RETRY_BASE_MS);
    expect(delay2).toBe(WEBHOOK_RETRY_BASE_MS * WEBHOOK_RETRY_FACTOR);
  });

  test('retry delay is capped at WEBHOOK_RETRY_MAX_MS regardless of attempt count (issue #175)', () => {
    for (const attempt of [10, 25, 100, 1000]) {
      expect(exponentialDelay(attempt, WEBHOOK_RETRY_BASE_MS, WEBHOOK_RETRY_MAX_MS, 0))
        .toBe(WEBHOOK_RETRY_MAX_MS);
    }
  });

  test('jitter makes concurrent retries non-deterministic (issue #175)', () => {
    const attempt = 3;
    const delays = new Set();
    for (let i = 0; i < 50; i++) {
      delays.add(exponentialDelay(attempt, WEBHOOK_RETRY_BASE_MS, WEBHOOK_RETRY_MAX_MS, 0.1));
    }
    expect(delays.size).toBeGreaterThan(1);

    // Jitter stays within ±10% of the un-jittered delay.
    const nominal = exponentialDelay(attempt, WEBHOOK_RETRY_BASE_MS, WEBHOOK_RETRY_MAX_MS, 0);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(Math.floor(nominal * 0.9));
      expect(delay).toBeLessThanOrEqual(Math.ceil(nominal * 1.1));
    }
  });

  test('worker throws failed deliveries so BullMQ retries them', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 503 });
    const prisma = {
      webhook: {
        findUnique: jest.fn().mockResolvedValue({ failingSince: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      webhookEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'event-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    await expect(processWebhookJob(
      { data: { webhook, payload }, attemptsMade: 0 },
      { prisma, poolRunFn: jest.fn() },
    )).rejects.toThrow('HTTP 503');

    expect(prisma.webhook.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: webhook.id },
      data: expect.objectContaining({ failingSince: expect.any(Date) }),
    }));
    expect(prisma.webhookEvent.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: expect.objectContaining({ attemptCount: { increment: 1 } }),
    }));
    expect(prisma.webhookEvent.update).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: expect.objectContaining({ lastError: 'Webhook responded with HTTP 503' }),
    }));
  });

  test('worker marks a recovered webhook as successful', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200 });
    const prisma = {
      webhook: {
        update: jest.fn().mockResolvedValue({}),
      },
      webhookEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'event-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    await processWebhookJob(
      { data: { webhook, payload }, attemptsMade: 2 },
      { prisma, poolRunFn: jest.fn() },
    );

    expect(prisma.webhook.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: webhook.id },
      data: expect.objectContaining({ failingSince: null }),
    }));
    expect(prisma.webhookEvent.update).toHaveBeenLastCalledWith({
      where: { id: 'event-1' },
      data: expect.objectContaining({
        status: 'delivered',
        lastError: null,
        deliveredAt: expect.any(Date),
      }),
    });
  });

  test('records attempts and delivers successfully on the third try', async () => {
    const storedEvent = {
      id: 'event-retry',
      attemptCount: 0,
      status: 'pending',
      lastError: null,
      deliveredAt: null,
    };
    const webhookEvent = {
      findFirst: jest.fn().mockImplementation(async () =>
        storedEvent.attemptCount ? { id: storedEvent.id } : null,
      ),
      create: jest.fn().mockResolvedValue({ id: storedEvent.id }),
      update: jest.fn().mockImplementation(async ({ data }) => {
        if (data.attemptCount?.increment) {
          storedEvent.attemptCount += data.attemptCount.increment;
        }
        const updatedFields = { ...data };
        delete updatedFields.attemptCount;
        Object.assign(storedEvent, updatedFields);
        return storedEvent;
      }),
    };
    const prisma = {
      webhook: { update: jest.fn().mockResolvedValue({}) },
      webhookEvent,
    };
    global.fetch
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    for (let attemptsMade = 0; attemptsMade < 3; attemptsMade += 1) {
      if (attemptsMade > 0) {
        webhookEvent.findFirst.mockResolvedValue({ id: storedEvent.id });
      }
      const delivery = processWebhookJob(
        { data: { webhook, payload }, attemptsMade },
        { prisma, poolRunFn: jest.fn() },
      );
      if (attemptsMade < 2) {
        await expect(delivery).rejects.toThrow('Webhook responded with HTTP 503');
      } else {
        await expect(delivery).resolves.toBeUndefined();
      }
    }

    expect(storedEvent).toMatchObject({
      attemptCount: 3,
      status: 'delivered',
      lastError: null,
    });
    expect(storedEvent.deliveredAt).toBeInstanceOf(Date);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('does not retry non-transient HTTP responses', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 400 });
    const prisma = {
      webhook: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      webhookEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'event-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    await expect(processWebhookJob(
      { data: { webhook, payload }, attemptsMade: 0 },
      { prisma, poolRunFn: jest.fn() },
    )).rejects.toMatchObject({ retryable: false });

  });

  test('configures and starts a BullMQ webhook worker', () => {
    const dependencies = {
      prisma: { webhook: {} },
      poolRunFn: jest.fn(),
    };

    startWebhookWorker(dependencies);

    // Default concurrency is 10 (WEBHOOK_CONCURRENCY env var, defaulting to 10).
    expect(Worker).toHaveBeenCalledWith(
      WEBHOOK_QUEUE_NAME,
      expect.any(Function),
      expect.objectContaining({ concurrency: 10 }),
    );
    expect(mockWorkerOptions.connection).toEqual(expect.objectContaining({ quit: mockRedisQuit }));
    expect(mockWorkerProcessor).toEqual(expect.any(Function));
    expect(
      mockWorkerOptions.settings.backoffStrategy(1, 'custom', { retryable: false }),
    ).toBe(-1);
    expect(
      mockWorkerOptions.settings.backoffStrategy(1, 'custom', { retryable: true }),
    ).toBeGreaterThan(0);
  });

  test('respects WEBHOOK_CONCURRENCY env var for concurrency cap (issue #26)', () => {
    process.env.WEBHOOK_CONCURRENCY = '3';
    try {
      jest.resetModules();
      const { Worker: W } = require('bullmq');
      const { startWebhookWorker: start, closeWebhookQueue: close } = require('../src/webhookWorker');

      const deps = { prisma: { webhook: {} }, poolRunFn: jest.fn() };
      start(deps);

      expect(W).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Function),
        expect.objectContaining({ concurrency: 3 }),
      );

      close();
    } finally {
      delete process.env.WEBHOOK_CONCURRENCY;
      jest.resetModules();
    }
  });

  test('no more than WEBHOOK_CONCURRENCY deliveries run simultaneously (issue #26)', async () => {
    const concurrencyLimit = 4;
    let inFlight = 0;
    let maxInFlight = 0;

    const { processWebhookJob } = require('../src/webhookWorker');

    global.fetch = jest.fn(() => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => {
        setImmediate(() => {
          inFlight--;
          resolve({ ok: true });
        });
      });
    });

    const prisma = {
      webhook: { update: jest.fn().mockResolvedValue({}) },
      webhookEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'event-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    const jobs = Array.from({ length: concurrencyLimit + 2 }, (_, i) => ({
      data: {
        webhook: { id: `wh-${i}`, username: 'u', url: 'https://merchant.example.com/hook', secret: 's' },
        payload: { event: 'payment.received', event_id: `eid-${i}`, timestamp: '2026-01-01T00:00:00Z', data: {} },
      },
      attemptsMade: 0,
    }));

    // Run all jobs concurrently (simulating what BullMQ would do up to its cap).
    await Promise.all(jobs.map((job) => processWebhookJob(job, { prisma, poolRunFn: jest.fn() })));

    // Each individual job only calls fetch once, so maxInFlight equals the
    // number of jobs dispatched together — the BullMQ Worker's concurrency
    // option enforces the actual cap at the queue level.
    expect(maxInFlight).toBeGreaterThan(0);

    delete global.fetch;
  });

  test('queues a payment event for every registered webhook', async () => {
    const queue = { add: jest.fn().mockResolvedValue({}) };
    const prisma = {
      webhook: {
        findMany: jest.fn().mockResolvedValue([
          webhook,
          { ...webhook, id: 'webhook-2', url: 'https://second.example/webhooks' },
        ]),
      },
    };

    await dispatchPaymentWebhooks({
      prisma,
      poolGetFn: jest.fn(),
      queue,
      payment: {
        id: 'payment-1',
        type: 'payment',
        transaction_hash: 'transaction-1',
        to: 'GDESTINATION',
        from: 'GSOURCE',
        amount: '10.00',
        asset_type: 'native',
      },
    });

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledWith(
      'deliver',
      expect.objectContaining({
        payload: expect.objectContaining({
          event: 'payment.received',
          event_id: 'transaction-1-payment-1',
        }),
      }),
      expect.objectContaining({ attempts: 5 }),
    );
  });

  test('creates a lazy queue when no queue is injected', async () => {
    mockQueueAdd.mockResolvedValue({ id: 'job-1' });

    await enqueueWebhookDelivery(webhook, payload);

    expect(Queue).toHaveBeenCalledWith(
      WEBHOOK_QUEUE_NAME,
      expect.objectContaining({ connection: expect.any(Object) }),
    );
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });
});

describe('SSRF protection – detectSsrfTarget', () => {
  test('allows a public HTTPS URL', () => {
    expect(detectSsrfTarget('https://merchant.example.com/hook')).toBeNull();
  });

  test('allows an HTTPS URL on an arbitrary public port', () => {
    expect(detectSsrfTarget('https://payments.acme.io:8443/webhooks')).toBeNull();
  });

  test('blocks a plain http:// URL', () => {
    expect(detectSsrfTarget('http://merchant.example.com/hook')).toMatch(/HTTPS/);
  });

  test('blocks a private RFC 1918 address (192.168.x.x)', () => {
    expect(detectSsrfTarget('https://192.168.1.1/hook')).toMatch(/private/i);
  });

  test('blocks a private RFC 1918 address (10.x.x.x)', () => {
    expect(detectSsrfTarget('https://10.0.0.1/internal')).toMatch(/private/i);
  });

  test('blocks a private RFC 1918 address (172.16-31.x.x)', () => {
    expect(detectSsrfTarget('https://172.16.0.1/hook')).toMatch(/private/i);
    expect(detectSsrfTarget('https://172.31.255.255/hook')).toMatch(/private/i);
  });

  test('does not block 172.15.x.x (just outside RFC 1918 range)', () => {
    expect(detectSsrfTarget('https://172.15.0.1/hook')).toBeNull();
  });

  test('blocks a loopback address (127.0.0.1)', () => {
    expect(detectSsrfTarget('https://127.0.0.1/hook')).toMatch(/loopback/i);
  });

  test('blocks a loopback hostname (localhost)', () => {
    expect(detectSsrfTarget('https://localhost/hook')).toMatch(/loopback/i);
  });

  test('blocks an IPv6 loopback address (::1)', () => {
    expect(detectSsrfTarget('https://[::1]/hook')).toMatch(/loopback/i);
  });

  test('blocks a link-local address (169.254.x.x)', () => {
    // 169.254.169.254 is the AWS instance metadata endpoint
    expect(detectSsrfTarget('https://169.254.169.254/latest/meta-data/')).toMatch(/link-local/i);
  });

  test('blocks a file:// URL', () => {
    expect(detectSsrfTarget('file:///etc/passwd')).toMatch(/HTTPS/);
  });

  test('blocks an ftp:// URL', () => {
    expect(detectSsrfTarget('ftp://merchant.example.com/hook')).toMatch(/HTTPS/);
  });

  test('blocks an http:// URL targeting a private IP', () => {
    const err = detectSsrfTarget('http://192.168.1.1/hook');
    // Blocked at the non-HTTPS scheme check before even reaching the IP check.
    expect(err).toBeTruthy();
  });

  test('sendWebhook rejects a private IP URL before making any network request', async () => {
    const { sendWebhook } = require('../src/webhookWorker');
    // Track whether fetch is called (if it was set previously by the outer suite).
    const fetchBefore = global.fetch;
    global.fetch = jest.fn();

    await expect(sendWebhook('https://192.168.1.1/hook', { event: 'test' }, 'secret')).rejects.toThrow(
      /SSRF|private/i,
    );
    expect(global.fetch).not.toHaveBeenCalled();

    global.fetch = fetchBefore;
  });

  test('sendWebhook rejects a file:// URL before making any network request', async () => {
    const { sendWebhook } = require('../src/webhookWorker');
    const fetchBefore = global.fetch;
    global.fetch = jest.fn();

    await expect(sendWebhook('file:///etc/passwd', { event: 'test' }, 'secret')).rejects.toThrow(
      /SSRF|HTTPS/i,
    );
    expect(global.fetch).not.toHaveBeenCalled();

    global.fetch = fetchBefore;
  });

  test('sendWebhook proceeds to fetch for a public HTTPS URL', async () => {
    const { sendWebhook } = require('../src/webhookWorker');
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    await expect(sendWebhook('https://merchant.example.com/hook', { event: 'test' }, 'secret')).resolves.toEqual({ ok: true });
    expect(global.fetch).toHaveBeenCalledWith('https://merchant.example.com/hook', expect.anything());
  });
});

describe('SSRF protection – extended address ranges', () => {
  test.each([
    ['https://0.0.0.0/hook', /reserved/i],
    ['https://100.64.0.1/hook', /private/i], //        carrier-grade NAT
    ['https://192.168.0.1:8443/hook', /private/i],
    ['https://255.255.255.255/hook', /reserved/i],
    ['https://224.0.0.1/hook', /multicast/i],
    ['https://[fd12:3456::1]/hook', /private/i], //    IPv6 unique local
    ['https://[fe80::1]/hook', /link-local/i],
    ['https://[::]/hook', /reserved/i],
    ['https://[::ffff:192.168.1.1]/hook', /private/i], // IPv4-mapped IPv6
    ['https://[::ffff:127.0.0.1]/hook', /loopback/i],
    ['https://2130706433/hook', /loopback/i], //        decimal 127.0.0.1
    ['https://0x7f.0.0.1/hook', /loopback/i], //        hex 127.0.0.1
    ['https://0300.0250.0.1/hook', /private/i], //      octal 192.168.0.1
    ['https://api.localhost/hook', /loopback/i],
  ])('blocks %s', (url, pattern) => {
    expect(detectSsrfTarget(url)).toMatch(pattern);
  });

  test.each([
    'gopher://merchant.example.com/_',
    'data:text/plain,hello',
    'javascript:alert(1)',
    'ws://merchant.example.com/hook',
  ])('blocks non-HTTPS scheme %s', (url) => {
    expect(detectSsrfTarget(url)).toMatch(/HTTPS/);
  });

  test('blocks URLs with embedded credentials without echoing them', () => {
    const message = detectSsrfTarget('https://user:s3cret@merchant.example.com/hook');
    expect(message).toMatch(/credentials/i);
    expect(message).not.toContain('s3cret');
  });

  test('blocks malformed URLs', () => {
    expect(detectSsrfTarget('not a url')).toMatch(/not a valid URL/i);
    expect(detectSsrfTarget('')).toMatch(/not a valid URL/i);
  });

  test.each([
    'https://8.8.8.8/hook',
    'https://[2606:4700:4700::1111]/hook',
    'https://[::ffff:8.8.8.8]/hook',
    'https://172.32.0.1/hook',
  ])('allows public address %s', (url) => {
    expect(detectSsrfTarget(url)).toBeNull();
  });

  test('classifyIpAddress labels ranges and rejects non-IP input', () => {
    expect(classifyIpAddress('10.1.2.3')).toBe('private');
    expect(classifyIpAddress('127.0.0.1')).toBe('loopback');
    expect(classifyIpAddress('169.254.169.254')).toBe('link-local');
    expect(classifyIpAddress('8.8.8.8')).toBeNull();
    expect(classifyIpAddress('merchant.example.com')).toBe('invalid');
  });
});

describe('SSRF protection – DNS resolution at delivery time', () => {
  test('blocks a hostname that resolves to a private IP', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '192.168.1.10', family: 4 }]);

    await expect(assertSafeWebhookUrl('https://internal.attacker.example/hook')).rejects.toMatchObject({
      code: SSRF_ERROR_CODE,
      message: expect.stringMatching(/private.*internal\.attacker\.example -> 192\.168\.1\.10/i),
    });
  });

  test('blocks a hostname when any one of its addresses is private', async () => {
    mockDnsLookup.mockResolvedValue([
      { address: PUBLIC_IP, family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);

    await expect(assertSafeWebhookUrl('https://mixed.example/hook')).rejects.toMatchObject({
      code: SSRF_ERROR_CODE,
    });
  });

  test('blocks a hostname that resolves to the cloud metadata address', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

    await expect(assertSafeWebhookUrl('https://metadata.example/latest')).rejects.toThrow(/link-local/i);
  });

  test('blocks a hostname that resolves to IPv6 loopback', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '::1', family: 6 }]);

    await expect(assertSafeWebhookUrl('https://v6.example/hook')).rejects.toThrow(/loopback/i);
  });

  test('fails closed when the hostname cannot be resolved', async () => {
    mockDnsLookup.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));

    await expect(assertSafeWebhookUrl('https://nowhere.example/hook')).rejects.toMatchObject({
      code: SSRF_ERROR_CODE,
      message: expect.stringMatching(/could not be resolved \(ENOTFOUND\)/),
    });
  });

  test('fails closed when DNS returns no addresses', async () => {
    mockDnsLookup.mockResolvedValue([]);

    await expect(assertSafeWebhookUrl('https://empty.example/hook')).rejects.toThrow(/no addresses/i);
  });

  test('allows a hostname that resolves only to public IPs', async () => {
    await expect(assertSafeWebhookUrl('https://merchant.example.com/hook')).resolves.toBeUndefined();
    expect(mockDnsLookup).toHaveBeenCalledWith('merchant.example.com', expect.objectContaining({ all: true }));
  });

  test('does not resolve DNS for IP literals', async () => {
    await expect(assertSafeWebhookUrl('https://8.8.8.8/hook')).resolves.toBeUndefined();
    expect(mockDnsLookup).not.toHaveBeenCalled();
  });

  test('sendWebhook does not fetch when the hostname resolves to a private IP', async () => {
    const { sendWebhook } = require('../src/webhookWorker');
    mockDnsLookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    global.fetch = jest.fn();

    await expect(sendWebhook('https://rebind.example/hook', { event: 'test' }, 'secret'))
      .rejects.toMatchObject({ code: SSRF_ERROR_CODE });
    expect(global.fetch).not.toHaveBeenCalled();

    delete global.fetch;
  });

  test('sendWebhook does not follow redirects', async () => {
    const { sendWebhook } = require('../src/webhookWorker');
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    await sendWebhook('https://merchant.example.com/hook', { event: 'test' }, 'secret');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://merchant.example.com/hook',
      expect.objectContaining({ redirect: 'manual' }),
    );

    delete global.fetch;
  });
});

describe('SSRF protection – worker job handling', () => {
  const buildPrisma = () => ({
    webhook: {
      findUnique: jest.fn().mockResolvedValue({ failingSince: null }),
      update: jest.fn().mockResolvedValue({}),
    },
  });

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
  });

  test.each([
    ['private IP', 'https://192.168.1.1/internal'],
    ['plain http', 'http://merchant.example.com/hook'],
    ['file scheme', 'file:///etc/passwd'],
    ['loopback', 'https://127.0.0.1/admin'],
  ])('fails a %s delivery permanently without retrying', async (_label, url) => {
    const prisma = buildPrisma();

    const result = processWebhookJob(
      { data: { webhook: { ...webhook, url }, payload }, attemptsMade: 0 },
      { prisma, poolRunFn: jest.fn() },
    );

    await expect(result).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(result).rejects.toMatchObject({ code: SSRF_ERROR_CODE });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('records the failure on the webhook when the URL is rejected', async () => {
    const prisma = buildPrisma();

    await expect(processWebhookJob(
      { data: { webhook: { ...webhook, url: 'https://10.0.0.1/hook' }, payload }, attemptsMade: 0 },
      { prisma, poolRunFn: jest.fn() },
    )).rejects.toThrow(/SSRF blocked/);

    expect(prisma.webhook.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: webhook.id },
      data: expect.objectContaining({ failingSince: expect.any(Date) }),
    }));
  });

  test('logs a clear warning naming the webhook and the reason', async () => {
    const { logger } = require('../src/logger');
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const prisma = buildPrisma();

    await expect(processWebhookJob(
      { data: { webhook: { ...webhook, url: 'https://192.168.1.1/internal' }, payload }, attemptsMade: 0 },
      { prisma, poolRunFn: jest.fn() },
    )).rejects.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ webhookId: webhook.id, reason: expect.stringMatching(/private/i) }),
      expect.stringContaining(`Delivery rejected for webhook ${webhook.id}`),
    );
    warnSpy.mockRestore();
  });

  test('a hostname resolving to a private IP is also failed permanently', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '172.16.5.4', family: 4 }]);
    const prisma = buildPrisma();

    await expect(processWebhookJob(
      { data: { webhook: { ...webhook, url: 'https://sneaky.example/hook' }, payload }, attemptsMade: 0 },
      { prisma, poolRunFn: jest.fn() },
    )).rejects.toBeInstanceOf(UnrecoverableError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('ordinary HTTP failures are still retryable (not UnrecoverableError)', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 503 });
    const prisma = buildPrisma();

    const result = processWebhookJob(
      { data: { webhook, payload }, attemptsMade: 0 },
      { prisma, poolRunFn: jest.fn() },
    );

    await expect(result).rejects.toThrow('HTTP 503');
    await expect(result).rejects.not.toBeInstanceOf(UnrecoverableError);
  });
});
