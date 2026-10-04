const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

// Pair pools open this far above the SOL pool's price, so a pair token must
// fall past it before arbitrage can drain SOL buyers (see lpService
// allocationStartPrice).
const PAIR_START_PREMIUM_PCT = 25;

// New pools use Raydium's 0.25% tier (config 1, tick spacing 60).
// The smaller spacing-1 tiers caused routing and rent issues on launch ranges.
const DEFAULT_POOL_CONFIG_INDEX = 1;

const views = {
  coins: { eyebrow: '', title: 'Coins' },
  // A coin being created: the coin page with its creation steps.
  launch: { eyebrow: '', title: 'Coins' },
  nfts: { eyebrow: '', title: 'NFT collections' },
  lean: { eyebrow: '', title: 'Meteora launches' },
  wallet: { eyebrow: '', title: 'Wallet' },
  discovery: { eyebrow: '', title: 'Discovery' },
  settings: { eyebrow: '', title: 'Settings' },
};

const launchWorkspaces = [
  { id: 'wallet', title: 'Launch setup', detail: 'Choose the isolated local wallet that signs this launch.' },
  { id: 'configure', title: 'Token & pools', detail: 'Define the token, liquidity, distribution, and return wallet.' },
  { id: 'fund', title: 'Fund wallet', detail: 'Estimate the exact requirement, deposit SOL, and acquire quote tokens.' },
  { id: 'mint', title: 'Create token', detail: 'Review the permanent token facts, then mint and revoke authorities.' },
  { id: 'liquidity', title: 'Create liquidity', detail: 'Create pools and positions, lock liquidity, and deliver Fee Keys.' },
  { id: 'finish', title: 'Finish', detail: 'Run airdrops, sweep every remaining asset, and save launch record.' },
];


const EMPTY_ACCOUNT = Object.freeze({
  id: 'none',
  name: 'No wallet selected',
  address: 'Not connected',
  balance: 0,
  role: 'Generate or import a local wallet',
  rarity: 'Common',
  rarityGrade: 'common',
});

const WALLET_RARITY_CLASSES = Object.freeze([
  'wallet-rarity-common',
  'wallet-rarity-fine',
  'wallet-rarity-rare',
  'wallet-rarity-rati',
  'wallet-rarity-commissioned',
]);

const launchStages = [
  {
    id: 'wallet',
    title: 'Choose launch wallet',
    detail: 'Select the launch wallet and confirm its recovery protection.',
    criteria: ['wallet-lifecycle', 'vanity-options'],
  },
  {
    id: 'model',
    title: 'Review token and pools',
    detail: 'Confirm token metadata, liquidity, distribution, and the return wallet.',
    criteria: ['token-config-parity', 'pool-config-parity'],
  },
  {
    id: 'fund',
    title: 'Fund launch wallet',
    detail: 'Estimate the requirement, verify SOL, and acquire any required quote tokens.',
    criteria: ['funding-and-quote', 'held-reserve-backing'],
  },
  {
    id: 'live',
    title: 'Create token',
    detail: 'Create the mint and metadata, then confirm the authority posture.',
    requirements: ['live-proof'],
  },
  {
    id: 'report',
    title: 'Create liquidity',
    detail: 'Create pools and positions, lock liquidity, and deliver the Fee Keys.',
    requirements: ['live-proof'],
  },
  {
    id: 'compare',
    title: 'Finish and save proof',
    detail: 'Complete distribution, sweep the wallet, and retain the launch record.',
    requirements: ['report-proof'],
    criteria: ['sweep-report-proof'],
  },
];

