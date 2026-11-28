import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockQuery = vi.fn();

vi.mock('../db/index.js', () => ({
  pool: {
    query: (...args) => mockQuery(...args),
  },
}));

const { default: federationRouter } = await import('./federation.js');

function buildApp() {
  const app = express();
  app.use('/federation', federationRouter);
  return app;
}

describe('GET /federation', () => {
  let app;

  beforeEach(() => {
    mockQuery.mockReset();
    app = buildApp();
  });

  it('returns 400 INVALID_INPUT when q is missing', async () => {
    const res = await request(app).get('/federation');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_INPUT');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_INPUT for q=alice* (missing domain)', async () => {
    const res = await request(app).get('/federation').query({ q: 'alice*' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_INPUT');
    expect(res.body.message).toMatch(/name\*domain/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_INPUT for q=*domain (missing name)', async () => {
    const res = await request(app).get('/federation').query({ q: '*domain' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_INPUT');
    expect(res.body.message).toMatch(/name\*domain/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('resolves normally for q=alice*domain', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/federation').query({ q: 'alice*domain' });
    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(1);
const request = require('supertest');
const express = require('express');
const federationRouter = require('./federation');

describe('federation routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/federation', federationRouter);
  });

  describe('GET /federation', () => {
    it('returns a username-to-address mapping', async () => {
      const res = await request(app).get('/federation').query({ username: 'alice' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('address');
    });

    it('sets a short-lived public Cache-Control header', async () => {
      const res = await request(app).get('/federation').query({ username: 'alice' });

      expect(res.headers['cache-control']).toBe(
        'public, max-age=60, stale-while-revalidate=30'
      );
    });
  });

  describe('POST /register', () => {
    it('registers a username', async () => {
      const res = await request(app)
        .post('/federation/register')
        .send({ username: 'bob', address: 'GBADDRESS' });

      expect(res.status).toBe(200);
    });

    it('sets a no-store Cache-Control header', async () => {
      const res = await request(app)
        .post('/federation/register')
        .send({ username: 'bob', address: 'GBADDRESS' });

      expect(res.headers['cache-control']).toBe('no-store');
    });
  });
});
