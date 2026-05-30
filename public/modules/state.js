// state.js — Shared mutable state and constants

// --- Flywheel presets ---
const FLYWHEELS = {
  reserve: {
    key: 'reserve', label: 'Reserve',
    mint: 'J1bZFRAFC8ALqAN7ktkcCpobgoeTGfP5Xh1BwCP1oqoj',
    description: 'wBTC + ETH reserve flywheel', available: true,
  },
  meme: {
    key: 'meme', label: 'Meme',
    mint: 'HipYKXiDh3Kjd1jb7ji6jCEsKQMSGWiFJMdtvH8yb5r',
    description: 'Meme-token flywheel', available: true,
  },
};

const DEFAULT_FLYWHEEL_PERCENT = 10;
const FLYWHEEL_MIN_PERCENT = 10;
const FLYWHEEL_MAX_PERCENT = 30;
const SPLIT_MIN_COUNT = 1;
const SPLIT_MAX_COUNT = 10;
const LADDER_DEFAULT_PERCENT = 50;
const LADDER_MIN_PERCENT = 20;
const LADDER_MAX_PERCENT = 80;
const LADDER_DEFAULT_BANDS = 5;
const LADDER_MIN_BANDS = 3;
const LADDER_MAX_BANDS = 10;
const LADDER_CEILING_MULTIPLIER = 1000;
const MAX_TOKEN_SUPPLY = 10_000_000_000;
const MAX_LOGO_BYTES = 100 * 1024;
const MAX_LOGO_DIMENSION = 1024;
const MIN_LOGO_DIMENSION = 64;
const MAX_LOG_ENTRIES = 1500;
const PUBLIC_RPC_HOSTS = new Set([
  'api.mainnet-beta.solana.com', 'solana-api.projectserum.com',
  'rpc.ankr.com', 'solana.public-rpc.com',
]);

// --- Mutable state ---
let tempWallet = null;
let createdTokenInfo = null;
let fundingWallet = null;
let balancePollHandle = null;
let lpResult = null;
let pools = [];
let fundingRequirement = { solLamports: 0, byQuote: {}, autoSwapPlan: [] };
let simpleConfig = {
  name: '', symbol: '', supply: '', description: '', logo: null, logoDataUrl: null,
  useFlywheel: true, flywheelKey: 'meme', flywheelPercent: DEFAULT_FLYWHEEL_PERCENT,
  splitLp: false, splitCount: 1, totalMarketCap: '100000',
  bootstrapLp: false, bootstrapSol: '1.0',
  ladderEnabled: false, ladderPercent: LADDER_DEFAULT_PERCENT, ladderBands: LADDER_DEFAULT_BANDS,
  customizeMode: false,
};
let feeTiers = [];
let isRunningOperation = false;
let currentStep = 1;
let cancelMode = 'refund';
let _lastSeenServerLogSeq = 0;
let _serverLogStreamStarted = false;

const STEP_TITLES = {
  1: 'Generate Wallet', 2: 'Configure Token & Pools', 3: 'Fund Wallet',
  4: 'Create Token', 5: 'Create Pools', 6: 'Transfer Assets',
};

// Helper to build equal-split distribution
function buildEqualSplitDistribution(count, totalPct = 100) {
  if (count <= 0) return [];
  const base = Math.floor(totalPct / count);
  const remainder = totalPct - base * count;
  const dist = [];
  for (let i = 0; i < count; i++) dist.push(base + (i < remainder ? 1 : 0));
  return dist;
}