const baseTransactions = [
  {
    id: 'tx-config',
    label: 'Seal launch configuration',
    risk: 'Low',
    cost: 0,
    state: 'pending',
    effects: ['Hashes token and pool settings', 'Stores the run checkpoint'],
  },
  {
    id: 'tx-funding',
    label: 'Verify funded launch wallet',
    risk: 'Medium',
    cost: 3.5,
    state: 'pending',
    effects: ['Checks launch wallet SOL and quote-token balances', 'Confirms the spending limit'],
  },
  {
    id: 'tx-mint',
    label: 'Create mint and metadata',
    risk: 'Low',
    cost: 0.024,
    state: 'pending',
    effects: ['Trebuchet signs mint creation locally', 'Uploads metadata', 'Creates launch wallet token account'],
  },
  {
    id: 'tx-authority',
    label: 'Revoke authorities',
    risk: 'Medium',
    cost: 0.006,
    state: 'pending',
    effects: ['Revokes mint authority', 'Revokes freeze authority', 'Locks metadata policy'],
  },
  {
    id: 'tx-pool',
    label: 'Create Raydium CLMM pools',
    risk: 'High',
    cost: 0.34,
    state: 'pending',
    effects: ['Creates SOL pool plan', 'Creates quote venue accounts', 'Checks price band inputs'],
  },
  {
    id: 'tx-lock',
    label: 'Open, lock, and transfer Fee Keys',
    risk: 'Medium',
    cost: 2.458,
    state: 'pending',
    effects: ['Opens main and support liquidity positions', 'Burn & Earn locks LP', 'Transfers Fee Keys'],
  },
  {
    id: 'tx-report',
    label: 'Publish launch report',
    risk: 'Low',
    cost: 0.002,
    state: 'pending',
    effects: ['Writes report hash', 'Exports local audit file', 'Prepares share link'],
  },
];

const guardrails = [
  { id: 'rpc', title: 'Dedicated RPC', detail: 'Mainnet launch is using a non-public RPC endpoint.', state: 'pass' },
  { id: 'authority', title: 'Authority posture', detail: 'Mint and freeze authorities are scheduled for revocation.', state: 'pass' },
  { id: 'preallocation', title: 'Preallocation optics', detail: 'Team/support allocation exceeds default threshold.', state: 'warn' },
  { id: 'wallet-control', title: 'Local signing wallet', detail: 'Trebuchet signs launch operations from its encrypted local wallet after the run is armed.', state: 'pass' },
  { id: 'resume', title: 'Recovery journal', detail: 'Every durable chain phase will be checkpointed.', state: 'pass' },
];

const parityFeatures = [
  { id: 'wallet', title: 'Launch wallet', real: true, preview: true, detail: 'Generate/import locally, show funding address, unlock with PIN.' },
  { id: 'grinder', title: 'Custom Vanity CA grinder', real: true, preview: true, detail: 'Starts, ends, starts-and-ends, saved candidates, native helper.' },
  { id: 'token', title: 'Token metadata', real: true, preview: true, detail: 'Name, ticker, supply, description, target market cap, logo handoff.' },
  { id: 'charts', title: 'Launch charts', real: true, preview: true, detail: 'Tokenomics, liquidity depth, funding, and run progress.' },
  { id: 'pool-model', title: 'Pool topology', real: true, preview: true, detail: 'Main pool, ladder bands, quote pools, Fee Key routing.' },
  { id: 'funding', title: 'Funding and acquire', real: true, preview: true, detail: 'Uses classic estimator and quote-token acquire job contract.' },
  { id: 'execution', title: 'Local run execution', real: true, preview: true, detail: 'Mint, pools, locks, airdrops, sweep, reports after one armed run.' },
  { id: 'recovery', title: 'Recovery journal', real: true, preview: true, detail: 'Reads local API inventory when available.' },
  { id: 'sweep-report', title: 'Sweep and report', real: true, preview: true, detail: 'Classic transfer, Fee Key, airdrop, sweep, and report surfaces represented.' },
];

