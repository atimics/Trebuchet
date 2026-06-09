// tokenRegistry.js — single source of truth for the curated token list.
//
// Every pooled quote token known to Trebuchet (flywheel, major, stable,
// devnet-native) lives here. One place, shared by server and client.
// No more scattered KNOWN_QUOTES / FLYWHEELS / DEVNET_ALLOWED_QUOTES /
// hardcoded <option> tags.
//
// Each entry:
//   key          — unique identifier (uppercase symbol or 'native' key)
//   address      — mint address (WSOL for SOL)
//   symbol       — display symbol
//   decimals     — token decimals
//   name         — human-readable name
//   network      — 'mainnet' | 'devnet' | 'both'
//   group        — 'native' | 'flywheel' | 'major' | 'stable'
//   description  — optional short tagline
//   available    — false = shown grayed out (not yet launched)
//   iconUrl      — optional logo URL (overrides token-list default)
//   isFlywheel   — simple config treats this as a flywheel option

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export const TOKEN_REGISTRY = {
  // ==========================================================================
  // Native
  // ==========================================================================
  SOL: {
    address: WSOL_MINT,
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

export function tokenByKey(key) {
  return TOKEN_REGISTRY[key] || null;
}

export function tokenByAddress(addr) {
  if (!addr) return null;
  const s = String(addr);
  return Object.values(TOKEN_REGISTRY).find((t) => t.address === s) || null;
}

export function tokensByGroup(group) {
  return Object.values(TOKEN_REGISTRY).filter((t) => t.group === group);
}

export function tokensByNetwork(net) {
  if (!net) return Object.values(TOKEN_REGISTRY);
  return Object.values(TOKEN_REGISTRY).filter((t) => t.network === net || t.network === 'both');
}

export function allFlywheels() {
  return Object.values(TOKEN_REGISTRY).filter((t) => t.isFlywheel);
}

export function flywheelsByNetwork(net) {
  return Object.values(TOKEN_REGISTRY).filter((t) => t.isFlywheel && (t.network === net || t.network === 'both'));
}

/** Predicate: is this quote token allowed for launches on the given network? */
export function isAllowedQuote(spec, network) {
  if (!spec) return false;
  const str = String(spec);
  const upper = str.toUpperCase();
  const token = tokenByKey(upper) || tokenByAddress(str);
  if (!token) return false;
  return token.network === network || token.network === 'both';
}

export default TOKEN_REGISTRY;
