const crypto = require('crypto');
const axios = require('axios');
const { Webhook, WebhookDelivery, WebhookEvent } = require('../models');
const logger = require('../utils/logger');

const MAX_ATTEMPTS = 5;
const BASE_RETRY_DELAY_MS = 1000;
const DELIVERY_TIMEOUT_MS = 10000;

/**
 * Compute the HMAC signature for a webhook delivery.
 * The signed string includes the delivery timestamp to prevent replay attacks:
 *   `${timestamp}.${rawBody}`
 */
function computeSignature(secret, timestamp, rawBody) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}

async function deliverWebhook(webhook, event, payload) {
  const rawBody = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = computeSignature(webhook.secret, timestamp, rawBody);

  const delivery = await WebhookDelivery.create({
    webhookId: webhook.id,
    eventId: event.id,
    status: 'pending',
    attempts: 0,
  });

  let attempt = 0;
  let lastError = null;

  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    try {
      const response = await axios.post(webhook.url, rawBody, {
        timeout: DELIVERY_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
          'X-Webhook-Timestamp': timestamp,
          'X-Webhook-Event': event.type,
          'X-Webhook-Delivery': delivery.id,
        },
      });

      await delivery.update({
        status: 'success',
        attempts: attempt,
        responseStatus: response.status,
        deliveredAt: new Date(),
      });

      logger.info('Webhook delivered', {
        webhookId: webhook.id,
        deliveryId: delivery.id,
        attempt,
      });
      return delivery;
    } catch (err) {
      lastError = err;
      logger.warn('Webhook delivery attempt failed', {
        webhookId: webhook.id,
        deliveryId: delivery.id,
        attempt,
        error: err.message,
      });

      if (attempt < MAX_ATTEMPTS) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  await delivery.update({
    status: 'failed',
    attempts: attempt,
    error: lastError ? lastError.message : 'Unknown error',
  });

  logger.error('Webhook delivery failed after max attempts', {
    webhookId: webhook.id,
    deliveryId: delivery.id,
    attempts: attempt,
  });

  return delivery;
}

async function processWebhookEvent(event) {
  const webhooks = await Webhook.findAll({
    where: { isActive: true },
  });

  const matching = webhooks.filter((webhook) => {
    const events = webhook.events || [];
    return events.includes(event.type) || events.includes('*');
  });

  const results = [];
  for (const webhook of matching) {
    const delivery = await deliverWebhook(webhook, event, event.payload);
    results.push(delivery);
  }

  return results;
}

module.exports = {
  computeSignature,
  deliverWebhook,
  processWebhookEvent,
};