const DEFAULT_SOL_MINT = 'So11111111111111111111111111111111111111112';
const DEFAULT_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const V2_REPORT_DATA_VERSION = 15;
const CLASSIC_QUOTE_VENUES = Object.freeze({
  meme: {
    key: 'meme',
    label: 'Meme flywheel',
    symbol: 'MEME',
    quoteToken: 'HipYKXiDh3Kjd1jb7ji6jCEsKQMSGWiFJMdtvH8yb5r',
    quoteMint: 'HipYKXiDh3Kjd1jb7ji6jCEsKQMSGWiFJMdtvH8yb5r',
  },
  reserve: {
    key: 'reserve',
    label: 'Reserve flywheel',
    symbol: 'RESERVE',
    quoteToken: 'J1bZFRAFC8ALqAN7ktkcCpobgoeTGfP5Xh1BwCP1oqoj',
    quoteMint: 'J1bZFRAFC8ALqAN7ktkcCpobgoeTGfP5Xh1BwCP1oqoj',
  },
  usdc: {
    key: 'usdc',
    label: 'Stable USDC',
    symbol: 'USDC',
    quoteToken: 'USDC',
    quoteMint: DEFAULT_USDC_MINT,
  },
});
const CLASSIC_LADDER_DEFAULT_SUPPLY_PERCENT = 50;
const CLASSIC_LADDER_DEFAULT_CEILING_MULTIPLIER = 1000;
const CLASSIC_LADDER_MAX_BANDS = 20;
const CLASSIC_TOKEN_NAME_MAX_BYTES = 32;
const CLASSIC_TOKEN_SYMBOL_MAX_BYTES = 10;
const CLASSIC_TOKEN_DESCRIPTION_MAX_BYTES = 1000;
const CLASSIC_MAX_WHOLE_TOKEN_SUPPLY = 10_000_000_000n;
const CLASSIC_LOGO_MAX_BYTES = 100 * 1024;
// No chain limits pixels: the metadata holds a link, and the image is uploaded free under ~100 KB.
// The byte cap is the real limit; the report embeds the logo only when small and links it otherwise.
const CLASSIC_LOGO_MAX_DIMENSION = 1024;
const CLASSIC_LOGO_MIN_DIMENSION = 64;
const LOGO_SOURCE_MAX_BYTES = 10 * 1024 * 1024;
const LOGO_SOURCE_MAX_DIMENSION = 8192;
const LOGO_JPEG_QUALITY_STEPS = Object.freeze([0.9, 0.82, 0.74, 0.66, 0.58, 0.5, 0.42]);
const V2_REQUIRED_LAUNCH_PLAN_OPERATION_IDS = Object.freeze([
  'v2-wallet-and-ca',
  'v2-funding-check',
  'v2-mint-metadata',
  'v2-revoke-authorities',
  'v2-create-liquidity-pools',
  'v2-lock-liquidity',
  'v2-report-sweep',
]);
const EXECUTION_LEDGER_STORAGE_KEY = 'trebuchet:v2:execution-ledger:v1';
const EXECUTION_LEDGER_MAX_ENTRIES = 20;
const EXECUTION_LEDGER_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const LAUNCH_PROOF_STORAGE_KEY = 'trebuchet:v2:launch-proof:v1';
const LAUNCH_PROOF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LAUNCH_PROOF_STORAGE_LIMIT = 1000000;
const LAUNCH_PROOF_IMPORT_LIMIT = 2000000;
const WALLET_BALANCE_REFRESH_INTERVAL_MS = 8000;
const WALLET_BALANCE_FRESH_MS = 60 * 1000;
const CLASSIC_REPORT_COMPARISON_STORAGE_KEY = 'trebuchet:v2:classic-report-comparison:v1';
const CLASSIC_REPORT_COMPARISON_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CLASSIC_REPORT_COMPARISON_INPUT_LIMIT = 50000;
const CLASSIC_REPORT_COMPARISON_ROW_LIMIT = 80;
const CLASSIC_ARTIFACT_IMPORT_LIMIT = 1000000;
const V2_HTML_PROOF_AIRDROP_SAMPLE_LIMIT = 100;
const V2_VIEWPORT_SMOKE_REQUIRED_ASSETS = Object.freeze(['index.html', 'styles.css', 'api-client.js', 'app.js']);
// Mirror of ../../viewportSmokeContract.js. This file is a classic browser
// script and cannot import it, so test/viewport-smoke-contract.test.mjs
// asserts the two stay identical.
const V2_VIEWPORT_SMOKE_REQUIRED_CHECKS = Object.freeze([
  'launchVisible',
  'horizontalOverflow',
  'tokenomicsChart',
  'liquidityChart',
  'fundingMeter',
  'firstViewportFit',
  'terminalPanelFit',
  'discoveryTokenViewport',
  'keyboardWalkthrough',
]);
const DEFAULT_CLMM_FEE_TIERS = Object.freeze([
  { index: 4, tradeFeeRate: 100, tickSpacing: 1 },
  { index: 5, tradeFeeRate: 500, tickSpacing: 1 },
  { index: 1, tradeFeeRate: 2500, tickSpacing: 60 },
  { index: 3, tradeFeeRate: 10000, tickSpacing: 120 },
]);

