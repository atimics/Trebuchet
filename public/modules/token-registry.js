// token-registry.js — thin shim for the client build. The canonical tokenRegistry.js
// lives in the repo root and is imported by server-side code (lpService.js).
// For the client bundle we copy a snapshot of TOKEN_REGISTRY here so the concatenated
// app.js has it without needing ESM imports.
//
// When adding tokens: edit the root tokenRegistry.js, then re-run `npm run build:js`
// which will rebuild this snapshot into public/app.js.
//
// (Replaces the old scattered FLYWHEELS + hardcoded <option> tags.)

var TOKEN_REGISTRY = {
  // ==========================================================================
  // Native
  // ==========================================================================
  SOL: {
    address: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL',
    decimals: 9,
    name: 'Solana',
    network: 'both',
    group: 'native',
  },

  // ==========================================================================
  // Flywheels (mainnet)
  // ==========================================================================
  SEIGE: {
    address: 'HipYKXiDh3Kjd1jb7ji6jCEsKQMSGWiFJMdtvH8yb5r',
    symbol: '$seige',
    decimals: 6,
    name: 'Seige (Meme Flywheel)',
    network: 'mainnet',
    group: 'flywheel',
    description: 'Meme-token flywheel — recommended',
    isFlywheel: true,
    available: true,
  },
  XLRT: {
    address: 'J1bZFRAFC8ALqAN7ktkcCpobgoeTGfP5Xh1BwCP1oqoj',
    symbol: 'XLRT',
    decimals: 9,
    name: 'XLRT (Reserve Flywheel)',
    network: 'mainnet',
    group: 'flywheel',
    description: 'wBTC + ETH reserve flywheel',
    isFlywheel: true,
    available: true,
  },

  // ==========================================================================
  // Devnet-native basis tokens
  // ==========================================================================
  RATI: {
    address: '8ZscSWe5ZSFbGYg4JzA3eqpf6iCnwT72i8TZvVni2yMY',
    symbol: 'RATi',
    decimals: 9,
    name: 'RATi (Agent Economy)',
    network: 'devnet',
    group: 'flywheel',
    description: 'Agent Economy — devnet',
    isFlywheel: true,
    available: true,
  },
  KYRO: {
    address: '7m5Y29h6pEvzfkgn3hkYqFQNUrL5CofXtrnDJoqCKyro',
    symbol: 'Kyro',
    decimals: 6,
    name: 'Kyro (Intent Protocol)',
    network: 'devnet',
    group: 'flywheel',
    description: 'Intent Protocol — devnet',
    isFlywheel: true,
    available: true,
  },
  RUBY: {
    address: '2hJY16WZgTQXXo6qBoWoBtZM7fz556cw3qdLgtntRuby',
    symbol: 'Ruby',
    decimals: 6,
    name: 'Ruby (Ruby High AI)',
    network: 'devnet',
    group: 'flywheel',
    description: 'Ruby High AI — devnet',
    isFlywheel: true,
    available: true,
  },

  // ==========================================================================
  // Majors
  // ==========================================================================
  WBTC: {
    address: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
    symbol: 'wBTC',
    decimals: 8,
    name: 'Wrapped BTC (Wormhole)',
    network: 'mainnet',
    group: 'major',
  },
  WETH: {
    address: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
    symbol: 'wETH',
    decimals: 8,
    name: 'Wrapped ETH (Wormhole)',
    network: 'mainnet',
    group: 'major',
  },

  // ==========================================================================
  // Stables
  // ==========================================================================
  USDC: {
    address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    decimals: 6,
    name: 'USD Coin',
    network: 'mainnet',
    group: 'stable',
  },
  USDT: {
    address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    symbol: 'USDT',
    decimals: 6,
    name: 'USDT',
    network: 'mainnet',
    group: 'stable',
  },
  USD1: {
    address: 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',
    symbol: 'USD1',
    decimals: 6,
    name: 'USD1 (World Liberty Financial)',
    network: 'mainnet',
    group: 'stable',
  },
};

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

function tokenByKey(key) {
  return TOKEN_REGISTRY[key] || null;
}

function tokenByAddress(addr) {
  if (!addr) return null;
  const s = String(addr);
  return Object.values(TOKEN_REGISTRY).find((t) => t.address === s) || null;
}

function tokensByGroup(group) {
  return Object.values(TOKEN_REGISTRY).filter((t) => t.group === group);
}

function tokensByNetwork(net) {
  if (!net) return Object.values(TOKEN_REGISTRY);
  return Object.values(TOKEN_REGISTRY).filter((t) => t.network === net || t.network === 'both');
}

function allFlywheels() {
  return Object.values(TOKEN_REGISTRY).filter((t) => t.isFlywheel);
}

function flywheelsByNetwork(net) {
  return Object.values(TOKEN_REGISTRY).filter((t) => t.isFlywheel && (t.network === net || t.network === 'both'));
}

/** Predicate: is this quote token allowed for launches on the given network? */
function isAllowedQuote(spec, network) {
  if (!spec) return false;
  const str = String(spec);
  const upper = str.toUpperCase();
  const token = tokenByKey(upper) || tokenByAddress(str);
  if (!token) return false;
  return token.network === network || token.network === 'both';
}
