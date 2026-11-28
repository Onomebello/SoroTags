// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// ── vi.hoisted: variables that need to be available inside vi.mock factories ──
const { mockGetSupportedWallets } = vi.hoisted(() => ({
  mockGetSupportedWallets: vi.fn(),
}));

// ── shared.js constructs the wallets kit at import time; replace it ──
vi.mock('../views/shared', () => ({
  walletKit: { getSupportedWallets: mockGetSupportedWallets },
}));

import WalletModal from './WalletModal';

const WALLETS = [
  { id: 'freighter', name: 'Freighter', type: 'HOT_WALLET', isAvailable: true, icon: 'f.png', url: 'https://freighter.app' },
  { id: 'xbull', name: 'xBull', type: 'HOT_WALLET', isAvailable: false, icon: 'x.png', url: 'https://xbull.app' },
];
const noop = () => {};

/** Renders a trigger button that opens the modal, like the dashboard does. */
function Harness({ onSelect = noop }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setIsOpen(true)}>
        Connect Wallet
      </button>
      {isOpen && <WalletModal onSelect={onSelect} onClose={() => setIsOpen(false)} />}
    </>
  );
}

const openModal = async (props) => {
  render(<Harness {...props} />);
  const trigger = screen.getByRole('button', { name: 'Connect Wallet' });
  trigger.focus();
  fireEvent.click(trigger);
  await screen.findByRole('button', { name: /freighter/i });
  return trigger;
};

describe('WalletModal – keyboard access', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('is a labelled modal dialog with every wallet as a button', async () => {
    mockGetSupportedWallets.mockResolvedValue(WALLETS);
    await openModal();

    const dialog = screen.getByRole('dialog', { name: 'Connect a Wallet' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('button', { name: 'Close wallet selection' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /freighter/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /xbull/i })).toBeTruthy();
  });

  it('moves focus into the dialog when it opens', async () => {
    mockGetSupportedWallets.mockResolvedValue(WALLETS);
    await openModal();

    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('wraps Tab from the last control to the first and Shift+Tab back', async () => {
    mockGetSupportedWallets.mockResolvedValue(WALLETS);
    await openModal();

    const closeButton = screen.getByRole('button', { name: 'Close wallet selection' });
    const lastWallet = screen.getByRole('button', { name: /xbull/i });

    lastWallet.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(closeButton);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(lastWallet);
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    mockGetSupportedWallets.mockResolvedValue(WALLETS);
    const trigger = await openModal();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('passes an installed wallet to onSelect', async () => {
    mockGetSupportedWallets.mockResolvedValue(WALLETS);
    const onSelect = vi.fn();
    await openModal({ onSelect });

    fireEvent.click(screen.getByRole('button', { name: /freighter/i }));

    expect(onSelect).toHaveBeenCalledWith(WALLETS[0]);
  });

  it('opens the install page for a wallet that is not installed', async () => {
    mockGetSupportedWallets.mockResolvedValue(WALLETS);
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const onSelect = vi.fn();
    await openModal({ onSelect });

    fireEvent.click(screen.getByRole('button', { name: /xbull/i }));

    expect(openSpy).toHaveBeenCalledWith('https://xbull.app', '_blank', 'noopener,noreferrer');
    expect(onSelect).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});
