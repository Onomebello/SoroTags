'use strict';

const mockDeleteMany = jest.fn();
const mockLoggerInfo = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => ({
    user: { deleteMany: mockDeleteMany },
    session: { deleteMany: mockDeleteMany },
    auditLog: { deleteMany: mockDeleteMany },
  })),
}));

jest.mock('./logger', () => ({
  info: mockLoggerInfo,
  error: jest.fn(),
  warn: jest.fn(),
}));

describe('cleanup-cron', () => {
  beforeEach(() => {
    jest.resetModules();
    mockDeleteMany.mockReset();
    mockLoggerInfo.mockReset();
  });

  it('logs per-table purge counts and a total at completion', async () => {
    mockDeleteMany
      .mockResolvedValueOnce({ count: 3 })
      .mockResolvedValueOnce({ count: 5 })
      .mockResolvedValueOnce({ count: 2 });

    const { runCleanup } = require('./cleanup-cron');
    await runCleanup();

    expect(mockLoggerInfo).toHaveBeenCalledWith('Purge completed', {
      table: 'User',
      count: 3,
    });
    expect(mockLoggerInfo).toHaveBeenCalledWith('Purge completed', {
      table: 'Session',
      count: 5,
    });
    expect(mockLoggerInfo).toHaveBeenCalledWith('Purge completed', {
      table: 'AuditLog',
      count: 2,
    });
    expect(mockLoggerInfo).toHaveBeenCalledWith('Cleanup completed', {
      totalPurged: 10,
    });
  });
});
