import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import HistoryPage from './HistoryPage';

const makeTransactions = (start, count) =>
  Array.from({ length: count }, (_, i) => ({
    id: `tx-${start + i}`,
    amount: '10.00',
    asset: 'XLM',
    createdAt: new Date(2024, 0, 1 + start + i).toISOString(),
  }));

const mockFetch = vi.fn();

describe('HistoryPage pagination', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches only the first page on initial mount', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ transactions: makeTransactions(0, 20), total: 45 }),
    });

    render(<HistoryPage />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain('page=1');
    expect(calledUrl).toContain('limit=20');

    await waitFor(() => expect(screen.getByText('tx-0')).toBeInTheDocument());
    expect(screen.queryByText('tx-20')).not.toBeInTheDocument();
  });

  it('shows a loading spinner between page fetches', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ transactions: makeTransactions(0, 20), total: 45 }),
    });

    render(<HistoryPage />);
    await waitFor(() => expect(screen.getByText('tx-0')).toBeInTheDocument());

    let resolveNext;
    mockFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveNext = resolve;
      })
    );

    fireEvent.click(screen.getByRole('button', { name: /next page/i }));

    expect(screen.getByRole('status')).toBeInTheDocument();

    resolveNext({
      ok: true,
      json: async () => ({ transactions: makeTransactions(20, 20), total: 45 }),
    });

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('fetches the next batch when the next page button is clicked', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ transactions: makeTransactions(0, 20), total: 45 }),
    });

    render(<HistoryPage />);
    await waitFor(() => expect(screen.getByText('tx-0')).toBeInTheDocument());

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ transactions: makeTransactions(20, 20), total: 45 }),
    });

    fireEvent.click(screen.getByRole('button', { name: /next page/i }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    const secondUrl = mockFetch.mock.calls[1][0];
    expect(secondUrl).toContain('page=2');
    expect(secondUrl).toContain('limit=20');

    await waitFor(() => expect(screen.getByText('tx-20')).toBeInTheDocument());
  });

  it('fetches the previous batch when the previous page button is clicked', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ transactions: makeTransactions(0, 20), total: 45 }),
    });

    render(<HistoryPage />);
    await waitFor(() => expect(screen.getByText('tx-0')).toBeInTheDocument());

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ transactions: makeTransactions(20, 20), total: 45 }),
    });
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    await waitFor(() => expect(screen.getByText('tx-20')).toBeInTheDocument());

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ transactions: makeTransactions(0, 20), total: 45 }),
    });
    fireEvent.click(screen.getByRole('button', { name: /previous page/i }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    expect(mockFetch.mock.calls[2][0]).toContain('page=1');
  });
});
