// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// ── vi.hoisted: variables that need to be available inside vi.mock factories ──
const { mockSignTransaction, mockRoutePayment, mockToastError, mockToastLoading, mockToastSuccess } =
  vi.hoisted(() => ({
    mockSignTransaction: vi.fn(),
    mockRoutePayment: vi.fn(),
    mockToastError: vi.fn(),
    mockToastLoading: vi.fn(() => 'toast-id'),
    mockToastSuccess: vi.fn(),
  }));

// ── Wallet kit is a CJS singleton constructed at import time in shared.js ──
vi.mock('@creit.tech/stellar-wallets-kit', () => {
  class Stub {}
  return {
    StellarWalletsKit: Stub,
    WalletNetwork: { TESTNET: 'TESTNET' },
    FreighterModule: Stub,
    xBullModule: Stub,
    AlbedoModule: Stub,
    LobstrModule: Stub,
  };
});

// ── Mock @stellar/freighter-api so we can control signTransaction ──
vi.mock('@stellar/freighter-api', () => ({
  default: {
    signTransaction: mockSignTransaction,
  },
}));

// ── Mock the generated contract client ──
vi.mock('@stellar-tags/payment-router', () => {
  const RoutePayment = mockRoutePayment;
  class Client {
    // eslint-disable-next-line no-unused-vars
    constructor(_opts) {}
    route_payment(...args) {
      return RoutePayment(...args);
    }
  }
  return {
    Client,
    networks: {
      testnet: {
        networkPassphrase: 'Test SDF Network ; September 2015',
        contractId: 'CTEST',
      },
    },
  };
});

// ── Mock react-hot-toast so we can inspect calls ──
vi.mock('react-hot-toast', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual.default,
      error: mockToastError,
      loading: mockToastLoading,
      success: mockToastSuccess,
    },
    Toaster: () => null,
  };
});

import Dashboard from './Dashboard';

const PUBLIC_KEY = 'GABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB';
const RECIPIENT_KEY = 'GBOB1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB';
const noop = () => {};

const SIGNING_CANCELLED_MSG =
  'Transaction signing was cancelled or failed — no transaction was submitted.';

const renderDashboard = (publicKey = PUBLIC_KEY) =>
  render(
    <Dashboard
      userPublicKey={publicKey}
      balance={100}
      isRefreshing={false}
      balanceError=""
      onRefreshBalance={noop}
      onConnectWallet={noop}
      onDisconnectWallet={noop}
      onNavigate={noop}
      registrationState="existing"
      onRegistrationStateChange={noop}
    />,
  );

describe('Dashboard – signing-failure path', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  /** Set up the federation fetch mock and the route_payment simulation. */
  const setupHappyPathMocks = () => {
    // jsdom does not implement matchMedia; stub it before rendering Dashboard
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addListener: noop,
      removeListener: noop,
    }));

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        // 1st call: /lookup during loadReceiveDetails
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({ address: PUBLIC_KEY, username: 'alice' }),
        })
        // All subsequent calls: /federation for recipient resolution (debounce + handleLookup)
        .mockResolvedValue({
          ok: true,
          json: async () => ({ account_id: RECIPIENT_KEY }),
          text: async () => JSON.stringify({ account_id: RECIPIENT_KEY }),
        }),
    );

    // Simulate route_payment returning an assembled transaction
    mockRoutePayment.mockResolvedValue({ toXDR: () => 'base64xdr==' });
  };

  it('shows the signing-cancelled message when the wallet rejects the signing prompt', async () => {
    setupHappyPathMocks();
    mockSignTransaction.mockRejectedValue(new Error('User declined'));

    renderDashboard();

    fireEvent.change(screen.getByPlaceholderText('username or wallet address'), {
      target: { value: 'alice*localhost' },
    });
    fireEvent.change(screen.getByPlaceholderText('0.00'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send payment/i }));

    await waitFor(() =>
      expect(screen.queryByText(SIGNING_CANCELLED_MSG)).not.toBeNull(),
    );

    expect(screen.getByText(SIGNING_CANCELLED_MSG)).toBeTruthy();
  });

  it('shows the signing-cancelled message when the wallet times out', async () => {
    setupHappyPathMocks();
    mockSignTransaction.mockRejectedValue(new Error('Request timed out'));

    renderDashboard();

    fireEvent.change(screen.getByPlaceholderText('username or wallet address'), {
      target: { value: 'alice*localhost' },
    });
    fireEvent.change(screen.getByPlaceholderText('0.00'), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send payment/i }));

    await waitFor(() =>
      expect(screen.queryByText(SIGNING_CANCELLED_MSG)).not.toBeNull(),
    );

    expect(screen.getByText(SIGNING_CANCELLED_MSG)).toBeTruthy();
  });

  it('passes the signing-cancelled message to toast.error', async () => {
    setupHappyPathMocks();
    mockSignTransaction.mockRejectedValue(new Error('User declined'));

    renderDashboard();

    fireEvent.change(screen.getByPlaceholderText('username or wallet address'), {
      target: { value: 'alice*localhost' },
    });
    fireEvent.change(screen.getByPlaceholderText('0.00'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send payment/i }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());

    const [msg] = mockToastError.mock.calls[0];
    expect(msg).toBe(SIGNING_CANCELLED_MSG);
  });

  it('rolls back isProcessing and isSubmitting after a signing failure (Send Payment re-enabled)', async () => {
    setupHappyPathMocks();
    mockSignTransaction.mockRejectedValue(new Error('User declined'));

    renderDashboard();

    const recipientInput = screen.getByPlaceholderText('username or wallet address');
    const amountInput = screen.getByPlaceholderText('0.00');

    fireEvent.change(recipientInput, { target: { value: 'alice*localhost' } });
    fireEvent.change(amountInput, { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /send payment/i }));

    // Wait for error to confirm the async chain is done
    await waitFor(() =>
      expect(screen.queryByText(SIGNING_CANCELLED_MSG)).not.toBeNull(),
    );

    // After the failure the button must be re-enabled (not disabled)
    const reenabledBtn = screen.getByRole('button', { name: /send payment/i });
    expect(reenabledBtn.disabled).toBe(false);
  });

  it('does NOT call toast.success after a signing failure', async () => {
    setupHappyPathMocks();
    mockSignTransaction.mockRejectedValue(new Error('User declined'));

    renderDashboard();

    fireEvent.change(screen.getByPlaceholderText('username or wallet address'), {
      target: { value: 'alice*localhost' },
    });
    fireEvent.change(screen.getByPlaceholderText('0.00'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send payment/i }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());

    expect(mockToastSuccess).not.toHaveBeenCalled();
  });
});

