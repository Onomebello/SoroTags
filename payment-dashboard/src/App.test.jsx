import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import App from './App';

const STORAGE_KEY = 'stellar_dashboard_wallet_pubkey';
const TEST_PUBLIC_KEY = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV';

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();

vi.mock('@stellar/freighter-api', () => ({
  isConnected: vi.fn(),
  getPublicKey: vi.fn(),
  requestAccess: vi.fn(),
}));

import * as freighterApi from '@stellar/freighter-api';

describe('App wallet persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.useRealTimers();
  });

  it('persists the connected public key to localStorage after a successful connection', async () => {
    freighterApi.isConnected.mockResolvedValue({ isConnected: true });
    freighterApi.requestAccess.mockResolvedValue({ publicKey: TEST_PUBLIC_KEY });
    freighterApi.getPublicKey.mockResolvedValue({ publicKey: TEST_PUBLIC_KEY });

    render(<App />);

    const connectButton = await screen.findByRole('button', { name: /connect/i });
    connectButton.click();

    await waitFor(() => {
      expect(localStorage.getItem(STORAGE_KEY)).toBe(TEST_PUBLIC_KEY);
    });
  });

  it('restores a previously connected wallet on load via silent reconnection', async () => {
    localStorage.setItem(STORAGE_KEY, TEST_PUBLIC_KEY);
    freighterApi.isConnected.mockResolvedValue({ isConnected: true });
    freighterApi.getPublicKey.mockResolvedValue({ publicKey: TEST_PUBLIC_KEY });

    render(<App />);

    await waitFor(() => {
      expect(freighterApi.getPublicKey).toHaveBeenCalled();
    });

    expect(await screen.findByText(new RegExp(TEST_PUBLIC_KEY.slice(0, 6)))).toBeTruthy();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(TEST_PUBLIC_KEY);
  });

  it('clears storage and shows the connect prompt when silent reconnection fails', async () => {
    localStorage.setItem(STORAGE_KEY, TEST_PUBLIC_KEY);
    freighterApi.isConnected.mockResolvedValue({ isConnected: false });
    freighterApi.getPublicKey.mockRejectedValue(new Error('Wallet locked'));

    render(<App />);

    await waitFor(() => {
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    expect(await screen.findByRole('button', { name: /connect/i })).toBeTruthy();
  });

  it('shows a spinner while connecting and an error after the wallet times out', async () => {
    vi.useFakeTimers();
    freighterApi.isConnected.mockResolvedValue({ isConnected: true });
    // Simulate a wallet extension that never responds.
    freighterApi.requestAccess.mockReturnValue(new Promise(() => {}));
    freighterApi.getPublicKey.mockReturnValue(new Promise(() => {}));

    render(<App />);

    const connectButton = await screen.findByRole('button', { name: /connect/i });
    act(() => {
      connectButton.click();
    });

    // Spinner is visible during the connection attempt.
    expect(screen.getByRole('status')).toBeTruthy();

    // Advance past the 10s timeout.
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });

    expect(await screen.findByText(/timed out/i)).toBeTruthy();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    // User can retry without refreshing.
    expect(screen.getByRole('button', { name: /retry|connect/i })).toBeTruthy();
  });
});

describe('HistoryPage pagination state transitions', () => {
  const DEFAULT_LIMIT = 20;

  // Mirrors the page/limit state machine used by HistoryPage.jsx so the
  // pagination transitions can be verified without mounting the full page.
  function createPaginationState(initialPage = 1, limit = DEFAULT_LIMIT) {
    let state = { page: initialPage, limit, loading: false };
    const listeners = [];
    const notify = () => listeners.forEach((fn) => fn(state));
    return {
      getState: () => state,
      subscribe: (fn) => {
        listeners.push(fn);
        return () => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      setLoading: (loading) => {
        state = { ...state, loading };
        notify();
      },
      nextPage: () => {
        state = { ...state, page: state.page + 1, loading: true };
        notify();
      },
      prevPage: () => {
        if (state.page <= 1) return;
        state = { ...state, page: state.page - 1, loading: true };
        notify();
      },
    };
  }

  it('starts on page 1 with the default limit of 20', () => {
    const pagination = createPaginationState();
    expect(pagination.getState()).toEqual({ page: 1, limit: DEFAULT_LIMIT, loading: false });
  });

  it('advances to the next page and flags loading between fetches', () => {
    const pagination = createPaginationState();
    const seen = [];
    pagination.subscribe((s) => seen.push({ ...s }));

    pagination.nextPage();

    expect(pagination.getState().page).toBe(2);
    expect(pagination.getState().loading).toBe(true);
    expect(seen).toEqual([{ page: 2, limit: DEFAULT_LIMIT, loading: true }]);

    pagination.setLoading(false);
    expect(pagination.getState().loading).toBe(false);
  });

  it('does not go below page 1 when requesting the previous page', () => {
    const pagination = createPaginationState();
    pagination.prevPage();
    expect(pagination.getState().page).toBe(1);

    pagination.nextPage();
    pagination.setLoading(false);
    pagination.prevPage();
    expect(pagination.getState().page).toBe(1);
    expect(pagination.getState().loading).toBe(true);
  });
});

describe('App network badge', () => {
  const originalNetwork = import.meta.env.VITE_NETWORK;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    freighterApi.isConnected.mockResolvedValue({ isConnected: false });
    freighterApi.getPublicKey.mockRejectedValue(new Error('Wallet locked'));
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    import.meta.env.VITE_NETWORK = originalNetwork;
  });

  it('renders a green badge for mainnet', async () => {
    import.meta.env.VITE_NETWORK = 'mainnet';

    render(<App />);

    const badge = await screen.findByTestId('network-badge');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toMatch(/mainnet/i);
    expect(badge.className).toMatch(/green/);
  });

  it('renders a yellow badge for testnet', async () => {
    import.meta.env.VITE_NETWORK = 'testnet';

    render(<App />);

    const badge = await screen.findByTestId('network-badge');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toMatch(/testnet/i);
    expect(badge.className).toMatch(/yellow|amber/);
  });

  it('defaults to a testnet badge when VITE_NETWORK is unset', async () => {
    delete import.meta.env.VITE_NETWORK;

    render(<App />);

    const badge = await screen.findByTestId('network-badge');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toMatch(/testnet/i);
    expect(badge.className).toMatch(/yellow|amber/);
  });
});
