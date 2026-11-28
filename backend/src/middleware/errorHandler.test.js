const { errorHandler, notFoundHandler } = require('./errorHandler');

jest.mock('../utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const logger = require('../utils/logger');

function createRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('errorHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('logs 4xx errors at warn level with correlation id', () => {
    const err = new Error('Not found');
    err.statusCode = 404;
    err.code = 'NOT_FOUND';
    const req = { correlationId: 'corr-404', method: 'GET', originalUrl: '/missing' };
    const res = createRes();
    const next = jest.fn();

    errorHandler(err, req, res, next);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        correlationId: 'corr-404',
        statusCode: 404,
        code: 'NOT_FOUND',
      })
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('logs 5xx errors at error level with correlation id and stack', () => {
    const err = new Error('Boom');
    err.statusCode = 500;
    err.code = 'INTERNAL_ERROR';
    const req = { correlationId: 'corr-500', method: 'GET', originalUrl: '/boom' };
    const res = createRes();
    const next = jest.fn();

    errorHandler(err, req, res, next);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        correlationId: 'corr-500',
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        stack: expect.any(String),
      })
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('logs 404 from notFoundHandler at warn level with correlation id', () => {
    const req = { correlationId: 'corr-nf', method: 'GET', originalUrl: '/nope' };
    const res = createRes();
    const next = jest.fn();

    notFoundHandler(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(404);

    errorHandler(err, req, res, next);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        correlationId: 'corr-nf',
        statusCode: 404,
      })
    );
  });
});