describe('Dashboard – keyboard and screen reader support', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  const stubBrowser = () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addListener: noop,
      removeListener: noop,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ account_id: RECIPIENT_KEY }),
        text: async () => JSON.stringify({ address: PUBLIC_KEY, username: 'alice' }),
      }),
    );
  };

  it('reaches recipient, amount and Send Payment in that order with no positive tabindex', () => {
    stubBrowser();
    const { container } = renderDashboard();

    const form = screen.getByRole('form', { name: /send payment/i });
    const focusable = Array.from(form.querySelectorAll('input, button'));
    const sendButton = screen.getByRole('button', { name: /send payment/i });

    expect(focusable).toEqual([
      screen.getByLabelText('Recipient'),
      screen.getByLabelText('Amount'),
      sendButton,
    ]);
    expect(sendButton.hasAttribute('disabled')).toBe(false);
    expect(sendButton.getAttribute('aria-disabled')).toBe('true');
    expect(
      Array.from(container.querySelectorAll('[tabindex]')).filter(
        (element) => Number(element.getAttribute('tabindex')) > 0,
      ),
    ).toEqual([]);
  });

  it('keeps the status live region mounted before anything is submitted', () => {
    stubBrowser();
    renderDashboard();

    const form = screen.getByRole('form', { name: /send payment/i });
    const liveRegion = form.querySelector('[role="status"]');

    expect(liveRegion).not.toBeNull();
    expect(liveRegion.getAttribute('aria-live')).toBe('polite');
    expect(liveRegion.textContent).toBe('');
  });

  it('announces missing input when the form is submitted with Enter', () => {
    stubBrowser();
    renderDashboard();

    fireEvent.submit(screen.getByRole('form', { name: /send payment/i }));

    expect(screen.getByRole('form', { name: /send payment/i }).querySelector('[role="status"]').textContent)
      .toBe('Enter a recipient and an amount greater than zero.');
    expect(mockRoutePayment).not.toHaveBeenCalled();
  });

  it('announces the submission result in the live region', async () => {
    stubBrowser();
    mockRoutePayment.mockResolvedValue({ toXDR: () => 'base64xdr==' });
    mockSignTransaction.mockRejectedValue(new Error('User declined'));
    renderDashboard();

    fireEvent.change(screen.getByLabelText('Recipient'), {
      target: { value: 'alice*localhost' },
    });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '10' } });
    fireEvent.submit(screen.getByRole('form', { name: /send payment/i }));

    const form = screen.getByRole('form', { name: /send payment/i });
    await waitFor(() =>
      expect(form.querySelector('[role="status"]').textContent).toMatch(/User declined/),
    );
  });

  it('closes the wallet menu on Escape and returns focus to its trigger', () => {
    stubBrowser();
    renderDashboard();

    const trigger = screen.getByRole('button', { expanded: false });
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    screen.getByRole('button', { name: 'Disconnect' }).focus();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });
});
