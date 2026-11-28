'use strict';

const express = require('express');
const http = require('http');
const bodyLimit = require('./bodyLimit');

const CAP = 10 * 1024;

function buildApp() {
  const app = express();
  app.use(bodyLimit);
  app.post('/json', (req, res) => {
    res.status(200).json({ ok: true, length: req.body ? req.body.length : 0 });
  });
  app.get('/transactions/export', (req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

function sendChunked(server, path, chunks) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request(
      {
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d;
        });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    for (const chunk of chunks) {
      req.write(chunk);
    }
    req.end();
  });
}

describe('bodyLimit middleware', () => {
  let server;

  beforeAll((done) => {
    server = buildApp().listen(0, done);
  });

  afterAll((done) => {
    server.close(done);
  });

  it('rejects a chunked request whose body exceeds the cap with 413', async () => {
    const chunk = Buffer.alloc(4 * 1024, 'a');
    const chunks = [chunk, chunk, chunk]; // 12 KB total
    const res = await sendChunked(server, '/json', chunks);
    expect(res.status).toBe(413);
    const parsed = JSON.parse(res.body);
    expect(parsed.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('processes a chunked request under the cap normally', async () => {
    const chunk = Buffer.alloc(2 * 1024, 'a');
    const chunks = [chunk, chunk]; // 4 KB total
    const res = await sendChunked(server, '/json', chunks);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.ok).toBe(true);
  });

  it('exempts streaming export endpoints from the chunk limit', async () => {
    const chunk = Buffer.alloc(4 * 1024, 'a');
    const chunks = [chunk, chunk, chunk]; // 12 KB total
    const res = await sendChunked(server, '/transactions/export', chunks);
    expect(res.status).not.toBe(413);
  });
});
