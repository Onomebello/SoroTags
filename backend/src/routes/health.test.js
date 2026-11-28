const request = require('supertest');
const express = require('express');
const healthRouter = require('./health');

function buildApp() {
  const app = express();
  app.use('/health', healthRouter);
  return app;
}

describe('GET /health', () => {
  const originalFetch = global.fetch;
  const originalHorizonBase = process.env.HORIZON_BASE;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalHorizonBase === undefined) {
      delete process.env.HORIZON_BASE;
    } else {
      process.env.HORIZON_BASE = originalHorizonBase;
    }
    jest.restoreAllMocks();
  });

  it('probes the Horizon URL derived from HORIZON_BASE', async () => {
    process.env.HORIZON_BASE = 'https://custom.horizon';
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock;

    const res = await request(buildApp()).get('/health');

    expect(fetchMock).toHaveBeenCalled();
    const probedUrl = fetchMock.mock.calls[0][0];
    expect(probedUrl).toBe('https://custom.horizon/');
    expect(res.status).toBe(200);
  });

  it('falls back to the testnet Horizon URL when HORIZON_BASE is unset', async () => {
    delete process.env.HORIZON_BASE;
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock;

    await request(buildApp()).get('/health');

    expect(fetchMock).toHaveBeenCalled();
    const probedUrl = fetchMock.mock.calls[0][0];
    expect(probedUrl).toBe('https://horizon-testnet.stellar.org/');
  });
});