const DISCOVERY_STORAGE_KEY = 'trebuchet:v2:discovery-registry:v1';
const DISCOVERY_STORAGE_MAX_ENTRIES = 40;
const DISCOVERY_STORAGE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;



const history = [];

// Developer checks (Classic comparison, proof audits, raw activity) stay out
// of the way unless asked for: open the app with ?dev, or set
// localStorage "trebuchet-developer" to "1".
try {
  const developer = new URLSearchParams(window.location.search).has('dev')
    || window.localStorage?.getItem('trebuchet-developer') === '1';
  if (developer) document.body.dataset.developer = '1';
} catch {
  // Storage can be unavailable; developer mode just stays off.
}

const state = {
  activeView: 'launch',
  // The open row of the coin's facts; null opens the row that needs doing.
  launchWorkspace: null,
  launchFactStates: null,
  launchChainCheck: null,
  launchChainCheckKey: null,
  verifyPanel: 'proof',
  accountId: null,
  selectedDiscoveryId: null,
  discovery: {
    activePane: 'tokens',
    sort: 'relevance',
    walletRenderLimit: 100,
    records: [],
    wallets: [],
    limits: {},
    snapshot: null,
    brandShield: null,
    job: { status: 'idle' },
    query: '',
    filter: 'all',
    inspecting: false,
    walletBusy: false,
    scanning: false,
    personalError: null,
    error: null,
    lastInspectedMint: null,
    paletteByMint: {},
    palettePending: new Set(),
  },
  launchMode: 'dry-run',
  environmentReady: false,
  environmentSwitching: false,
  launchStage: 0,
  simulated: false,
  tokenLogo: null,
  tokenLogoError: null,
  tokenLogoStamp: null,
  launchIdentity: {
    palette: null,
    posterDataUrl: null,
  },
  approvalOpen: false,
  activeApprovalId: null,
  transactions: [],
  launchPlan: null,
  staging: false,
  apiClient: null,
  apiStatus: 'loading',
  apiDetail: 'Checking local API...',
  demoActive: true,
  rpcActiveUrl: null,
  rpcSaved: [],
  rpcName: 'Mainnet',
  rpcHealth: 'unknown',
  rpcHealthLabel: 'unknown',
  rpcLatencyMs: null,
  rpcError: null,
  rpcBusy: null,
  rpcTestResult: null,
  viewportSmoke: null,
  appVersion: null,
  releaseUrl: 'https://github.com/AnOversizedMooseWithSocks/Trebuchet/releases',
  releaseTrust: {
    status: 'unsigned-test-artifact',
    label: 'Unsigned build',
    signingStatus: 'unsigned',
    notarizationStatus: 'not-notarized',
    platform: null,
    detail: 'Release downloads should be treated as unsigned and not notarized unless the release notes explicitly say otherwise.',
  },
  updateCheck: {
    available: false,
    checking: false,
    lastResult: null,
    lastCheckedAt: null,
    error: null,
  },
  secretPin: {
    configured: false,
    damaged: false,
    unlocked: false,
    locked: false,
    version: null,
    kdf: null,
    deviceSecretProtected: false,
    deviceSecretAvailable: true,
    busy: null,
  },
  recoveryPinOffered: false,
  recoveryPinGate: {
    open: false,
    value: '',
    status: 'idle',
    message: 'Enter your four-digit Recovery PIN.',
    reason: 'unlock',
  },
  prefs: {
    demoMode: true,
    publishLaunchReport: true,
    checkForUpdatesOnStartup: true,
  },
  recovery: {
    journals: [],
    pendingWallets: [],
    journalCount: 0,
    activeJournalCount: 0,
    failedJournalCount: 0,
    pendingWalletCount: 0,
  },
  recoveryStartupRouted: false,
  restoredLaunchJournalId: null,
  managedWallets: [],
  selectedWalletPublicKey: null,
  walletQr: {
    publicKey: null,
    qrCode: null,
    loading: false,
    error: null,
  },
  revealedWallet: null,
  revealError: null,
  revealingWalletPublicKey: null,
  discardingWalletPublicKey: null,
  sweepingWalletPublicKey: null,
  sweepAirdropProgress: null,
  heldWallets: { list: null, loading: false, at: 0, error: null, sweep: null },
  lastRecoverySweep: null,
  lastSecretPinReset: null,
  lastRunEnvelope: null,
  vanityCandidates: [],
  savedLaunches: [],
  loadedSavedLaunchId: null,
  vanityDetailsOpenedFor: null,
  flywheelPools: { meme: [], reserve: [] },
  vortexControl: null,
  memeFlywheelMint: null,
  selectedVanityPublicKey: null,
  vanityAvailable: false,
  vanityReason: null,
  vanityRunning: false,
  vanityProgress: null,
  vanityProgressStats: null,
  vanitySource: null,
  vanityInputError: null,
  classicFundingEstimate: null,
  quoteAcquire: {
    jobId: null,
    job: null,
    fingerprint: null,
    running: false,
    polling: false,
    error: null,
    lastUpdatedAt: null,
    notifiedDone: false,
  },
  manualPrefund: {
    walletPublicKey: null,
    balance: null,
    polling: false,
    error: null,
    lastUpdatedAt: null,
  },
  // Wallets proven to be the user's: the on-chain funder of the launch wallet
  // and wallets that signed a Trebuchet challenge.
  destinations: { funder: null, funders: [], signed: [], launchWallet: null, checkedAt: 0, waiting: false },
  // Funding wallets chosen to share the held-back tokens (by SOL sent).
  heldShare: { selected: [] },
  // Coin page: buy support for the coin's SOL pool.
  poolSupport: { status: 'idle', plan: null, result: null, error: null },
  // Coins are what the app is organized around. `key` is the open coin
  // ("draft:<id>" or "mint:<address>"); null shows the list.
  coins: { list: [], loaded: false, loading: false, error: null, key: null, detail: null, detailLoading: false, detailError: null, checked: {} },
  // Positions this app's wallets hold in the open coin's pools.
  coinPositions: { mint: null, list: [], withdrawals: [], loading: false, error: null, withdrawing: null },
  // How far above the SOL pool's price pair pools open. Restored launches
  // keep the value they were planned with (0 before this existed).
  pairStartPremiumPct: PAIR_START_PREMIUM_PCT,
  // Fee tier (AmmConfig index) of the SOL pool and the flywheel pair pool.
  // Restored launches keep the tiers they were planned with.
  solPoolConfigIndex: DEFAULT_POOL_CONFIG_INDEX,
  pairPoolConfigIndex: DEFAULT_POOL_CONFIG_INDEX,
  fundingWallet: {
    walletPublicKey: null,
    funder: null,
    amount: null,
    checking: false,
    checkedAt: null,
    exhausted: false,
    error: null,
  },
  solflare: {
    publicKey: null,
    status: 'Not connected',
    connecting: false,
    disconnecting: false,
    error: null,
    connectedAt: null,
  },
  quoteTokenInfo: {},
  clmmFeeTiers: DEFAULT_CLMM_FEE_TIERS.map((tier) => ({ ...tier })),
  clmmFeeTiersSource: 'fallback',
  clmmFeeTiersError: null,
  cancelRefund: {
    running: false,
    lastResult: null,
    error: null,
    completedAt: null,
  },
  executionReadiness: null,
  executionChecking: false,
  realExecutionRunning: false,
  fullRunRunning: false,
  fullRunStep: null,
  launchAfterArm: false,
  lastFullRun: null,
  lastRealExecution: null,
  executionLedger: [],
  launchProof: null,
  reportPublishing: false,
  lastReportPublish: null,
  airdropRunning: false,
  lastAirdropResult: null,
  demoLaunchRunning: false,
  lastDemoLaunchRun: null,
  lastLocalDossier: null,
  recoveryActionId: null,
  lastRecoveryResult: null,
  liveOps: {
    lp: null,
    lpCursor: 0,
    lpEvents: [],
    airdrop: null,
    airdropSnapshots: [],
    logs: [],
    logCursor: 0,
    walletPublicKey: null,
    polling: false,
    lastUpdatedAt: null,
  },
  activityLog: {
    open: false,
    filter: 'all',
  },
  lastClassicDiagnostic: null,
  baseManualLadderText: '',
  baseSupportDepth: 12,
  baseSupportLayersText: '',
  launchPresetId: null,
  launchPresetSignature: null,
  // The SOL pool's venue: Raydium CLMM, or a Meteora DAMM v2 pool (one locked position).
  solPoolVenue: 'raydium',
  solPoolDamm: { feeBps: 25, rangeMultiple: 1000 },
  quotePoolVenue: 'raydium',
  quotePoolDamm: { feeBps: 25, rangeMultiple: 1000 },
  customPools: [],
  customPoolCounter: 0,
  airdropCsvText: '',
  airdropParseError: null,
  airdropBudgetError: null,
  airdropRecipients: [],
};

