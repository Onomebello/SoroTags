'use strict';

const client = require('prom-client');

const register = new client.Registry();

client.collectDefaultMetrics({ register });

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const webhookDeliveriesTotal = new client.Counter({
  name: 'webhook_deliveries_total',
  help: 'Total number of webhook delivery attempts by outcome',
  labelNames: ['status'],
  registers: [register],
});

const webhookDeliveryDurationSeconds = new client.Histogram({
  name: 'webhook_delivery_duration_seconds',
  help: 'Webhook delivery duration in seconds',
  labelNames: ['status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const webhookDlqSize = new client.Gauge({
  name: 'webhook_dlq_size',
  help: 'Current number of webhook deliveries in the dead-letter queue',
  registers: [register],
});

const UNKNOWN_ROUTE = 'unknown';

/**
 * Normalize an Express request into a route pattern label.
 *
 * Uses `req.route.path` (the matched route pattern, e.g. `/users/:username/activity`)
 * rather than `req.path` (the concrete request path, e.g. `/users/alice/activity`) so
 * dynamic segments never leak actual values into metric labels. Requests that do not
 * match any route fall back to the `unknown` label.
 */
function normalizeRoute(req) {
  if (!req) return UNKNOWN_ROUTE;
  const routePath = req.route && req.route.path;
  if (typeof routePath === 'string' && routePath.length > 0) {
    return routePath;
  }
  if (Array.isArray(routePath) && routePath.length > 0) {
    return routePath[0];
  }
  return UNKNOWN_ROUTE;
}

function observeHttpRequest({ method, route, status, durationSeconds }) {
  const labels = {
    method,
    route: typeof route === 'string' && route.length > 0 ? route : UNKNOWN_ROUTE,
    status: String(status),
  };
  httpRequestsTotal.inc(labels);
  httpRequestDurationSeconds.observe(labels, durationSeconds);
}

function observeWebhookDelivery({ status, durationSeconds }) {
  const labels = { status };
  webhookDeliveriesTotal.inc(labels);
  if (typeof durationSeconds === 'number') {
    webhookDeliveryDurationSeconds.observe(labels, durationSeconds);
  }
}

function setWebhookDlqSize(size) {
  webhookDlqSize.set(size);
}

module.exports = {
  register,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  webhookDeliveriesTotal,
  webhookDeliveryDurationSeconds,
  webhookDlqSize,
  UNKNOWN_ROUTE,
  normalizeRoute,
  observeHttpRequest,
  observeWebhookDelivery,
  setWebhookDlqSize,
};
