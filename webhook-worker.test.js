const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { processPendingWebhooks } = require('./webhookWorker');

let server;
let baseUrl;
let inFlight = 0;
let maxInFlight = 0;
let received = 0;

beforeEach(async () => {
  inFlight = 0;
  maxInFlight = 0;
  received = 0;
  server = http.createServer((req, res) => {
    inFlight += 1;
    received += 1;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    setTimeout(() => {
      inFlight -= 1;
      res.statusCode = 200;
      res.end('ok');
    }, 25);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function makeEvents(count) {
  const events = [];
  for (let i = 0; i < count; i += 1) {
    events.push({
      id: `evt_${i}`,
      url: `${baseUrl}/hook`,
      payload: { index: i },
    });
  }
  return events;
}

test('caps simultaneous deliveries at WEBHOOK_CONCURRENCY', async () => {
  const previous = process.env.WEBHOOK_CONCURRENCY;
  process.env.WEBHOOK_CONCURRENCY = '3';
  try {
    const events = makeEvents(12);
    await processPendingWebhooks(events);
    assert.strictEqual(received, 12);
    assert.ok(
      maxInFlight <= 3,
      `expected at most 3 concurrent deliveries, saw ${maxInFlight}`
    );
  } finally {
    if (previous === undefined) {
      delete process.env.WEBHOOK_CONCURRENCY;
    } else {
      process.env.WEBHOOK_CONCURRENCY = previous;
    }
  }
});

test('defaults to a concurrency cap of 10 when WEBHOOK_CONCURRENCY is unset', async () => {
  const previous = process.env.WEBHOOK_CONCURRENCY;
  delete process.env.WEBHOOK_CONCURRENCY;
  try {
    const events = makeEvents(25);
    await processPendingWebhooks(events);
    assert.strictEqual(received, 25);
    assert.ok(
      maxInFlight <= 10,
      `expected at most 10 concurrent deliveries, saw ${maxInFlight}`
    );
  } finally {
    if (previous !== undefined) {
      process.env.WEBHOOK_CONCURRENCY = previous;
    }
  }
});
