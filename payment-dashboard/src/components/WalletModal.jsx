import { useEffect, useState } from 'react';
import Dialog from './Dialog';
import { walletKit } from '../views/shared';

/**
 * @typedef {import('@creit.tech/stellar-wallets-kit').ISupportedWallet} SupportedWallet
 */

/**
 * @typedef {Object} WalletModalProps
 * @property {(wallet: SupportedWallet) => void} onSelect - Called with an installed wallet the user picked.
 * @property {() => void} onClose - Called when the user dismisses the dialog.
 */

/**
 * Wallet picker built on the wallets kit's wallet list. It replaces the
 * kit's own modal, whose wallet entries cannot be reached from the keyboard
 * and which does not close on Escape.
 *
 * @param {WalletModalProps} props
 */
function WalletModal({ onSelect, onClose }) {
  /** @type {[SupportedWallet[] | null, (wallets: SupportedWallet[]) => void]} */
  const [wallets, setWallets] = useState(null);

  useEffect(() => {
    let cancelled = false;

    walletKit
      .getSupportedWallets()
      .catch(() => [])
      .then((supported) => {
        if (!cancelled) {
          setWallets(supported);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /** @param {SupportedWallet} wallet */
  const handlePick = (wallet) => {
    if (!wallet.isAvailable) {
      window.open(wallet.url, '_blank', 'noopener,noreferrer');
      return;
    }
    onSelect(wallet);
  };

  return (
    <Dialog className="wallet-modal" titleId="wallet-modal-title" onClose={onClose}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
        }}
      >
        <h2 id="wallet-modal-title" style={{ margin: 0 }}>
          Connect a Wallet
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close wallet selection"
          style={{ width: 'auto', padding: '6px 10px' }}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>

      {wallets === null || wallets.length === 0 ? (
        <p role="status">
          {wallets === null ? 'Loading wallets...' : 'No supported wallets found.'}
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '16px 0 0' }}>
          {wallets.map((wallet) => (
            <li key={wallet.id} style={{ marginTop: '8px' }}>
              <button
                type="button"
                onClick={() => handlePick(wallet)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                }}
              >
                <img src={wallet.icon} alt="" width={24} height={24} />
                <span>{wallet.name}</span>
                {!wallet.isAvailable && (
                  <small style={{ marginLeft: 'auto' }}>Not installed</small>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

export default WalletModal;
