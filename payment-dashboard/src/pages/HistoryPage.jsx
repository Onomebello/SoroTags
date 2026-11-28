import { useEffect, useState } from 'react';
import { fetchTransactions } from '../api/transactions';

const DEFAULT_LIMIT = 20;

export default function HistoryPage() {
  const [transactions, setTransactions] = useState([]);
  const [page, setPage] = useState(1);
  const [limit] = useState(DEFAULT_LIMIT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadPage() {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchTransactions({ page, limit });
        if (cancelled) return;
        const items = Array.isArray(result) ? result : result?.transactions ?? [];
        setTransactions(items);
        setHasMore(items.length === limit);
      } catch (err) {
        if (cancelled) return;
        setError(err?.message ?? 'Failed to load transactions');
        setTransactions([]);
        setHasMore(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadPage();
    return () => {
      cancelled = true;
    };
  }, [page, limit]);

  const handlePrevious = () => {
    setPage((current) => Math.max(1, current - 1));
  };

  const handleNext = () => {
    setPage((current) => current + 1);
  };

  return (
    <div className="history-page">
      <h1>Transaction History</h1>

      {loading && (
        <div className="loading-spinner" role="status" aria-live="polite">
          Loading…
        </div>
      )}

      {error && !loading && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}

      {!loading && !error && transactions.length === 0 && (
        <p className="empty-state">No transactions found.</p>
      )}

      {!loading && transactions.length > 0 && (
        <ul className="transaction-list">
          {transactions.map((tx) => (
            <li key={tx.id} className="transaction-item">
              <span className="transaction-id">{tx.id}</span>
              <span className="transaction-amount">{tx.amount}</span>
              <span className="transaction-date">{tx.createdAt ?? tx.date}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="pagination-controls">
        <button
          type="button"
          onClick={handlePrevious}
          disabled={page <= 1 || loading}
        >
          Previous page
        </button>
        <span className="page-indicator">Page {page}</span>
        <button
          type="button"
          onClick={handleNext}
          disabled={!hasMore || loading}
        >
          Next page
        </button>
      </div>
    </div>
  );
}