let liveOpsTimer = null;
let quoteAcquireTimer = null;
let recoveryPinGatePromise = null;
let recoveryPinGateResolve = null;
let recoveryPinGateTimer = null;
let recoveryPinReturnFocus = null;
let operatorPromptResolver = null;
let operatorPromptConfig = null;
let operatorPromptReturnFocus = null;
let sweepConfirmationReturnFocus = null;
let activityLogReturnFocus = null;
let solflareWalletProvider = null;
let solflareStandardProvider = null;
let solflareWalletStandardListenersStarted = false;
const solflareWalletStandardWallets = [];
const SOLFLARE_PROVIDER_WAIT_MS = 1500;

function walletIsUnlocked() {
  return window.TrebuchetV2RuntimeState?.walletUnlocked({
    wallet: selectedManagedWallet(),
    secretPin: state.secretPin,
    demoActive: state.demoActive,
  }) === true;
}

function walletLockReason() {
  return window.TrebuchetV2RuntimeState?.walletLockReason({
    wallet: selectedManagedWallet(),
    secretPin: state.secretPin,
    demoActive: state.demoActive,
  }) || 'no-wallet';
}

function authoritativeNetworkLabel() {
  return window.TrebuchetV2RuntimeState?.networkLabel({
    demoActive: state.demoActive,
    rpcName: state.rpcName,
    rpcActiveUrl: state.rpcActiveUrl,
  }) || 'RPC unavailable';
}

