import React from 'react';

const NETWORK_STYLES = {
  testnet: {
    label: 'Testnet',
    className: 'network-badge network-badge--testnet',
    style: {
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: '9999px',
      fontSize: '12px',
      fontWeight: 600,
      backgroundColor: '#fef3c7',
      color: '#92400e',
      border: '1px solid #f59e0b',
    },
  },
  mainnet: {
    label: 'Mainnet',
    className: 'network-badge network-badge--mainnet',
    style: {
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: '9999px',
      fontSize: '12px',
      fontWeight: 600,
      backgroundColor: '#dcfce7',
      color: '#166534',
      border: '1px solid #22c55e',
    },
  },
};

const DEFAULT_NETWORK = 'testnet';

export function resolveNetwork(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'mainnet' ? 'mainnet' : DEFAULT_NETWORK;
}

export default function NetworkBadge({ network } = {}) {
  const rawNetwork = network !== undefined ? network : import.meta.env?.VITE_NETWORK;
  const resolved = resolveNetwork(rawNetwork);
  const config = NETWORK_STYLES[resolved];

  return (
    <span className={config.className} style={config.style} data-network={resolved}>
      {config.label}
    </span>
  );
}
