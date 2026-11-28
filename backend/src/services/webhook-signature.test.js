const crypto = require('crypto');
const {
  computeSignature,
  buildSignatureHeaders,
  verifySignature,
} = require('./webhook-signature');

describe('webhook signature', () => {
  const secret = 'test-secret';
  const body = JSON.stringify({ event: 'payment.completed', id: 'evt_123' });

  it('computes HMAC over `${timestamp}.${body}`', () => {
    const timestamp = 1700000000;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');

    expect(computeSignature(secret, timestamp, body)).toBe(expected);
  });

  it('produces a different signature for a different timestamp', () => {
    const sigA = computeSignature(secret, 1700000000, body);
    const sigB = computeSignature(secret, 1700000001, body);

    expect(sigA).not.toBe(sigB);
  });

  it('builds headers including X-Webhook-Timestamp and X-Webhook-Signature', () => {
    const timestamp = 1700000000;
    const headers = buildSignatureHeaders(secret, timestamp, body);

    expect(headers['X-Webhook-Timestamp']).toBe(String(timestamp));
    expect(headers['X-Webhook-Signature']).toBe(
      computeSignature(secret, timestamp, body),
    );
  });

  it('verifies a fresh delivery within the tolerance window', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = computeSignature(secret, timestamp, body);

    expect(
      verifySignature({ secret, timestamp, body, signature }),
    ).toBe(true);
  });

  it('rejects a stale delivery older than the tolerance window', () => {
    const timestamp = Math.floor(Date.now() / 1000) - 6 * 60;
    const signature = computeSignature(secret, timestamp, body);

    expect(
      verifySignature({ secret, timestamp, body, signature }),
    ).toBe(false);
  });

  it('rejects a signature computed over the body without the timestamp', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const legacySignature = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');

    expect(
      verifySignature({ secret, timestamp, body, signature: legacySignature }),
    ).toBe(false);
  });
});