function v2LocalStorage() {
  try {
    return window.localStorage || null;
  } catch {
    return null;
  }
}

function practiceEnvironmentSelected() {
  if (!state.environmentReady) return true;
  return state.launchMode === 'dry-run' || state.demoActive;
}

function executionEnvironmentId() {
  if (!state.environmentReady) return 'loading';
  return practiceEnvironmentSelected() ? 'practice' : 'live';
}

function renderEnvironmentControls() {
  const environment = executionEnvironmentId();
  document.body.dataset.executionEnvironment = environment;
  // A coin that has a mint was made in one mode; switching would make its facts lie.
  const fixedByMint = state.activeView === 'launch' && Boolean(proofTokenMint(currentLaunchProof()));
  const settingsEnvironment = $('#launchSettingsEnvironment');
  if (settingsEnvironment) {
    const networkName = (value) => (value === 'devnet' ? 'Devnet' : value === 'mainnet' ? 'Mainnet' : '');
    const network = networkName(state.chainNetwork);
    if (state.networkMismatch && environment === 'live') {
      // The app's network and its RPC's disagree: say so and offer both ways out.
      settingsEnvironment.innerHTML = `<span class="network-mismatch" role="alert"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> Network is ${escapeHtml(network)}, RPC is ${escapeHtml(networkName(state.rpcNetwork))}</span>
        <button class="pill-button" type="button" data-action="reconcile-network" data-match="rpc">Use ${escapeHtml(networkName(state.rpcNetwork))}</button>
        <button class="pill-button" type="button" data-action="reconcile-network" data-match="network">Use a ${escapeHtml(network)} RPC</button>`;
    } else {
      settingsEnvironment.textContent = fixedByMint
        ? `Fixed by this coin's mint${network ? ` · ${network}` : ''}`
        : environment === 'live' ? `${network || 'Live'} · real transactions and SOL` : 'Nothing is sent';
    }
  }
  $$('.mode-button').forEach((button) => {
    button.classList.toggle('is-selected', button.dataset.mode === state.launchMode);
  });
  $$('.environment-button').forEach((button) => {
    const selected = button.dataset.environment === environment;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
    button.tabIndex = selected ? 0 : -1;
    button.disabled = state.environmentSwitching || environment === 'loading' || (fixedByMint && !selected);
  });
}

async function setExecutionEnvironment(environment, { announce = true } = {}) {
  const targetPractice = environment !== 'live';
  if (state.environmentSwitching) return false;
  if (state.environmentReady && targetPractice === practiceEnvironmentSelected()) return true;
  state.environmentSwitching = true;
  renderAll();
  try {
    const changed = await setDemoMode(targetPractice, { announce: false });
    if (!changed) return false;
    state.launchMode = targetPractice ? 'dry-run' : 'guarded';
    state.lastDemoLaunchRun = null;
    if (announce) {
      notify(targetPractice
        ? 'Test mode: nothing is sent'
        : 'Live environment selected: guarded on-chain execution');
    }
    return true;
  } catch (error) {
    notify(error.message || `Could not select ${targetPractice ? 'Test' : 'Live'}`);
    return false;
  } finally {
    state.environmentSwitching = false;
    renderAll();
  }
}


async function reconcileNetwork(match) {
  if (!state.apiClient?.reconcileNetwork) return;
  try {
    const result = await state.apiClient.reconcileNetwork(match);
    state.chainNetwork = result?.config?.activeNetwork || result?.network || state.chainNetwork;
    state.rpcNetwork = result?.config?.rpcNetwork || state.rpcNetwork;
    state.networkMismatch = result?.config?.networkMismatch === true;
    state.rpcActiveUrl = result?.config?.active || state.rpcActiveUrl;
    renderAll();
    notify(`Network and RPC now both ${state.chainNetwork === 'devnet' ? 'devnet' : 'mainnet'}`);
  } catch (error) {
    notify(error.message || 'Could not match the network and RPC');
  }
}
