import { createWalletExecutionRuntime } from './walletExecution.js';
import { createLaunchExecutionServices, claimLaunchOperation, LaunchRejection } from './launchExecution.js';
import express from 'express';
import { acquireProfileOwner } from '@trebuchet/runtime/owner';
import { createRuntimeControl } from '@trebuchet/runtime/control';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { V2_VIEWPORT_SMOKE_REQUIRED_CHECKS } from './viewportSmokeContract.js';
import dnsPromises from 'node:dns/promises';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';

import {
  createTokenWithMetaplex,
  finishTokenCreation,
  revealSealedTokenMetadata,
  uploadSealedIdentity,
  inspectTokenCreationStatus,
  generateTemporaryWallet,
  getWalletQRCode,
  checkWalletBalance,
  findFundingWallet,
  findFundingWallets,
  normalizeMintFormat,
  refreshConnection as refreshTokenServiceConnection,
} from './tokenService.js';

import {
  createPoolsAndPositions,
  preflightCreatePoolsAndPositions,
  estimateRequiredFunding,
  getUsdPrice,
  getTokenMetadata,
  getClmmFeeTiers,
  getMintCompatibilityWithRaydiumClmm,
  KNOWN_QUOTES,
  KNOWN_SAFE_QUOTES,
  getQuoteTokenOnChainPrice,
  previewSolSupport,
  openSolSupport,
  findSolClmmPoolForToken,
  listTokenMarkets,
  listCoinPositions,
  withdrawPosition,
} from './lpService.js';
import { WSOL_MINT as WSOL_MINT_ADDRESS } from './lpConstants.js';

import { swapSolForQuote, probeRaydiumPriceStrict, discoverJupiterRoute } from './swapService.js';
import { estimateAirdropExecutionCostSol } from './lpConstants.js';

import {
  checkWalletBalanceMultiToken,
  sweepNftsToDestination as sweepNftsWithSigner,
  sweepAllTokensToDestination as sweepTokensWithSigner,
  executeAirdrop,
} from './walletHelpers.js';

import {
  getConfig as getRpcConfig,
  getRpcUrl,
  setActiveRpc,
  addSavedRpc,
  removeSavedRpc,
  testRpc,
  getNetwork,
  setNetwork,
} from './rpcConfig.js';

import * as pendingWallets from './pendingWallets.js';
import * as vanityCaStore from './vanityCaStore.js';
import * as secretStore from './secretStore.js';
import { createLaunchReportUmi, publishLaunchReport } from './launchReportService.js';
import * as launchJournal from './launchJournal.js';
import * as launchStore from './launchStore.js';
import * as coinStore from './coinStore.js';
import { mergeCoins, validMint, readMintAccount } from './coinService.js';
import * as launchFlywheels from './launchFlywheels.js';
import * as userPrefs from './userPrefs.js';
import {
  getCachedImage,
  putCachedImage,
  recentImageFailure,
  rememberImageFailure,
  isContentAddressed,
} from './imageCache.js';
import * as discoveryStore from './discoveryStore.js';
import * as brandShieldStore from './brandShieldStore.js';
import { getSealedIdentity, removeSealedIdentity } from './sealedIdentityStore.js';
import { stampLogoDataUrl } from './logoStampService.js';
import * as updateCheckBridge from './updateCheckBridge.js';
import * as demoChainService from './demoChainService.js';
import {
  Connection,
  Keypair,
  PublicKey,
} from '@solana/web3.js';
import bs58 from 'bs58';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import {
  detectLogoImageDimensions,
  normalizeTokenDescription,
  normalizeLogoImageMime,
  assertLogoConstraints,
  normalizeTokenName,
  normalizeTokenSymbol,
  normalizeVanityTargetBase58,
  normalizeWholeTokenSupply,
} from './validators.js';
import { expectedVanityAttempts, unsafeSweepDestinationReason } from '@trebuchet/core/validators';
import * as destinationProofStore from './destinationProofStore.js';
import * as splitJobStore from './splitJobStore.js';
import * as nftCollectionStore from './nftCollectionStore.js';
import { registerNftRoutes } from './nftRoutes.js';
import { combineSplitKey, createSplitSecret, matchesVanityPattern } from '@trebuchet/core/split-key';
import { normalizeDistribution } from './lpDistribution.js';
import { isWalletEffectivelyEmpty } from './walletRecovery.js';
import {
  buildV2RecoveryAuthorizationPlan,
  buildV2ExecutionReadiness,
  buildV2LaunchPlan,
  verifyLaunchPlan,
  v2FundingEstimateFingerprint,
} from './v2LaunchPlan.js';
import {
  applyLpEventToResults,
  buildV2ExecutionContext,
  hasCompletedLpResults,
  journalResultList,
  latestEventsByIndex,
  priorResultsFromJournal,
  unsafeCreatedPoolEvents,
  v2TransferHasWalletEmptyFinalSweepEvidence,
  v2TransferSweepErrorCount,
} from './v2ExecutionContext.js';
import {
  buildDiscoveryRecord,
  discoveryRpcCandidates,
  fetchDiscoveryMarketData,
  isMissingMintRpcError,
} from './discoveryService.js';
import {
  assessBrandRisk,
  buildBrandFingerprint,
  fetchMetadataFingerprint,
  findDexScreenerBrandCandidates,
  signLaunchAttestation,
} from './brandShieldService.js';
import {
  PERSONAL_DISCOVERY_LIMITS,
  scanPersonalDiscovery,
  selectPersonalDiscoveryWallets,
} from './personalDiscoveryService.js';
import {
  redactSensitiveLogArgs,
  redactSensitiveText,
  redactUrl,
} from './logRedaction.js';
import { finishSweepWithSolGate } from './sweepOrchestrator.js';

// In-flight airdrop guard. Maps wallet public key → boolean (currently
// running). Used to reject concurrent /api/transfer-assets and
// /api/retry-airdrop calls against the same launch wallet — a second
// concurrent call would re-send transactions while the first is still
// running, risking double-payment to recipients whose first-pass tx
// already landed.
//
// This is an in-memory guard. It does NOT survive a server restart
// (intentionally — if the server crashed mid-airdrop, the in-flight
// run is no longer in flight; the user should be able to retry the
// failed recipients without artificial blocking). It DOES protect
// against the much-more-common case of: user clicks button, network
// is slow, user clicks again thinking nothing happened.
//
// The Map approach scales to many concurrent launches (different
// wallets); each wallet's airdrop is independent. Entries are added
// when an airdrop step begins and deleted on completion (success or
// failure) in a try/finally to guarantee cleanup even on uncaught
// throws.
const airdropsInFlight = new Map();
function airdropInFlight(walletPublicKey) {
  return airdropsInFlight.get(walletPublicKey) === true;
}
function markAirdropInFlight(walletPublicKey) {
  airdropsInFlight.set(walletPublicKey, true);
}
function clearAirdropInFlight(walletPublicKey) {
  airdropsInFlight.delete(walletPublicKey);
}

// ---------------------------------------------------------------------------
// Per-wallet launch-operation mutex.
//
// Every chain-touching launch operation (token creation, quote-token
// acquisition, pool creation, resume, asset transfer) is long-running and
// mutates the same ephemeral wallet's balances. Running two of them
// concurrently for the same wallet is never correct:
//
//   - create-lp twice          -> duplicate pools, double-spent supply
//   - create-lp + transfer     -> sweep pulls tokens out from under the
//                                 launch mid-flight
//   - acquire twice            -> double swap, double the SOL spent
//   - create-lp + resume       -> two orchestrators fighting over the
//                                 same positions
//
// How would a double-submit even happen, given the frontend disables its
// buttons? The server runs in-process with Electron main, so a renderer
// crash/reload mid-launch reloads the UI while the launch KEEPS RUNNING
// in the background. The user then recovers the pending wallet and clicks
// Create Pools (or Resume) again — and without this guard, a second
// orchestrator starts against the same wallet while the first is still
// going. A slow network double-click is the other path.
//
// Guarded endpoints check this map after resolving the wallet public key
// and return HTTP 409 with code 'OP_IN_FLIGHT' if another operation is
// already running. The frontend translates that into "an operation is
// already running for this wallet — wait for it to finish" instead of
// letting the user double-fire.
//
// In-memory only, like airdropsInFlight: if the app restarts, any
// in-flight operation died with it, so a fresh map is the correct state.
// Entries are cleared in try/finally so even an uncaught throw releases
// the lock.
const launchOpsInFlight = new Map(); // walletPublicKey -> { op, startedAt }

// Armed v2 run envelopes are server-owned authorization records. Renderer
// state alone must never be enough to execute a real launch operation.
const V2_RUN_ENVELOPE_TTL_MS = 4 * 60 * 60 * 1000;
const v2RunEnvelopes = new Map(); // envelope id -> authorization record
const V2_RECOVERY_ENDPOINTS = new Set([
  '/api/finish-token-creation',
  '/api/resume-launch',
  '/api/reveal-sealed-metadata',
  '/api/transfer-assets',
]);

function v2RecoveryAuthorizationOperation(endpoint, readiness = {}) {
  const operation = {
    '/api/finish-token-creation': {
      id: 'v2-recovery-finish-token',
      label: 'Finish the existing token',
      stage: 'mint',
      effects: ['Reuse the recorded mint and execute only missing token-safety steps.'],
    },
    '/api/resume-launch': {
      id: 'v2-recovery-resume-liquidity',
      label: 'Resume missing liquidity work',
      stage: 'liquidity',
      effects: ['Reuse recorded pools and positions; execute only missing durable checkpoints.'],
    },
    '/api/reveal-sealed-metadata': {
      id: 'v2-recovery-reveal-metadata',
      label: 'Reveal the committed token identity',
      stage: 'liquidity',
      effects: ['Publish the committed identity after liquidity is locked, then make metadata immutable.'],
    },
    '/api/transfer-assets': {
      id: 'v2-recovery-final-sweep',
      label: 'Run final distribution and sweep',
      stage: 'sweep',
      effects: ['Distribute configured assets, sweep the launch wallet, and record terminal proof.'],
    },
  }[endpoint];
  return {
    ...operation,
    endpoint,
    risk: 'High',
    costSol: null,
    source: 'recovery-journal',
    signer: 'trebuchet-managed-launch-wallet',
    authorization: { type: 'recovery-envelope', requiredUserAction: 'unlock-and-arm' },
    simulation: readiness?.nextAction || operation?.label || 'Recovery operation',
    checks: ['Journal checkpoint verified', 'Endpoint revalidated immediately before execution'],
  };
}

function v2RecoveryAuthorizationPlan(plan, endpoint, readiness) {
  return buildV2RecoveryAuthorizationPlan({
    launchPlan: plan,
    nextEndpoint: endpoint,
    operation: v2RecoveryAuthorizationOperation(endpoint, readiness),
  });
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, stableJsonValue(value[key])]),
  );
}

function v2RunEnvelopeFundingHash(fundingEstimate) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableJsonValue(fundingEstimate || null)))
    .digest('hex');
}

function pruneV2RunEnvelopes(now = Date.now()) {
  for (const [id, envelope] of v2RunEnvelopes.entries()) {
    if (envelope.expiresAtMs <= now) v2RunEnvelopes.delete(id);
  }
}

function publicV2RunEnvelope(envelope) {
  return {
    id: envelope.id,
    walletPublicKey: envelope.walletPublicKey,
    signer: 'trebuchet-managed-launch-wallet',
    status: envelope.status,
    operationCount: envelope.operationCount,
    executedOperationCount: envelope.executedOperationCount,
    estimatedSolCost: envelope.estimatedSolCost,
    maxSpendSol: envelope.maxSpendSol,
    authorizationKind: envelope.authorizationKind || 'launch',
    nextEndpoint: envelope.nextEndpoint || null,
    requiresUserAction: envelope.status === 'complete'
      ? 'review-terminal-proof'
      : 'check-readiness-and-execute',
    armedAt: envelope.armedAt,
    expiresAt: envelope.expiresAt,
    lastExecutedEndpoint: envelope.lastExecutedEndpoint || null,
    plan: envelope.plan,
  };
}

function v2RunEnvelopeError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
}

function requireV2RunEnvelope(envelopeId, walletPublicKey) {
  pruneV2RunEnvelopes();
  if (!envelopeId) {
    throw v2RunEnvelopeError(
      'RUN_ENVELOPE_REQUIRED',
      'Arm the reviewed run envelope before executing a live launch operation.',
    );
  }
  const envelope = v2RunEnvelopes.get(envelopeId);
  if (!envelope) {
    throw v2RunEnvelopeError(
      'RUN_ENVELOPE_EXPIRED',
      'The armed run envelope is missing or expired. Review and arm the run again.',
    );
  }
  if (envelope.walletPublicKey !== walletPublicKey) {
    throw v2RunEnvelopeError(
      'RUN_ENVELOPE_MISMATCH',
      'The armed run envelope belongs to another launch wallet.',
    );
  }
  return envelope;
}

function launchOpInFlight(walletPublicKey) {
  return launchOpsInFlight.get(walletPublicKey) || null;
}
function clearLaunchOpInFlight(walletPublicKey) {
  launchOpsInFlight.delete(walletPublicKey);
}
// Live progress tracker for airdrops. Both the real executeAirdrop (in
// walletHelpers.js) and the demo simulateAirdrop (in demoChainService.js)
// write into this Map as they process recipients, one entry per launch
// wallet. The frontend polls /api/airdrop-progress every ~500ms during a
// transfer that includes an airdrop, so the user sees the progress bar
// tick forward in real time instead of staring at an unmoving spinner
// for 20-30 seconds.
//
// Shape:
//   {
//     total:       number      // total recipient count
//     completed:   number      // delivered so far (success only)
//     failedCount: number      // failed so far
//     lastWallet:  string|null // most recently processed recipient address
//     lastTokens:  number|null // tokens sent to that recipient
//     totalTokens: number      // sum of tokens across recipients (running)
//     status:      'running' | 'done'
//     startedAt:   number      // epoch ms when the airdrop started
//   }
//
// In-memory only — same lifecycle reasoning as airdropsInFlight. After
// status='done' is written we keep the entry for ~10 seconds so the
// frontend's last poll picks up the final state, then auto-clear it.
const airdropProgress = new Map();
function airdropProgressBegin(walletPublicKey, total) {
  airdropProgress.set(walletPublicKey, {
    total: Number(total) || 0,
    completed: 0,
    failedCount: 0,
    lastWallet: null,
    lastTokens: null,
    totalTokens: 0,
    status: 'running',
    startedAt: Date.now(),
  });
}
// Record one recipient's outcome. `success` flips the right counter and,
// on success, accumulates the token total. Cheap to call per recipient.
function airdropProgressStep(walletPublicKey, { recipient, tokens, success }) {
  const st = airdropProgress.get(walletPublicKey);
  if (!st) return;
  if (success) {
    st.completed += 1;
    st.totalTokens += Number(tokens) || 0;
  } else {
    st.failedCount += 1;
  }
  st.lastWallet = recipient || null;
  st.lastTokens = Number.isFinite(Number(tokens)) ? Number(tokens) : null;
}
// Mark done and schedule cleanup. The 10s delay gives the frontend one
// final poll to see the terminal state before the entry disappears.
function airdropProgressEnd(walletPublicKey) {
  const st = airdropProgress.get(walletPublicKey);
  if (!st) return;
  st.status = 'done';
  setTimeout(() => {
    const cur = airdropProgress.get(walletPublicKey);
    if (cur && cur.status === 'done') {
      airdropProgress.delete(walletPublicKey);
    }
  }, 10_000);
}
function airdropProgressGet(walletPublicKey) {
  return airdropProgress.get(walletPublicKey) || null;
}

// Per-launch LP progress event log. Demo mode and (eventually) real mode
// write into this Map as each step of pool/position creation completes;
// the frontend polls /api/lp-progress with a `since` cursor to learn
// about new events without re-streaming the whole log. Translates to row
// markings on the frontend's phase progress tree so individual rows
// tick from pending → done as the work progresses (instead of all
// flipping at once when the /api/create-lp response lands).
//
// Shape per wallet:
//   {
//     events: [{ stage, allocationIndex, sliceIndex?, bandIndex?, ... }, ...]
//     status: 'running' | 'done'
//     startedAt: epoch ms
//   }
//
// Same lifecycle as airdropProgress — in-memory, auto-cleared 30s after
// the run finishes so a slow last poll still picks up the terminal state.
const lpProgress = new Map();
function lpProgressBegin(walletPublicKey) {
  lpProgress.set(walletPublicKey, {
    events: [],
    status: 'running',
    startedAt: Date.now(),
  });
}
function lpProgressEvent(walletPublicKey, event) {
  const state = lpProgress.get(walletPublicKey);
  if (!state) return;
  state.events.push(event);
}
function lpProgressEnd(walletPublicKey) {
  const state = lpProgress.get(walletPublicKey);
  if (!state) return;
  state.status = 'done';
  setTimeout(() => {
    const cur = lpProgress.get(walletPublicKey);
    if (cur && cur.status === 'done') {
      lpProgress.delete(walletPublicKey);
    }
  }, 30_000);
}
function lpProgressGet(walletPublicKey, sinceIdx = 0) {
  const state = lpProgress.get(walletPublicKey);
  if (!state) return null;
  return {
    status: state.status,
    totalEvents: state.events.length,
    // Slice from `since` so a polling client only sees what it hasn't yet.
    events: state.events.slice(sinceIdx),
  };
}

// Lazy import to avoid crash on startup in packaged builds
let _generateVanityKeypair = null;
async function getVanityKeygen() {
  if (!_generateVanityKeypair) {
    const mod = await import('./vanityKeygen.js');
    _generateVanityKeypair = mod.generateVanityKeypair;
  }
  return _generateVanityKeypair;
}

// Cached vanity availability. Computed once at startup (see the log below
// the route table) and read by /api/demo/status + the vanity endpoints to
// short-circuit with a clean error when the binary isn't built. A Promise
// instead of a value because the import is async and we want a single
// settled result that everything can await.
let _vanityAvailabilityPromise = null;
function vanityAvailability() {
  if (!_vanityAvailabilityPromise) {
    _vanityAvailabilityPromise = import('./vanityKeygen.js').then(
      (mod) => mod.isVanityAvailable(),
      // If the import itself fails (file moved, syntax error, etc.) treat
      // vanity as unavailable rather than letting that error propagate
      // unrelated requests. The reason string surfaces in the UI so the
      // operator can see what's wrong.
      (err) => ({ available: false, reason: `vanity module load failed: ${err.message}` }),
    );
  }
  return _vanityAvailabilityPromise;
}

import {
  hostCheckMiddleware,
  securityHeadersMiddleware,
  apiSessionMiddleware,
  resolvePublicDir,
  upload,
  API_SESSION_TOKEN,
} from './serverMiddleware.js';


// Configuration constants are defined below in the "Configuration" section
// (just after __dirname is computed). Internal env vars (PORT,
// TREBUCHET_CONFIG_DIR) are still used — those are set by main.js at
// launch time and are how the Electron main process tells this embedded
// server which port to bind on and where to persist config. They're not
// user-facing config; users never set them.

// ===========================================================================
// Server-side log capture
// ===========================================================================
//
// The packaged Electron app hides the Node main process's console output —
// the user only sees browser DevTools (renderer console) and the in-app
// activity log. That makes it impossible to see anything server.js logs,
// which is exactly the information we need when debugging the auto-swap
// flow ("[acquire][jobId][w1] picked up xlrt", "concurrency=1", etc).
//
// Fix: capture console.log/warn/error into an in-memory ring buffer, and
// expose a /api/server-logs endpoint. The frontend polls this and mixes
// new entries into the activity log with a [server] prefix. The user sees
// everything the backend is doing without needing a terminal.
//
// We use a monotonic sequence number (not timestamp) for filtering on the
// frontend side, so ties in the same millisecond don't lose entries.

const _serverLogBuffer = [];
const SERVER_LOG_BUFFER_MAX = 1000;
let _serverLogSeq = 0;

function _captureLog(level, args) {
  let msg = '';
  try {
    msg = redactSensitiveLogArgs(args)
      .map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message;
        try { return JSON.stringify(a); } catch { return String(a); }
      })
      .join(' ');
  } catch (_) {
    msg = '[unable to format log entry]';
  }
  // Cap each entry to keep the buffer's memory footprint bounded even
  // when a single log entry is unusually large (e.g. a stringified
  // object with deep structure).
  if (msg.length > 4000) msg = msg.slice(0, 4000) + '…[truncated]';

  _serverLogBuffer.push({
    seq: ++_serverLogSeq,
    ts: Date.now(),
    level,
    msg,
  });
  // Trim to max size. shift() is O(N) but with N=1000 and trim happening
  // at most once per push, this is fine.
  if (_serverLogBuffer.length > SERVER_LOG_BUFFER_MAX) {
    _serverLogBuffer.shift();
  }
}

// Install capture only when the local API is constructed. Importing this
// module must be safe for Core, CLI, and tests: it must not replace process
// globals or bind a network port as a side effect.
let _consoleCaptureInstalled = false;
function installServerLogCapture() {
  if (_consoleCaptureInstalled) return;
  _consoleCaptureInstalled = true;
  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  console.log = (...args) => {
    try { _captureLog('info', args); } catch (_) { /* ignore */ }
    originalLog(...redactSensitiveLogArgs(args));
  };
  console.warn = (...args) => {
    try { _captureLog('warn', args); } catch (_) { /* ignore */ }
    originalWarn(...redactSensitiveLogArgs(args));
  };
  console.error = (...args) => {
    try { _captureLog('error', args); } catch (_) { /* ignore */ }
    originalError(...redactSensitiveLogArgs(args));
  };
}

// __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===========================================================================
// Configuration
// ===========================================================================
//
// User-facing configuration was previously loaded from a .env file via
// dotenv. That approach was removed for two reasons:
//
//   1. It didn't work reliably with electron-builder's "portable" target.
//      Portable builds extract the .exe to a random temp directory on each
//      launch, so process.cwd() / process.execPath / process.resourcesPath
//      all point inside that temp directory — not next to the actual .exe
//      the user double-clicked. Users had no way to drop a .env file where
//      the app would reliably find it.
//
//   2. The only setting that really varies per user is the RPC endpoint,
//      which is already fully manageable through the in-app RPC settings
//      UI (rpcConfig.js: addSavedRpc / setActiveRpc / removeSavedRpc /
//      testRpc). Choices are persisted to the user's config directory and
//      survive restarts.
//
// To change the values below, edit this file and rebuild. They're at the
// top of the file so they're easy to find.
//
// Internal env vars (PORT, TREBUCHET_CONFIG_DIR) are set by main.js at
// launch time — those aren't user-facing config, they're how the Electron
// main process talks to this embedded server. They stay.

/**
 * Number of parallel workers in the auto-swap pool. Each worker handles
 * one swap at a time; the queue of pending swaps drains as workers finish.
 * Higher = faster overall, but more parallel RPC load (which can trigger
 * rate limits on free-tier endpoints). 4 is a good balance for most users;
 * drop to 1 for sequential debugging or if your RPC has tight rate limits.
 */
const AUTOSWAP_CONCURRENCY = 1;

export function createLocalApiApp({ runtimeControl = null, runtimeOwner = null } = {}) {
const walletExecution = runtimeOwner ? createWalletExecutionRuntime({
  owner: runtimeOwner,
  getScopeId: (walletPublicKey) => launchJournal.activeForWallet(walletPublicKey)?.id,
}) : null;
const requireWalletExecution = () => {
  if (!walletExecution) throw Object.assign(new Error('Start the owned runtime before live transfers.'), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  return walletExecution;
};
const sweepSolToDestination = (input) => requireWalletExecution().sweepSolToDestination(input);
const transferMetadataAuthority = (input) => requireWalletExecution().transferMetadataAuthority(input);
const reconcileWalletOperation = (input) => requireWalletExecution().recover(input);
const sweepNftsToDestination = (input) => sweepNftsWithSigner({ ...input, transferToken: requireWalletExecution().transferTokenWithProgram });
const sweepAllTokensToDestination = (input) => sweepTokensWithSigner({ ...input, transferToken: requireWalletExecution().transferTokenWithProgram });

// Live services and HTTP jobs share wallet admission and durable recovery state.
function claimLaunchOp(walletPublicKey, op) {
  const pending = walletExecution?.active(walletPublicKey);
  const canResumeMetadata = pending?.kind === 'metadata-update' && pending.payload.makeImmutable
    && ['reveal-sealed-metadata', 'create-lp', 'resume-launch'].includes(op);
  if (pending && op !== 'transfer-assets' && !canResumeMetadata) {
    throw new LaunchRejection(409, { success: false, code: 'EXECUTION_RECOVERY_REQUIRED', operationId: pending.id, error: 'Resume the saved wallet operation before starting another wallet action.' });
  }
  claimLaunchOperation(launchOpsInFlight, walletPublicKey, op);
}
function rejectOrClaimLaunchOp(res, walletPublicKey, op) {
  try { claimLaunchOp(walletPublicKey, op); return false; }
  catch (error) { if (!(error instanceof LaunchRejection)) throw error; sendErrorResponse(res, error); return true; }
}

// The Raydium SDK prints every simulated transaction ("simulate tx
// string: [<base64>...]") with a bare console.log. It is noise in the app
// log; drop just that message.
const sdkConsoleLog = console.log.bind(console);
console.log = (...args) => {
  if (args[0] === 'simulate tx string:') return;
  sdkConsoleLog(...args);
};

const app = express();
installServerLogCapture();

// Boot-time log: confirms which config values the server is actually
// using on this launch. Streams to the in-app activity log via the
// console-capture wiring above.
console.log(`[boot] AUTOSWAP_CONCURRENCY = ${AUTOSWAP_CONCURRENCY}`);
console.log('[boot] RPC endpoint: configured via in-app RPC settings');

// ---------------------------------------------------------------------------
// Demo mode predicate.
//
// When demo mode is on (a user preference, persisted in userPrefs.json),
// every chain-touching /api/* handler below returns early by delegating to
// demoChainService.js — no transactions are sent, no SOL is spent. The real
// service modules are never touched, so real-mode behaviour cannot regress.
//
// Read fresh from userPrefs on every call (the file is tiny) so the renderer
// toggling the setting takes effect immediately on the next request without
// any server restart or IPC plumbing.
// ---------------------------------------------------------------------------
function isDemoMode() {
  try {
    return userPrefs.get().demoMode === true;
  } catch (_) {
    return false;
  }
}

function secretPinLockedError(action = 'use saved recovery secrets') {
  const error = new Error(`Unlock your Recovery PIN before ${action}.`);
  error.statusCode = 423;
  error.code = 'SECRET_PIN_LOCKED';
  return error;
}

function sendErrorResponse(res, error, fallbackStatus = 500) {
  if (error instanceof LaunchRejection) return res.status(error.statusCode).json(error.payload);
  const status = error?.statusCode || error?.status || fallbackStatus;
  const body = {
    success: false,
    error: launchJournal.errorMessage(error),
  };
  if (error?.code) body.code = error.code;
  if (error?.operationId) body.operationId = error.operationId;
  if (error?.errorDetails) body.errorDetails = error.errorDetails;
  if (error?.failedPhase) body.failedPhase = error.failedPhase;
  if (error?.failedAllocationIndex !== undefined) body.failedAllocationIndex = error.failedAllocationIndex;
  if (error?.failedAllocation !== undefined) body.failedAllocation = error.failedAllocation;
  if (error?.probeCode) body.probeCode = error.probeCode;
  if (error?.code === 'SECRET_PIN_LOCKED') body.secretPinLocked = true;
  res.status(status).json(body);
}

async function requireTokenCompleteForLiquidity({
  tokenMint,
  tokenTotalSupply,
  tokenDecimals = 9,
} = {}) {
  if (!tokenMint || tokenTotalSupply == null) {
    throw new LaunchRejection(400, {
      success: false,
      code: 'TOKEN_PLAN_INCOMPLETE',
      error: 'Token mint and total supply are required before liquidity can run.',
    });
  }
  const tokenStatus = await inspectTokenCreationStatus({
    tokenMint,
    totalSupply: tokenTotalSupply,
    decimals: tokenDecimals,
  });
  if (tokenStatus.complete) return;
  throw new LaunchRejection(409, {
    success: false,
    code: 'TOKEN_CREATION_INCOMPLETE',
    nextEndpoint: '/api/finish-token-creation',
    tokenStatus,
    error: 'The existing token is not finished yet. Complete its supply and authority-safety steps before creating or resuming liquidity.',
  });
}

async function rejectIfTokenIncompleteForLiquidity(res, input) {
  try { await requireTokenCompleteForLiquidity(input); return false; }
  catch (error) { if (!(error instanceof LaunchRejection)) throw error; sendErrorResponse(res, error); return true; }
}

function launchFailureDetails(error, context = {}) {
  return launchJournal.errorDetails(error, context);
}

function requireSecretPinUnlocked(action) {
  if (!secretStore.isSecretPinLocked()) return;
  const error = secretPinLockedError(action);
  throw new LaunchRejection(423, { success: false, error: error.message, code: error.code, secretPinLocked: true });
}

function rejectIfSecretPinLocked(res, action) {
  try { requireSecretPinUnlocked(action); return false; }
  catch (error) { if (!(error instanceof LaunchRejection)) throw error; sendErrorResponse(res, error); return true; }
}

function migrateSecretsToUnlockedPin() {
  // These loads opportunistically rewrite legacy/plain/safeStorage tokens
  // into pin: tokens when the PIN key is currently unlocked.
  pendingWallets.list();
  vanityCaStore.list();
}



// ---------------------------------------------------------------------------
// Middleware pipeline
// ---------------------------------------------------------------------------
// The middleware functions are defined in serverMiddleware.js so they can
// be unit-tested independently. Registration order matters:
//   1. hostCheckMiddleware — DNS rebinding defense (before body parser so
//      a rejected request never has its body read into memory).
//   2. securityHeadersMiddleware — CSP + frame/type-sniff headers.
//   3. /api/session route — hands out the session token. Registered
//      BEFORE apiSessionMiddleware so it doesn't get gated by itself.
//      (The middleware has a safety exemption for /session anyway, but
//      relying on route-ordering keeps the intent clear.)
//   4. apiSessionMiddleware — gates all /api/* mutating routes behind
//      the session token. /proxy-image and /generate-vanity-wallet-stream
//      are exempted inside the middleware.
//   5. express.json — body parser. Registered AFTER the host check and
//      session gate so we don't waste memory parsing rejected requests.
app.use(hostCheckMiddleware);
app.use(securityHeadersMiddleware);
if (runtimeControl) app.use(runtimeControl);

// CORS is intentionally not configured. The Trebuchet frontend loads from
// http://127.0.0.1:<port> and the API serves from the same origin, so no
// CORS headers are needed for legitimate use. The previous wildcard
// `app.use(cors())` set Access-Control-Allow-Origin: * — appropriate only
// for genuinely public APIs, and it would weaken the Host-header defense
// above by giving cross-origin preflights a free pass.
// Same-origin API session token. Host-header checks block DNS rebinding, and
// this header blocks browser form posts or other tokenless local requests from
// mutating the launcher API. The frontend gets the token through /api/session;
// cross-origin pages can make that request, but cannot read the response
// without CORS, so they cannot attach the required header.
app.get('/api/session', (_req, res) => {
  res
    .set('Cache-Control', 'no-store')
    .json({ success: true, token: API_SESSION_TOKEN });
});

app.use('/api', apiSessionMiddleware);

app.use(express.json({ limit: '5mb' }));

const publicDir = resolvePublicDir(__dirname);
const V2_VIEWPORT_SMOKE_PROOF_FILE = 'viewport-smoke-proof.json';
const V2_VIEWPORT_SMOKE_PROOF_ASSETS = ['index.html', 'styles.css', 'api-client.js', 'app.js'];


function sha256FileHex(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function currentV2ViewportSmokeAssetHashes() {
  const v2Dir = path.join(publicDir, 'v2');
  return Object.fromEntries(V2_VIEWPORT_SMOKE_PROOF_ASSETS.map((file) => [
    file,
    sha256FileHex(path.join(v2Dir, file)),
  ]));
}

function compactViewportSmokeRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    name: String(row?.name || ''),
    width: Number(row?.width || 0),
    height: Number(row?.height || 0),
    passed: row?.passed === true,
    checks: row?.checks && typeof row.checks === 'object' ? row.checks : {},
  })).filter((row) => row.name);
}

function missingViewportSmokeChecks(row = {}) {
  const checks = row?.checks && typeof row.checks === 'object' ? row.checks : {};
  return V2_VIEWPORT_SMOKE_REQUIRED_CHECKS.filter((check) => checks[check] !== true);
}

function viewportSmokeRequiredChecksMatch(recordedChecks = []) {
  return Array.isArray(recordedChecks)
    && recordedChecks.length === V2_VIEWPORT_SMOKE_REQUIRED_CHECKS.length
    && V2_VIEWPORT_SMOKE_REQUIRED_CHECKS.every((check, index) => recordedChecks[index] === check);
}

function readV2ViewportSmokeProof() {
  const proofPath = path.join(publicDir, 'v2', V2_VIEWPORT_SMOKE_PROOF_FILE);
  if (!fs.existsSync(proofPath)) {
    return {
      passed: false,
      state: 'missing',
      detail: 'Run npm run test:v2:viewport to generate desktop/mobile viewport-smoke proof.',
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
  } catch (error) {
    return {
      passed: false,
      state: 'invalid',
      detail: `Viewport smoke proof could not be parsed: ${error.message}`,
    };
  }

  const generatedAt = parsed?.generatedAt || null;
  const command = parsed?.command || null;
  const artifactVersion = parsed?.artifactVersion ?? null;
  const kind = parsed?.kind || null;
  const recordedRequiredChecks = Array.isArray(parsed?.requiredChecks)
    ? parsed.requiredChecks.map((check) => String(check || '')).filter(Boolean)
    : [];
  const requiredChecksMatch = viewportSmokeRequiredChecksMatch(recordedRequiredChecks);
  const viewports = compactViewportSmokeRows(parsed?.viewports);
  const requiredViewportNames = ['desktop', 'mobile'];
  const requiredViewportFailures = requiredViewportNames.flatMap((name) => {
    const row = viewports.find((item) => item.name === name);
    if (!row) return [`${name}: missing viewport`];
    const failures = [];
    if (row.passed !== true) failures.push(`${name}: viewport did not pass`);
    failures.push(...missingViewportSmokeChecks(row).map((check) => `${name}: ${check}`));
    return failures;
  });
  const requiredViewportsPassed = requiredViewportNames.every((name) => (
    viewports.some((row) => (
      row.name === name
      && row.passed === true
      && missingViewportSmokeChecks(row).length === 0
    ))
  ));
  const currentAssetHashes = currentV2ViewportSmokeAssetHashes();
  const recordedAssetHashes = parsed?.assetHashes && typeof parsed.assetHashes === 'object'
    ? parsed.assetHashes
    : {};
  const staleAssets = V2_VIEWPORT_SMOKE_PROOF_ASSETS.filter((file) => (
    recordedAssetHashes[file] !== currentAssetHashes[file]
  ));

  if (
    parsed?.artifactVersion !== 1
    || parsed?.kind !== 'trebuchet-v2-viewport-smoke'
    || parsed?.passed !== true
    || !requiredChecksMatch
    || !requiredViewportsPassed
  ) {
    return {
      passed: false,
      state: 'invalid',
      detail: requiredViewportFailures.length
        ? `Viewport smoke proof is incomplete or did not pass both desktop and mobile. Missing checks: ${requiredViewportFailures.slice(0, 6).join(', ')}${requiredViewportFailures.length > 6 ? ', ...' : ''}.`
        : !requiredChecksMatch
          ? 'Viewport smoke proof was generated with a stale required-check contract; rerun npm run test:v2:viewport.'
        : 'Viewport smoke proof is incomplete or did not pass both desktop and mobile.',
      artifactVersion,
      kind,
      generatedAt,
      command,
      viewports,
      requiredChecks: recordedRequiredChecks,
      expectedRequiredChecks: V2_VIEWPORT_SMOKE_REQUIRED_CHECKS,
      assetHashes: recordedAssetHashes,
      expectedAssetHashes: currentAssetHashes,
    };
  }

  if (staleAssets.length > 0) {
    return {
      passed: false,
      state: 'stale',
      detail: `Viewport smoke proof is stale for current v2 assets: ${staleAssets.join(', ')}.`,
      artifactVersion,
      kind,
      generatedAt,
      command,
      viewports,
      requiredChecks: V2_VIEWPORT_SMOKE_REQUIRED_CHECKS,
      assetHashes: recordedAssetHashes,
      expectedAssetHashes: currentAssetHashes,
    };
  }

  return {
    passed: true,
    state: 'valid',
    detail: `Viewport smoke passed for ${requiredViewportNames.join(', ')}.`,
    artifactVersion,
    kind,
    generatedAt,
    command,
    viewports,
    requiredChecks: V2_VIEWPORT_SMOKE_REQUIRED_CHECKS,
    assetHashes: currentAssetHashes,
  };
}

app.use(express.static(publicDir));

// Routes
app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Opt-in diagnostic endpoint for splash-video 404 debugging. It reports local
// filesystem/process paths, so keep it unavailable in normal desktop/web runs.
// Enable only for targeted troubleshooting:
//
//   TREBUCHET_ENABLE_SPLASH_DEBUG=1 npm run web
//   fetch('/api/_splash-debug').then(r => r.json()).then(console.log)
if (process.env.TREBUCHET_ENABLE_SPLASH_DEBUG === '1') {
  app.get('/api/_splash-debug', (_req, res) => {
    const introPath = path.join(publicDir, 'intro.mp4');
    let publicListing = null;
    let publicListingError = null;
    try {
      publicListing = fs.readdirSync(publicDir);
    } catch (e) {
      publicListingError = e.message;
    }
    let introStat = null;
    let introStatError = null;
    try {
      const s = fs.statSync(introPath);
      introStat = { size: s.size, isFile: s.isFile(), mtime: s.mtime };
    } catch (e) {
      introStatError = e.message;
    }
    res.json({
      __dirname,
      publicDir,
      publicDirExists: fs.existsSync(publicDir),
      publicListing,
      publicListingError,
      introPath,
      introExists: fs.existsSync(introPath),
      introStat,
      introStatError,
      cwd: process.cwd(),
      execPath: process.execPath,
    });
  });
}

// ---------------------------------------------------------------------------
// Server log streaming
// ---------------------------------------------------------------------------
//
// Returns server-side console output. Frontend polls this endpoint
// continuously and mixes new entries into the in-app activity log so the
// user can see what the backend is doing without needing terminal access.
//
// Query params:
//   since=<seq>   — return only entries with seq > this value (default: 0)
//   limit=<n>     — cap the number of entries returned (default: 200, max: 500)
//
// Response shape:
//   { entries: [ { seq, ts, level, msg } ] }
//
// The seq value is a monotonically increasing integer assigned at log time.
// Frontend tracks the highest seq it's seen and passes it as `since` on
// the next poll, so each entry is delivered exactly once.
app.get('/api/server-logs', (req, res) => {
  const sinceSeq = req.query.since ? Number(req.query.since) : 0;
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  // Buffer is already in chronological order (push at tail). Filter to
  // entries newer than `since`, then take the last `limit` entries —
  // if the user falls behind by more than `limit` they lose the oldest
  // missed entries but stay current with recent activity.
  const filtered = _serverLogBuffer.filter((e) => e.seq > sinceSeq);
  const entries = filtered.length > limit ? filtered.slice(-limit) : filtered;
  res.json({ entries });
});

app.get('/api/v2/viewport-smoke-proof', (_req, res) => {
  try {
    res.json({ success: true, proof: readV2ViewportSmokeProof() });
  } catch (error) {
    res.json({
      success: true,
      proof: {
        passed: false,
        state: 'error',
        detail: `Viewport smoke proof could not be verified: ${error.message}`,
      },
    });
  }
});

let personalDiscoveryJob = {
  id: null,
  status: 'idle',
  startedAt: null,
  completedAt: null,
  progress: null,
  error: null,
};

let brandShieldJob = {
  status: 'idle',
  startedAt: null,
  completedAt: null,
  checked: 0,
  error: null,
};

function syncBrandShieldRegistryFromJournals() {
  const journals = launchJournal.list({ includeCompleted: true, includeArchived: true });
  for (const journal of journals) {
    const token = journal?.token;
    if (!token?.mint) continue;
    try {
      const fingerprint = buildBrandFingerprint({
        mint: token.mint,
        name: token.name,
        symbol: token.symbol,
        metadataUri: token.metadataUri,
        metadataHash: token.metadataHash,
        imageUri: token.imageUri,
        supply: token.totalSupply,
        decimals: token.decimals,
        launchWallet: journal.walletPublicKey,
        journalId: journal.id,
        createdAt: journal.createdAt,
        sealedLaunch: token.sealedLaunch === true,
      });
      const existing = brandShieldStore.getLaunch(token.mint);
      if (existing?.fingerprint?.fingerprintHash === fingerprint.fingerprintHash) continue;
      brandShieldStore.registerLaunch({
        fingerprint,
        attestation: existing?.attestation || null,
        source: 'launch-journal',
      });
    } catch (error) {
      console.warn('Brand Shield could not import launch journal:', error.message);
    }
  }
}

function registerOfficialBrandLaunch({ journal, token, secretKey = null }) {
  const fingerprint = buildBrandFingerprint({
    mint: token.mint,
    name: token.name,
    symbol: token.symbol,
    metadataUri: token.metadataUri,
    metadataHash: token.metadataHash,
    imageUri: token.imageUri,
    supply: token.totalSupply,
    decimals: token.decimals,
    launchWallet: journal?.walletPublicKey,
    journalId: journal?.id,
    createdAt: journal?.createdAt,
    sealedLaunch: token.sealedLaunch === true,
  });
  let attestation = null;
  if (Array.isArray(secretKey) && secretKey.length >= 64) {
    try { attestation = signLaunchAttestation(fingerprint, secretKey); }
    catch (error) { console.warn('Brand Shield attestation failed:', error.message); }
  }
  return brandShieldStore.registerLaunch({ fingerprint, attestation, source: 'local-launch' });
}

async function brandAssessmentForMetadata(mint, metadata, market = null, { resolveContent = false } = {}) {
  const enriched = { ...(metadata || {}) };
  if (resolveContent && enriched.metadataUri && !enriched.metadataHash) {
    const remote = await fetchMetadataFingerprint(enriched.metadataUri);
    if (remote) Object.assign(enriched, remote);
  }
  const liquidity = market
    ? brandShieldStore.recordObservation(mint, market)
    : brandShieldStore.liquidityState(mint);
  const assessment = assessBrandRisk({
    mint,
    metadata: enriched,
    launches: brandShieldStore.listLaunches(),
    liquidity,
  });
  brandShieldStore.recordAlert({ mint, assessment });
  return assessment;
}

async function brandShieldTopHolderOwners(connection, mint, limit = 20) {
  try {
    const largest = await connection.getTokenLargestAccounts(new PublicKey(mint), 'confirmed');
    const accounts = (Array.isArray(largest?.value) ? largest.value : [])
      .filter((row) => BigInt(String(row?.amount || '0')) > 0n)
      .slice(0, limit);
    if (!accounts.length) return [];
    const infos = await connection.getMultipleAccountsInfo(
      accounts.map((row) => new PublicKey(row.address)),
      'confirmed',
    );
    const byOwner = new Map();
    infos.forEach((info, index) => {
      const data = Buffer.isBuffer(info?.data) ? info.data : Buffer.from(info?.data || []);
      if (data.length < 64) return;
      const ownerKey = new PublicKey(data.subarray(32, 64));
      if (!PublicKey.isOnCurve(ownerKey.toBytes())) return;
      const owner = ownerKey.toBase58();
      const amount = BigInt(String(accounts[index]?.amount || '0'));
      byOwner.set(owner, (byOwner.get(owner) || 0n) + amount);
    });
    return [...byOwner.entries()]
      .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] > b[1] ? -1 : 1))
      .map(([owner, amount]) => ({ owner, amount: amount.toString() }));
  } catch (error) {
    console.warn(`Brand Shield holder snapshot failed for ${mint}:`, error.message);
    return [];
  }
}

async function runBrandShieldScan() {
  if (brandShieldJob.status === 'running') return brandShieldStore.publicState();
  syncBrandShieldRegistryFromJournals();
  const launches = brandShieldStore.listLaunches();
  if (!launches.length) return brandShieldStore.publicState();
  brandShieldJob = {
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    checked: 0,
    error: null,
  };
  try {
    const candidates = await findDexScreenerBrandCandidates(launches);
    const rpc = discoveryRpcCandidates(getRpcConfig())[0];
    const connection = rpc?.url ? new Connection(rpc.url, 'confirmed') : null;
    for (const candidate of candidates) {
      const metadata = await getTokenMetadata(candidate.mint, {
        rpcUrl: rpc?.url,
        includePrice: false,
        includeDisplayMeta: true,
      }).catch(() => null);
      if (!metadata) continue;
      const topPool = [...(candidate.pools || [])]
        .sort((a, b) => Number(b.liquidityUsd || 0) - Number(a.liquidityUsd || 0))[0] || null;
      const market = topPool ? {
        liquidityUsd: topPool.liquidityUsd,
        pool: { address: topPool.address, dex: topPool.dex },
        volume5mUsd: topPool.volume5mUsd,
        volume1hUsd: topPool.volume1hUsd,
        buys5m: topPool.buys5m,
        sells5m: topPool.sells5m,
        buys1h: topPool.buys1h,
        sells1h: topPool.sells1h,
        pairCreatedAt: topPool.pairCreatedAt,
        topHolders: candidate.officialMint && connection
          ? await brandShieldTopHolderOwners(connection, candidate.mint)
          : [],
      } : null;
      await brandAssessmentForMetadata(candidate.mint, metadata, market, { resolveContent: true });
      brandShieldJob.checked += 1;
    }
    brandShieldJob.status = 'complete';
    brandShieldJob.completedAt = new Date().toISOString();
  } catch (error) {
    brandShieldJob.status = 'failed';
    brandShieldJob.completedAt = new Date().toISOString();
    brandShieldJob.error = error.message || 'Brand Shield scan failed.';
  }
  return brandShieldStore.publicState();
}

const brandShieldMonitor = setInterval(() => {
  if (brandShieldJob.status !== 'running' && brandShieldStore.listLaunches().length > 0) {
    void runBrandShieldScan();
  }
}, 3 * 60 * 1000);
brandShieldMonitor.unref?.();

function publicPersonalDiscoveryJob() {
  return {
    id: personalDiscoveryJob.id,
    status: personalDiscoveryJob.status,
    startedAt: personalDiscoveryJob.startedAt,
    completedAt: personalDiscoveryJob.completedAt,
    progress: personalDiscoveryJob.progress,
    error: personalDiscoveryJob.error,
  };
}

function rememberManagedDiscoveryWallet(wallet, label = 'Trebuchet wallet') {
  const publicKey = String(wallet?.publicKey || '').trim();
  if (!publicKey) return;
  try {
    const existing = discoveryStore.listWallets().find((entry) => entry.publicKey === publicKey);
    if (!existing || existing.source !== 'managed') {
      discoveryStore.upsertWallet(publicKey, {
        label: existing?.label || label,
        source: 'managed',
        enabled: existing?.enabled !== false,
      });
    }
  } catch (error) {
    console.warn(`Personal Discovery could not remember managed wallet ${publicKey}:`, error.message);
  }
}

function syncManagedDiscoveryWallets() {
  const sourceWallets = isDemoMode()
    ? Array.from(demoManagedWallets.values())
    : pendingWallets.list();
  try {
    discoveryStore.syncManagedWallets(sourceWallets.map((wallet, index) => ({
      publicKey: wallet?.publicKey,
      label: index === 0 ? 'Launch wallet' : `Trebuchet wallet ${index + 1}`,
      enabled: true,
    })));
  } catch (error) {
    console.warn('Personal Discovery could not synchronize managed wallets:', error.message);
  }
}

function personalDiscoveryResponse() {
  syncBrandShieldRegistryFromJournals();
  syncManagedDiscoveryWallets();
  const wallets = discoveryStore.listWallets();
  const watchOnlyCount = wallets.filter((wallet) => wallet.source === 'watch-only').length;
  const managedCount = wallets.length - watchOnlyCount;
  return {
    success: true,
    wallets,
    limits: {
      watchOnlyCount,
      managedCount,
      trackingUnlimited: true,
      scanAllWatchedWallets: true,
      managedSeedLimit: null,
      scanConcurrency: PERSONAL_DISCOVERY_LIMITS.walletConcurrency,
    },
    snapshot: discoveryStore.getSnapshot(),
    job: publicPersonalDiscoveryJob(),
    brandShield: {
      ...brandShieldStore.publicState(),
      job: { ...brandShieldJob },
    },
  };
}

function personalDiscoveryWalletFingerprint(wallets = []) {
  return wallets
    .filter((wallet) => wallet.enabled !== false)
    .map((wallet) => String(wallet.publicKey || '').trim())
    .filter(Boolean)
    .sort()
    .join('|');
}

function rejectIfPersonalDiscoveryScanRunning(res) {
  if (personalDiscoveryJob.status !== 'running') return false;
  res.status(409).json({
    success: false,
    code: 'DISCOVERY_SCAN_RUNNING',
    error: 'Wait for the current personal Discovery scan before changing tracked wallets.',
    job: publicPersonalDiscoveryJob(),
  });
  return true;
}

async function enrichPersonalDiscoveryToken(mint, rpcUrl) {
  const metadataResult = await Promise.resolve()
    .then(() => getTokenMetadata(mint, {
      rpcUrl,
      includePrice: true,
      includeDisplayMeta: false,
    }))
    .then((value) => ({ status: 'fulfilled', value }))
    .catch((reason) => ({ status: 'rejected', reason }));
  const metadata = metadataResult.status === 'fulfilled' ? metadataResult.value : null;
  const warnings = [];
  if (metadataResult.status === 'rejected') warnings.push(`Metadata: ${metadataResult.reason?.message || 'lookup failed'}`);
  return {
    name: metadata?.name || metadata?.symbol || null,
    symbol: metadata?.symbol || null,
    imageUrl: metadata?.imageUrl || null,
    decimals: Number.isFinite(Number(metadata?.decimals)) ? Number(metadata.decimals) : null,
    priceUsd: metadata?.priceUsd ?? null,
    metadataUri: metadata?.metadataUri || null,
    market: null,
    warnings,
    brand: metadata
      ? await brandAssessmentForMetadata(mint, metadata, null, { resolveContent: false })
      : null,
  };
}

app.get('/api/v2/brand-shield', (_req, res) => {
  try {
    syncBrandShieldRegistryFromJournals();
    res.json({ success: true, ...brandShieldStore.publicState(), job: { ...brandShieldJob } });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

app.post('/api/v2/brand-shield/scan', (_req, res) => {
  if (brandShieldJob.status !== 'running') void runBrandShieldScan();
  res.status(202).json({
    success: true,
    ...brandShieldStore.publicState(),
    job: { ...brandShieldJob },
  });
});

app.get('/api/v2/discovery/personal', (_req, res) => {
  try {
    res.json(personalDiscoveryResponse());
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

// Shown until a vanity CA is picked; the real mint is only known at launch.
const LOGO_STAMP_SAMPLE_MINT = 'Your1Mint1Address1Appears1Here1At1Launch';

// Preview the CA stamp exactly as the launch will apply it.
app.post('/api/v2/logo-stamp-preview', (req, res) => {
  try {
    const logo = String(req.body?.logo || '');
    if (!logo.startsWith('data:')) throw new Error('Preview needs the logo as a data URL.');
    let mint = null;
    try {
      mint = req.body?.mint ? new PublicKey(String(req.body.mint).trim()).toBase58() : null;
    } catch {
      mint = null;
    }
    const result = stampLogoDataUrl(logo, mint || LOGO_STAMP_SAMPLE_MINT);
    res.json({
      stamped: result.stamped,
      reason: result.reason || null,
      dataUrl: result.stamped ? result.dataUrl : null,
      mint: mint || null,
      sample: !mint,
    });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

app.post('/api/v2/discovery/wallets', (req, res) => {
  try {
    if (rejectIfPersonalDiscoveryScanRunning(res)) return;
    const publicKey = new PublicKey(String(req.body?.publicKey || '').trim()).toBase58();
    const wallet = discoveryStore.upsertWallet(publicKey, {
      label: req.body?.label,
      source: 'watch-only',
      enabled: true,
    });
    res.status(201).json({ ...personalDiscoveryResponse(), wallet });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

app.post('/api/v2/discovery/wallets/:publicKey/enabled', (req, res) => {
  try {
    if (rejectIfPersonalDiscoveryScanRunning(res)) return;
    const publicKey = new PublicKey(String(req.params.publicKey || '').trim()).toBase58();
    const wallet = discoveryStore.setWalletEnabled(publicKey, req.body?.enabled === true);
    if (!wallet) {
      return res.status(404).json({ success: false, code: 'DISCOVERY_WALLET_NOT_FOUND', error: 'Tracked wallet was not found.' });
    }
    res.json({ ...personalDiscoveryResponse(), wallet });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

app.delete('/api/v2/discovery/wallets/:publicKey', (req, res) => {
  try {
    if (rejectIfPersonalDiscoveryScanRunning(res)) return;
    const publicKey = new PublicKey(String(req.params.publicKey || '').trim()).toBase58();
    const removed = discoveryStore.removeWallet(publicKey);
    if (!removed) {
      return res.status(404).json({ success: false, code: 'DISCOVERY_WALLET_NOT_FOUND', error: 'Tracked wallet was not found.' });
    }
    res.json(personalDiscoveryResponse());
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

app.post('/api/v2/discovery/scan', (req, res) => {
  try {
    if (personalDiscoveryJob.status === 'running') {
      return res.status(409).json({
        success: false,
        code: 'DISCOVERY_SCAN_RUNNING',
        error: 'A personal Discovery scan is already running.',
        job: publicPersonalDiscoveryJob(),
      });
    }
    syncManagedDiscoveryWallets();
    const trackedWallets = discoveryStore.listWallets()
      .filter((wallet) => wallet.enabled !== false);
    const wallets = selectPersonalDiscoveryWallets(trackedWallets);
    if (!wallets.length) {
      return res.status(400).json({
        success: false,
        code: 'DISCOVERY_WALLET_REQUIRED',
        error: 'Add and enable at least one wallet before scanning.',
      });
    }
    const rpc = discoveryRpcCandidates(getRpcConfig())[0];
    if (!rpc?.url) throw new Error('No Solana RPC is configured for personal Discovery.');
    const jobId = crypto.randomUUID();
    const walletFingerprint = personalDiscoveryWalletFingerprint(wallets);
    personalDiscoveryJob = {
      id: jobId,
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
      progress: {
        phase: 'starting',
        current: 0,
        total: wallets.length,
      },
      error: null,
    };

    const connection = new Connection(rpc.url, {
      commitment: 'confirmed',
      // Discovery is exploratory and can preserve partial results. Let the
      // scanner surface a rate-limit notice instead of allowing web3.js to
      // hold the whole UI in an automatic retry loop for minutes.
      disableRetryOnRateLimit: true,
    });
    void scanPersonalDiscovery({
      connection,
      wallets,
      limits: req.body?.limits || {},
      enrichToken: (mint) => enrichPersonalDiscoveryToken(mint, rpc.url),
      onProgress: (progress) => {
        if (personalDiscoveryJob.id === jobId) personalDiscoveryJob.progress = progress;
      },
    }).then((snapshot) => {
      const currentWallets = selectPersonalDiscoveryWallets(
        discoveryStore.listWallets()
          .filter((wallet) => wallet.enabled !== false),
      );
      if (personalDiscoveryWalletFingerprint(currentWallets) !== walletFingerprint) {
        const error = new Error('Tracked wallets changed while Discovery was scanning. Scan again for a current graph.');
        error.code = 'DISCOVERY_WALLETS_CHANGED';
        throw error;
      }
      discoveryStore.saveSnapshot({ ...snapshot, rpcName: rpc.name });
      void runBrandShieldScan();
      if (personalDiscoveryJob.id === jobId) {
        personalDiscoveryJob.status = 'complete';
        personalDiscoveryJob.completedAt = snapshot.completedAt;
        personalDiscoveryJob.progress = { phase: 'complete', current: 1, total: 1 };
      }
    }).catch((error) => {
      console.error('Personal Discovery scan failed:', error);
      if (personalDiscoveryJob.id === jobId) {
        personalDiscoveryJob.status = 'failed';
        personalDiscoveryJob.completedAt = new Date().toISOString();
        personalDiscoveryJob.error = error.message || 'Personal Discovery scan failed.';
      }
    });

    res.status(202).json({
      success: true,
      wallets,
      snapshot: discoveryStore.getSnapshot(),
      job: publicPersonalDiscoveryJob(),
    });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

app.post('/api/v2/discovery/inspect', async (req, res) => {
  const mint = String(req.body?.mint || '').trim();
  let mintPublicKey;
  try {
    mintPublicKey = new PublicKey(mint);
  } catch {
    return res.status(400).json({
      success: false,
      code: 'INVALID_MINT',
      error: 'Enter a valid Solana token mint address.',
    });
  }

  try {
    const rpcConfig = getRpcConfig();
    const candidates = discoveryRpcCandidates(rpcConfig);
    let inspectionRpc = null;
    let supply = null;
    const candidateFailures = [];

    for (const candidate of candidates) {
      try {
        const connection = new Connection(candidate.url, 'confirmed');
        const supplyResult = await connection.getTokenSupply(mintPublicKey, 'confirmed');
        inspectionRpc = { ...candidate, connection };
        supply = supplyResult.value;
        break;
      } catch (error) {
        candidateFailures.push({ candidate, error, missing: isMissingMintRpcError(error) });
      }
    }

    if (!inspectionRpc) {
      const allMissing = candidateFailures.length > 0 && candidateFailures.every((failure) => failure.missing);
      const checkedNames = candidateFailures.map((failure) => failure.candidate.name).join(', ');
      const lastError = candidateFailures.at(-1)?.error;
      if (allMissing) {
        return res.status(404).json({
          success: false,
          code: 'MINT_NOT_FOUND',
          error: `Mint was not found on ${checkedNames || 'the available Solana networks'}. Check the address or select the correct network.`,
        });
      }
      throw new Error(lastError?.message || 'Available RPC endpoints could not inspect this mint.');
    }

    const { connection } = inspectionRpc;
    const [metadataResult, compatibilityResult, largestResult, marketResult] = await Promise.allSettled([
      getTokenMetadata(mint, { rpcUrl: inspectionRpc.url }),
      getMintCompatibilityWithRaydiumClmm(connection, mintPublicKey),
      connection.getTokenLargestAccounts(mintPublicKey, 'confirmed'),
      fetchDiscoveryMarketData(mint),
    ]);

    const warnings = [];
    if (metadataResult.status === 'rejected') warnings.push(`Metadata: ${metadataResult.reason?.message || 'lookup failed'}`);
    if (compatibilityResult.status === 'rejected') warnings.push(`Authority audit: ${compatibilityResult.reason?.message || 'lookup failed'}`);
    if (largestResult.status === 'rejected') warnings.push(`Concentration: ${largestResult.reason?.message || 'lookup failed'}`);
    if (marketResult.status === 'rejected') warnings.push(`Market data: ${marketResult.reason?.message || 'lookup failed'}`);
    if (inspectionRpc.url !== rpcConfig.active) {
      const activeName = rpcConfig.saved?.find((entry) => entry.url === rpcConfig.active)?.name || 'active RPC';
      warnings.push(`Read-only inspection used ${inspectionRpc.name} because ${activeName} is on another network or did not contain the mint.`);
    }

    const matchingJournal = launchJournal
      .list({ includeCompleted: true, includeArchived: true })
      .filter((journal) => String(journal?.token?.mint || '') === mint)
      .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))[0] || null;

    syncBrandShieldRegistryFromJournals();
    const metadataValue = metadataResult.status === 'fulfilled' ? metadataResult.value : null;
    const marketValue = marketResult.status === 'fulfilled' ? marketResult.value : null;
    const remoteFingerprint = metadataValue?.metadataUri
      ? await fetchMetadataFingerprint(metadataValue.metadataUri)
      : null;
    const brandMetadata = remoteFingerprint
      ? { ...metadataValue, ...remoteFingerprint }
      : metadataValue;
    const brandAssessment = await brandAssessmentForMetadata(
      mint,
      brandMetadata,
      marketValue,
      { resolveContent: false },
    );

    const record = buildDiscoveryRecord({
      mint,
      metadata: brandMetadata,
      compatibility: compatibilityResult.status === 'fulfilled' ? compatibilityResult.value : null,
      supply,
      largestAccounts: largestResult.status === 'fulfilled' ? largestResult.value?.value : null,
      market: marketValue,
      journal: matchingJournal,
      brandAssessment,
      rpcName: inspectionRpc.name,
      warnings,
    });

    res.json({ success: true, record });
  } catch (error) {
    console.error(`Discovery inspection failed for ${mint}:`, error);
    res.status(502).json({
      success: false,
      code: 'DISCOVERY_INSPECTION_FAILED',
      error: error.message || 'Token inspection failed.',
    });
  }
});

// ---------------------------------------------------------------------------
// Recovery PIN endpoints
// ---------------------------------------------------------------------------

app.get('/api/secret-pin/status', (_req, res) => {
  res.json({ success: true, status: secretStore.secretPinStatus() });
});

app.post('/api/secret-pin/setup', (req, res) => {
  try {
    secretStore.setupSecretPin(req.body?.pin);
    migrateSecretsToUnlockedPin();
    res.json({ success: true, status: secretStore.secretPinStatus() });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

app.post('/api/secret-pin/unlock', (req, res) => {
  try {
    const ok = secretStore.unlockSecretPin(req.body?.pin);
    if (!ok) {
      return res.status(401).json({
        success: false,
        code: 'BAD_SECRET_PIN',
        error: 'Recovery PIN is incorrect',
      });
    }
    migrateSecretsToUnlockedPin();
    res.json({ success: true, status: secretStore.secretPinStatus() });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

app.post('/api/secret-pin/change', (req, res) => {
  try {
    const ok = secretStore.unlockSecretPin(req.body?.currentPin);
    if (!ok) {
      return res.status(401).json({
        success: false,
        code: 'BAD_SECRET_PIN',
        error: 'Recovery PIN is incorrect',
      });
    }
    migrateSecretsToUnlockedPin();
    const status = secretStore.changeSecretPin(req.body?.newPin);
    res.json({ success: true, status });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

app.post('/api/secret-pin/lock', (_req, res) => {
  res.json({ success: true, status: secretStore.lockSecretPin() });
});

app.post('/api/secret-pin/reset', (req, res) => {
  try {
    if (launchOpsInFlight.size > 0 || airdropsInFlight.size > 0) {
      return res.status(409).json({
        success: false,
        code: 'LAUNCH_OP_IN_FLIGHT',
        error: 'A launch operation is running. Wait for it to finish before resetting the Recovery PIN.',
      });
    }
    if (req.body?.confirmReset !== 'RESET RECOVERY PIN') {
      return res.status(400).json({
        success: false,
        code: 'BAD_SECRET_PIN_RESET_CONFIRMATION',
        error: 'Type RESET RECOVERY PIN to confirm the destructive reset.',
      });
    }

    const removed = {
      pendingWallets: pendingWallets.removePinEncrypted(),
      vanityCAs: vanityCaStore.removePinEncrypted(),
      splitJobs: splitJobStore.removePinEncrypted(),
      nftKeys: nftCollectionStore.removePinEncrypted(),
    };
    const status = secretStore.resetSecretPin();
    res.json({ success: true, status, removed });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

// ---------------------------------------------------------------------------
// Wallet endpoints
// ---------------------------------------------------------------------------

app.post('/api/generate-wallet', async (req, res) => {
  try {
    const demoMode = isDemoMode();
    if (!demoMode && rejectIfSecretPinLocked(res, 'generating a recoverable launch wallet')) {
      return;
    }
    console.log('Generating temporary wallet...');
    const walletInfo = await generateTemporaryWallet();
    const qrCode = await getWalletQRCode(walletInfo.publicKey);

    if (demoMode) {
      // Demo: still produce a REAL keypair (the secret key is shown to the
      // user and downstream code expects a valid signer), but register a
      // fresh empty WalletState in the demo ledger instead of writing to
      // the disk-backed pending-wallets cache and launch journal. This
      // keeps the persistent recovery stores free of synthetic demo data.
      demoChainService.registerWallet(walletInfo.publicKey);
    } else {
      // Stash the key on disk so the user can recover the wallet if the
      // app crashes or is closed mid-launch. The entry is removed by
      // /api/transfer-assets once the wallet is verified on-chain empty.
      pendingWallets.add(walletInfo.publicKey, walletInfo.secretKey, walletInfo.mnemonic);
      launchJournal.start({ walletPublicKey: walletInfo.publicKey });
    }

    res.json({
      success: true,
      wallet: {
        publicKey: walletInfo.publicKey,
        secretKey: walletInfo.secretKey,
        secretKeyB58: secretKeyToBase58(walletInfo.secretKey),
        mnemonic: walletInfo.mnemonic,
        qrCode,
      },
    });
  } catch (error) {
    console.error('Error generating wallet:', error);
    sendErrorResponse(res, error);
  }
});

app.get('/api/wallet-qr', async (req, res) => {
  try {
    const publicKey = String(req.query.publicKey || '').trim();
    if (!publicKey) {
      return res.status(400).json({ success: false, error: 'publicKey required' });
    }
    // Validate before rendering so typos fail with a useful message instead
    // of producing a QR that scans to nonsense.
    new PublicKey(publicKey);
    const qrCode = await getWalletQRCode(publicKey);
    res.json({ success: true, publicKey, qrCode });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

function managedWalletMetadata(wallet, extra = {}) {
  return {
    publicKey: wallet.publicKey,
    createdAt: wallet.createdAt || null,
    rarity: typeof wallet.rarity === 'string' && wallet.rarity.trim()
      ? wallet.rarity.trim()
      : 'Common',
    vanity: wallet.vanity === true,
    hasSecretKey: Array.isArray(wallet.secretKey),
    hasMnemonic: typeof wallet.mnemonic === 'string' && wallet.mnemonic.length > 0,
    decryptionFailed: !Array.isArray(wallet.secretKey),
    source: extra.source || 'trebuchet-managed',
    label: extra.label || 'Trebuchet launch wallet',
    ...extra,
  };
}

function keypairFromMnemonic(mnemonic) {
  const normalized = String(mnemonic || '').trim().replace(/\s+/g, ' ');
  if (!bip39.validateMnemonic(normalized)) {
    throw new Error('Invalid wallet mnemonic');
  }
  const seed = bip39.mnemonicToSeedSync(normalized);
  const derivedSeed = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
  return { keypair: Keypair.fromSeed(derivedSeed), mnemonic: normalized };
}

function parseImportedWalletSecret(value) {
  if (Array.isArray(value)) {
    return { keypair: Keypair.fromSecretKey(Uint8Array.from(value)), mnemonic: null };
  }

  const text = String(value || '').trim();
  if (!text) throw new Error('Wallet secret is required');

  if (text.includes(' ')) return keypairFromMnemonic(text);

  if (text.startsWith('[')) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('Secret key JSON must be an array');
    return { keypair: Keypair.fromSecretKey(Uint8Array.from(parsed)), mnemonic: null };
  }

  const decoded = bs58.decode(text);
  return { keypair: Keypair.fromSecretKey(Uint8Array.from(decoded)), mnemonic: null };
}

const demoManagedWallets = new Map();

function rememberDemoManagedWallet(wallet) {
  if (!wallet?.publicKey || !Array.isArray(wallet.secretKey)) return;
  demoManagedWallets.set(wallet.publicKey, {
    publicKey: wallet.publicKey,
    secretKey: wallet.secretKey,
    mnemonic: wallet.mnemonic || null,
    createdAt: wallet.createdAt || new Date().toISOString(),
  });
}

function invokeJsonHandler(handler, body, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = { body };
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        settled = true;
        if (this.statusCode >= 400 || payload?.success === false) {
          const error = new Error(payload?.error || `Demo handler failed with HTTP ${this.statusCode}`);
          error.statusCode = this.statusCode;
          error.payload = payload;
          reject(error);
          return payload;
        }
        resolve(payload);
        return payload;
      },
    };

    Promise.resolve(handler(req, res, options)).then(() => {
      if (!settled) resolve({ success: true });
    }).catch(reject);
  });
}

function demoAllocationsForV2(allocations = []) {
  return allocations.map((allocation) => {
    const ladder = allocation?.ladder || { mode: 'off' };
    if (ladder.mode !== 'simple') return allocation;
    const bandCount = Math.max(0, Math.floor(Number(ladder.bandCount || 0)));
    if (bandCount <= 0) return { ...allocation, ladder: { mode: 'off' } };
    const supplyPercent = Number.isFinite(Number(ladder.supplyPercent))
      ? Math.max(0, Number(ladder.supplyPercent))
      : 50;
    const ceilingMultiplier = Number.isFinite(Number(ladder.ceilingMultiplier))
      ? Math.max(1.01, Number(ladder.ceilingMultiplier))
      : 1000;
    const logCeiling = Math.log(ceilingMultiplier);
    const perBandSupply = bandCount > 0 ? supplyPercent / bandCount : 0;
    return {
      ...allocation,
      ladder: {
        mode: 'manual',
        bands: Array.from({ length: bandCount }, (_, index) => ({
          supplyPercent: Number(perBandSupply.toFixed(4)),
          lowerMultiplier: Number(Math.exp((logCeiling * index) / bandCount).toFixed(4)),
          upperMultiplier: Number(Math.exp((logCeiling * (index + 1)) / bandCount).toFixed(4)),
        })),
      },
    };
  });
}

// SOL-only balance (kept for backwards compatibility / Step 1 display)
// ---------------------------------------------------------------------------

// NFT collections (v2 NFTs view). See nftRoutes.js.
registerNftRoutes(app, {
  isDemoMode,
  rejectIfSecretPinLocked,
  sendErrorResponse,
  getRpcUrl,
  getManagedWallet: (publicKey) => pendingWallets.get(publicKey),
});

app.get('/api/vanity-ca-candidates', (req, res) => {
  try {
    const secretPinLocked = secretStore.isSecretPinLocked();
    const candidates = vanityCaStore.listMetadata().map((candidate) => ({
      ...candidate,
      ...(candidate.decryptionFailed && secretPinLocked ? { secretPinLocked: true } : {}),
    }));
    res.json({ success: true, candidates, secretPinLocked });
  } catch (error) {
    console.error('Error listing vanity CA candidates:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/vanity-ca-candidates/remove', (req, res) => {
  try {
    const { publicKey } = req.body || {};
    if (!publicKey) {
      return res.status(400).json({ success: false, error: 'publicKey required' });
    }
    vanityCaStore.remove(publicKey);
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing vanity CA candidate:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Import a vanity CA ground elsewhere (e.g. on rented machines) into the
// encrypted store. The public key is derived from the secret, never trusted
// from the request, and must match the requested pattern. The response
// carries metadata only.
// Split-key vanity grinding. Trebuchet keeps the secret scalar a; a grinder
// (local, rented, or a service) only ever receives A = a*G and returns an
// offset k. Completing a job forms the mint key a + k here, checks it against
// the pattern, and stores it encrypted as a scalar vanity CA.
function createSplitJob({ prefix, suffix, caseInsensitive, addressLength }) {
  const { secretScalar, publicPoint } = createSplitSecret();
  const expectedAttempts = expectedVanityAttempts(prefix, suffix, { caseInsensitive, length: addressLength });
  if (!Number.isFinite(expectedAttempts)) {
    throw new Error(`No ${addressLength}-character address can start with ${prefix}`);
  }
  return splitJobStore.create({
    secretScalar: Array.from(secretScalar),
    publicPoint: Buffer.from(publicPoint).toString('hex'),
    prefix,
    suffix,
    caseInsensitive,
    addressLength,
    expectedAttempts,
  });
}

function completeSplitJob(jobId, offsetHex, { attempts = null, rarity = null, epochs = null, store = true } = {}) {
  const job = splitJobStore.getWithSecret(jobId);
  if (!job) throw new Error('Split job not found');
  if (!Array.isArray(job.secretScalar)) throw new Error('Split job secret could not be decrypted');
  if (!/^[0-9a-f]{64}$/.test(String(offsetHex))) throw new Error('offset must be 64 hex chars');
  const key = combineSplitKey({
    secretScalar: Uint8Array.from(job.secretScalar),
    publicPoint: Buffer.from(job.publicPoint, 'hex'),
    offset: Buffer.from(offsetHex, 'hex'),
  });
  const pattern = {
    prefix: job.prefix || '',
    suffix: job.suffix || '',
    caseInsensitive: job.caseInsensitive,
    length: job.addressLength,
  };
  if (!matchesVanityPattern(key.address, pattern)) {
    throw new Error(`${key.address} does not match the job's pattern`);
  }
  const mode = job.prefix && job.suffix ? 'both' : job.prefix ? 'prefix' : job.suffix ? 'suffix' : null;
  if (store) {
    vanityCaStore.add({
      publicKey: key.address,
      keyType: 'scalar',
      scalar: Array.from(key.scalar),
      attempts,
      rarity: rarity || 'Common',
      epochs,
      expectedAttempts: job.expectedAttempts,
      target: job.prefix && job.suffix ? `${job.prefix}...${job.suffix}` : (job.prefix || job.suffix || null),
      prefix: job.prefix,
      suffix: job.suffix,
      mode,
      caseInsensitive: job.caseInsensitive,
      addressLength: job.addressLength,
    });
  }
  splitJobStore.remove(jobId);
  return { publicKey: key.address, mode, job };
}

// API for external grinders: create a job (hands out only A), then complete
// it with the offset they found.
app.post('/api/vanity-split/jobs', (req, res) => {
  try {
    if (!isDemoMode() && rejectIfSecretPinLocked(res, 'creating a split vanity job')) return;
    const { prefix, suffix } = normalizeVanityTargetBase58(req.body?.prefix || '', req.body?.suffix || '');
    const length = Number.parseInt(String(req.body?.length || ''), 10);
    const addressLength = length >= 32 && length <= 44 ? length : null;
    if (!prefix && !suffix && !addressLength) {
      return res.status(400).json({ success: false, error: 'prefix, suffix, or length required' });
    }
    const job = createSplitJob({ prefix, suffix, caseInsensitive: req.body?.caseInsensitive === true, addressLength });
    res.json({ success: true, job });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.get('/api/vanity-split/jobs', (_req, res) => {
  res.json({ success: true, jobs: splitJobStore.list() });
});

app.post('/api/vanity-split/jobs/complete', (req, res) => {
  try {
    if (!isDemoMode() && rejectIfSecretPinLocked(res, 'completing a split vanity job')) return;
    const { publicKey } = completeSplitJob(String(req.body?.id || ''), String(req.body?.offset || '').toLowerCase(), {
      attempts: Number.isFinite(Number(req.body?.attempts)) ? Number(req.body.attempts) : null,
    });
    const candidate = vanityCaStore.listMetadata().find((item) => item.publicKey === publicKey);
    res.json({ success: true, candidate });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post('/api/vanity-split/jobs/remove', (req, res) => {
  splitJobStore.remove(String(req.body?.id || ''));
  res.json({ success: true });
});

app.post('/api/vanity-ca-candidates/import', (req, res) => {
  try {
    if (!isDemoMode() && rejectIfSecretPinLocked(res, 'importing a Vanity CA')) return;
    const secret = req.body?.secretKey;
    const bytes = Array.isArray(secret) ? Uint8Array.from(secret) : null;
    if (!bytes || bytes.length !== 64) {
      return res.status(400).json({ success: false, error: 'secretKey must be a 64-byte array' });
    }
    const publicKey = Keypair.fromSecretKey(bytes).publicKey.toBase58();
    const { prefix, suffix } = normalizeVanityTargetBase58(req.body?.prefix || '', req.body?.suffix || '');
    const caseInsensitive = req.body?.caseInsensitive === true;
    const fold = (value) => (caseInsensitive ? value.toLowerCase() : value);
    if ((prefix && !fold(publicKey).startsWith(fold(prefix))) || (suffix && !fold(publicKey).endsWith(fold(suffix)))) {
      return res.status(400).json({ success: false, error: `${publicKey} does not match the requested pattern` });
    }
    const mode = prefix && suffix ? 'both' : prefix ? 'prefix' : suffix ? 'suffix' : null;
    vanityCaStore.add({
      publicKey,
      secretKey: Array.from(bytes),
      attempts: Number.isFinite(Number(req.body?.attempts)) ? Number(req.body.attempts) : null,
      expectedAttempts: expectedVanityAttempts(prefix, suffix, { caseInsensitive }),
      target: prefix && suffix ? `${prefix}...${suffix}` : (prefix || suffix || null),
      prefix: prefix || null,
      suffix: suffix || null,
      mode,
      caseInsensitive,
    });
    const saved = vanityCaStore.listMetadata().find((item) => item.publicKey === publicKey);
    res.json({ success: true, candidate: saved });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// SSE streaming endpoint for vanity CA grind progress
app.get('/api/generate-vanity-wallet-stream', async (req, res) => {
  let { prefix, suffix, threads, token, client } = req.query;
  const caseInsensitive = ['1', 'true'].includes(String(req.query.caseInsensitive || '').toLowerCase());
  const lengthParam = Number.parseInt(String(req.query.length || ''), 10);
  const addressLength = lengthParam >= 32 && lengthParam <= 44 ? lengthParam : null;
  // Split-key grinds (v2 only): the grinder receives only A = a*G and the
  // mint key is formed here from the stored secret. Classic still needs a
  // seed keypair it can render.
  const splitMode = client === 'v2' && ['1', 'true'].includes(String(req.query.split || '').toLowerCase());
  prefix = typeof prefix === 'string' ? prefix.trim() : '';
  suffix = typeof suffix === 'string' ? suffix.trim() : '';

  // Validate session token inline.  This endpoint is exempt from the
  // middleware so EventSource can connect, but we still gate on the
  // session token delivered as a query parameter.
  if (!token) {
    return res.status(403).json({ success: false, error: 'session token required' });
  }
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(API_SESSION_TOKEN);
  if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
    return res.status(403).json({ success: false, error: 'invalid session token' });
  }

  const demoMode = isDemoMode();
  if (!demoMode && rejectIfSecretPinLocked(res, 'saving a Vanity CA candidate')) {
    return;
  }

  if (!prefix && !suffix && !addressLength) {
    return res.status(400).json({ success: false, error: 'prefix, suffix, or length required' });
  }
  try {
    ({ prefix, suffix } = normalizeVanityTargetBase58(prefix, suffix));
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }

  // Refuse cleanly if the binary isn't available. The frontend disables
  // the UI based on /api/demo/status, but a stale frontend or direct
  // API call still gets a clear 503 instead of crashing mid-spawn.
  const vanity = await vanityAvailability();
  if (!vanity.available) {
    return res.status(503).json({
      success: false,
      error: 'Vanity address generation is not available in this build. '
        + 'The vanity_keygen binary is not built — run `npm run build:c` '
        + '(requires gcc or clang). End-user release builds include the binary.',
    });
  }

  // Clamp threads to a consumer-reasonable maximum
  if (threads) {
    threads = Math.min(Math.max(1, Number(threads)), 32);
  }

  const target = prefix && suffix ? `${prefix}...${suffix}` : (prefix || suffix);
  const targetLen = prefix.length + suffix.length;
  const expected = expectedVanityAttempts(prefix, suffix, { caseInsensitive, length: addressLength });
  if (!Number.isFinite(expected)) {
    return res.status(400).json({ success: false, error: `No ${addressLength}-character address can start with ${prefix}` });
  }
  const vanityMode = prefix && suffix ? 'both' : (prefix ? 'prefix' : 'suffix');

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Detect client disconnect (browser tab closed, network drop, manual
  // EventSource.close()) and cancel the in-flight child so we don't
  // leave a zombie vanity_keygen.exe pegging CPU on the user's machine
  // until it stumbles into a match. cancelVanityGrind() is a no-op if
  // the grind has already finished or never started, so this is safe
  // to fire on every disconnect.
  res.on('close', () => {
    import('./vanityKeygen.js').then((mod) => {
      mod.cancelVanityGrind();
    }).catch(() => { /* module load shouldn't fail this late, but be quiet about it if it does */ });
  });

  // Send initial metadata
  res.write(`data: ${JSON.stringify({
    type: 'start',
    target,
    targetLen,
    expected,
    prefix: prefix || null,
    suffix: suffix || null,
    mode: vanityMode,
    caseInsensitive,
    length: addressLength,
  })}\n\n`);

  let lastAttempts = 0;
  let lastSend = Date.now();

  let splitJob = null;
  try {
    if (splitMode) splitJob = createSplitJob({ prefix, suffix, caseInsensitive, addressLength });
    const vanityMod = await import('./vanityKeygen.js');
    const result = await vanityMod.generateVanityKeypair({
      prefix, suffix, threads, caseInsensitive, length: addressLength,
      splitPoint: splitJob ? splitJob.publicPoint : null,
      onProgress: ({ attempts, key }) => {
        // Throttle to ~4 updates/sec
        const now = Date.now();
        if (now - lastSend < 100) return;
        lastSend = now;
        lastAttempts = attempts;
        const epoch = attempts / expected;
        res.write(`data: ${JSON.stringify({ type: 'progress', attempts, epoch, key })}\n\n`);
      },
    });

    if (splitJob) {
      const completed = completeSplitJob(splitJob.id, result.offset, {
        attempts: result.attempts,
        rarity: result.rarity,
        epochs: result.epochs,
        store: !demoMode,
      });
      splitJob = null;
      if (completed.publicKey !== result.publicKey) throw new Error('Split result does not match the grinder address');
      if (demoMode) demoChainService.registerWallet(completed.publicKey);
      const qrCode = await getWalletQRCode(completed.publicKey);
      res.write(`data: ${JSON.stringify({
        type: 'done',
        success: true,
        wallet: {
          publicKey: completed.publicKey,
          keyType: 'scalar',
          mnemonic: null,
          vanity: true,
          qrCode,
          attempts: result.attempts,
          rarity: result.rarity,
          epochs: result.epochs,
          expectedAttempts: result.expectedAttempts,
          target,
          prefix: prefix || null,
          suffix: suffix || null,
          mode: vanityMode,
          caseInsensitive,
          addressLength,
          persisted: !demoMode,
        },
      })}\n\n`);
      res.end();
      return;
    }

    const walletInfo = {
      publicKey: result.publicKey,
      secretKey: result.secretKey,
      mnemonic: null,
    };

    // Demo: register the freshly-ground vanity wallet in the demo ledger so
    // it starts as an empty, fundable launch wallet — same as the plain
    // generate-wallet demo branch. (This stream endpoint never writes to the
    // pending-wallet/journal recovery stores, so there's nothing to skip.)
    if (demoMode) {
      demoChainService.registerWallet(walletInfo.publicKey);
    } else {
      vanityCaStore.add({
        publicKey: result.publicKey,
        secretKey: result.secretKey,
        rarity: result.rarity,
        epochs: result.epochs,
        attempts: result.attempts,
        expectedAttempts: result.expectedAttempts,
        target,
        prefix: prefix || null,
        suffix: suffix || null,
        mode: vanityMode,
        caseInsensitive,
        addressLength,
      });
    }

    const qrCode = await getWalletQRCode(walletInfo.publicKey);

    res.write(`data: ${JSON.stringify({
      type: 'done',
      success: true,
      wallet: {
        publicKey: walletInfo.publicKey,
        ...(client === 'v2' ? {} : {
          // Classic still consumes the secret in its legacy renderer flow.
          // The v2 client keeps the key server-side in the persisted store.
          secretKey: walletInfo.secretKey,
          secretKeyB58: secretKeyToBase58(walletInfo.secretKey),
        }),
        mnemonic: null,
        vanity: true,
        qrCode,
        attempts: result.attempts,
        rarity: result.rarity,
        epochs: result.epochs,
        expectedAttempts: result.expectedAttempts,
        target,
        prefix: prefix || null,
        suffix: suffix || null,
        mode: vanityMode,
        caseInsensitive,
        addressLength,
        persisted: !demoMode,
      },
    })}\n\n`);

    res.end();
  } catch (error) {
    // An unfinished split job's secret is useless without its offset.
    if (splitJob) splitJobStore.remove(splitJob.id);
    // CANCELLED is a structured error code surfaced by vanityKeygen.js
    // when cancelVanityGrind() was called. It's an expected event — the
    // user clicked Cancel — so emit a dedicated {type:'cancelled'}
    // frame rather than the generic error path, and log it at info
    // level (not error) so we don't red-flag a routine user action.
    if (error.code === 'CANCELLED') {
      console.log('Vanity grind cancelled by user');
      res.write(`data: ${JSON.stringify({ type: 'cancelled' })}\n\n`);
      res.end();
      return;
    }
    console.error('Error generating vanity wallet:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    res.end();
  }
});

// Cancel any in-flight vanity grind. POST so the apiSessionMiddleware
// gates it (the same auth that protects other state-changing endpoints).
// Idempotent: if nothing is running, returns success with cancelled:false
// so the frontend can treat repeated clicks as harmless. The actual SSE
// stream from /api/generate-vanity-wallet-stream emits a {type:'cancelled'}
// event when the child finishes terminating — usually within milliseconds.
app.post('/api/cancel-vanity-grind', async (req, res) => {
  try {
    const mod = await import('./vanityKeygen.js');
    const cancelled = mod.cancelVanityGrind();
    res.json({ success: true, cancelled });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/generate-vanity-wallet', async (req, res) => {
  try {
    const demoMode = isDemoMode();
    if (!demoMode && rejectIfSecretPinLocked(res, 'generating a recoverable vanity wallet')) {
      return;
    }
    let { prefix, suffix, threads } = req.body;
    prefix = typeof prefix === 'string' ? prefix.trim() : '';
    suffix = typeof suffix === 'string' ? suffix.trim() : '';
    if (!prefix && !suffix) {
      return res.status(400).json({ success: false, error: 'prefix or suffix required' });
    }
    try {
      ({ prefix, suffix } = normalizeVanityTargetBase58(prefix, suffix));
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    // Mirror the stream endpoint's availability gate so both vanity routes
    // fail with the same shape and message when the binary isn't built.
    const vanity = await vanityAvailability();
    if (!vanity.available) {
      return res.status(503).json({
        success: false,
        error: 'Vanity address generation is not available in this build. '
          + 'The vanity_keygen binary is not built — run `npm run build:c` '
          + '(requires gcc or clang). End-user release builds include the binary.',
      });
    }

    const target = prefix && suffix ? `${prefix}...${suffix}` : (prefix || suffix);
    const vanityMode = prefix && suffix ? 'both' : (prefix ? 'prefix' : 'suffix');
    console.log(`Generating vanity wallet (${vanityMode}: "${target}")...`);

    const generateVanityKeypair = await getVanityKeygen();
    const result = await generateVanityKeypair({ prefix, suffix, threads });

    // Vanity keypairs don't have a BIP39 mnemonic (they're generated from
    // random seeds, not from a mnemonic phrase). The user can still export
    // the raw secret key.
    const walletInfo = {
      publicKey: result.publicKey,
      secretKey: result.secretKey,
      mnemonic: null, // no mnemonic for vanity keypairs
    };

    const qrCode = await getWalletQRCode(walletInfo.publicKey);
    if (demoMode) {
      // Demo: register an empty wallet in the demo ledger and DON'T touch the
      // disk-backed recovery stores — mirrors the generate-wallet demo branch
      // so synthetic demo wallets never leak into real recovery data.
      demoChainService.registerWallet(walletInfo.publicKey);
    } else {
      pendingWallets.add(walletInfo.publicKey, walletInfo.secretKey, null, {
        rarity: result.rarity,
        vanity: true,
      });
      launchJournal.start({ walletPublicKey: walletInfo.publicKey });
    }

    res.json({
      success: true,
      wallet: {
        publicKey: walletInfo.publicKey,
        secretKey: walletInfo.secretKey,
        secretKeyB58: secretKeyToBase58(walletInfo.secretKey),
        mnemonic: null,
        vanity: true,
        qrCode,
        attempts: result.attempts,
        rarity: result.rarity,
        epochs: result.epochs,
        expectedAttempts: result.expectedAttempts,
        target,
        prefix: prefix || null,
        suffix: suffix || null,
        mode: vanityMode,
      },
    });
  } catch (error) {
    console.error('Error generating vanity wallet:', error);
    sendErrorResponse(res, error);
  }
});
app.post('/api/check-balance', async (req, res) => {
  if (isDemoMode()) return demoChainService.handleCheckBalance(req, res);
  try {
    const { publicKey } = req.body;
    const balance = await checkWalletBalance(publicKey);
    res.json({ success: true, balance });
  } catch (error) {
    console.error('Error checking balance:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Multi-token balance for the funding step (SOL + every SPL token)
app.post('/api/check-balance-detailed', async (req, res) => {
  if (isDemoMode()) return demoChainService.handleCheckBalanceDetailed(req, res);
  try {
    const { publicKey } = req.body;
    const balance = await checkWalletBalanceMultiToken(publicKey);
    res.json({ success: true, balance });
  } catch (error) {
    console.error('Error checking detailed balance:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Return the launch journal state for a wallet.  The client uses this
// to resume a launch after a crash or close — it reads the token mint,
// decimals, supply, LP pool info, and current stage, then jumps to the
// appropriate step without starting over.
app.get('/api/launch-state', (req, res) => {
  try {
    const { walletPublicKey } = req.query;
    if (!walletPublicKey) {
      return res.status(400).json({ success: false, error: 'walletPublicKey is required' });
    }
    const journal = launchJournal.activeForWallet(walletPublicKey);
    if (!journal) {
      return res.json({ success: true, state: null });
    }
    // Return everything except raw events (too verbose) and secrets.
    const { events, ...rest } = journal;
    res.json({ success: true, state: rest });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// RPC config endpoints
// ---------------------------------------------------------------------------

// Get the current RPC config (active URL + saved list) for the settings UI
app.get('/api/rpc-config', (req, res) => {
  try {
    res.json({ success: true, config: getRpcConfig() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Switch to a different saved RPC. After this returns, all subsequent Solana
// operations will use the new endpoint (we refresh the cached connection in
// tokenService; lpService and walletHelpers read fresh per call already).
app.post('/api/rpc-config/select', (req, res) => {
  try {
    setActiveRpc(req.body.url);
    refreshTokenServiceConnection();
    res.json({ success: true, config: getRpcConfig() });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// Add a new RPC to the saved list. If setActive=true, also switch to it.
app.post('/api/rpc-config/add', (req, res) => {
  try {
    const { name, url, setActive } = req.body;
    addSavedRpc(name, url);
    if (setActive) {
      setActiveRpc(url);
      refreshTokenServiceConnection();
    }
    res.json({ success: true, config: getRpcConfig() });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// Remove a saved RPC. If it was active, the active selection falls back to
// the first remaining saved entry.
app.post('/api/rpc-config/remove', (req, res) => {
  try {
    removeSavedRpc(req.body.url);
    refreshTokenServiceConnection();
    res.json({ success: true, config: getRpcConfig() });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// Return current network and RPC config for the UI.
app.get('/api/rpc-config/status', (_req, res) => {
  try {
    const config = getRpcConfig();
    res.json({ success: true, config, network: getNetwork() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Switch the active network.  Updates the active RPC to the first
// saved endpoint for the new network, and persists the choice to
// userPrefs so it survives restarts.
app.post('/api/rpc-config/set-network', (req, res) => {
  try {
    const { network } = req.body;
    if (network !== 'mainnet' && network !== 'devnet') {
      return res.status(400).json({ success: false, error: 'Network must be "mainnet" or "devnet"' });
    }
    setNetwork(network);
    userPrefs.set({ network });
    refreshTokenServiceConnection();
    res.json({ success: true, config: getRpcConfig() });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// User preferences.
//
// Small key/value store for user-toggleable settings. Currently only one
// knob: checkForUpdatesOnStartup. The "don't check automatically" checkbox
// on the update-check modal in public/app.js POSTs here to flip it.
//
// Backed by userPrefs.json in TREBUCHET_CONFIG_DIR — same persistence
// pattern as rpcConfig.json. See userPrefs.js for the schema and defaults.
// ---------------------------------------------------------------------------
app.get('/api/user-prefs', (_req, res) => {
  try {
    res.json({ success: true, prefs: userPrefs.get() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/app-version', (_req, res) => {
  try {
    const macos = process.platform === 'darwin';
    res.json({
      success: true,
      version: APP_VERSION,
      releaseUrl: 'https://github.com/AnOversizedMooseWithSocks/Trebuchet/releases',
      checkForUpdatesOnStartup: userPrefs.get().checkForUpdatesOnStartup !== false,
      releaseTrust: {
        status: 'unsigned-test-artifact',
        label: 'Unsigned build',
        signingStatus: 'unsigned',
        notarizationStatus: macos ? 'not-notarized' : 'not-applicable',
        platform: process.platform,
        detail: macos
          ? 'Current macOS release downloads are unsigned and not notarized unless a release note explicitly says signed and notarized.'
          : 'Current desktop release downloads are unsigned test artifacts unless a release note explicitly says signed for this platform.',
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/user-prefs', (req, res) => {
  try {
    // userPrefs.set ignores unknown keys and type-mismatched values,
    // so a malformed request body can't corrupt the file — it'll just
    // silently drop the bad fields and persist whatever was valid.
    const updated = userPrefs.set(req.body || {});
    res.json({ success: true, prefs: updated });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Permanent launch report (Arweave). Publishes the rendered HTML report plus a
// machine-readable JSON record, signed by the launch wallet, tagged so the
// report is discoverable from the token mint WITHOUT touching token metadata.
// Called by the frontend at step 5 — while the launch wallet still exists in
// the recovery store (it's swept at step 6). Opt-out via userPrefs; the launch
// is already complete and safe before this runs, so it is never fatal.
// ---------------------------------------------------------------------------
const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || null;
  } catch (_) {
    return null;
  }
})();

app.post('/api/publish-launch-report', async (req, res) => {
  if (isDemoMode()) return demoChainService.handlePublishLaunchReport(req, res);
  try {
    // Server-side opt-out enforcement: even if a client calls this, an
    // opted-out user never publishes.
    if (userPrefs.get().publishLaunchReport === false) {
      return res.json({ success: true, skipped: true, reason: 'opted-out' });
    }

    const {
      walletPublicKey,
      tempWalletSecretKey,
      mint,
      quoteMint,
      poolIds,
      reportHtml,
      launchData,
      proofFingerprint,
    } = req.body || {};
    let reportProofFingerprint = typeof proofFingerprint === 'string' && proofFingerprint.trim()
      ? proofFingerprint.trim().slice(0, 10000)
      : typeof launchData?.proofFingerprint === 'string' && launchData.proofFingerprint.trim()
        ? launchData.proofFingerprint.trim().slice(0, 10000)
        : null;
    let reportTransferEvidenceHash = null;

    if (!mint) {
      return res.json({ success: true, skipped: true, reason: 'missing-mint' });
    }

    const reportJournal = launchJournalForReport(walletPublicKey, launchData);
    if (launchData?.source === 'trebuchet-v2') {
      const launchDataProofFingerprint = typeof launchData?.proofFingerprint === 'string' && launchData.proofFingerprint.trim()
        ? launchData.proofFingerprint.trim().slice(0, 10000)
        : null;
      const requestProofFingerprint = typeof proofFingerprint === 'string' && proofFingerprint.trim()
        ? proofFingerprint.trim().slice(0, 10000)
        : null;
      if (!launchDataProofFingerprint) {
        return res.json({
          success: true,
          skipped: true,
          reason: 'missing-proof-fingerprint',
          staleProof: true,
        });
      }
      if (requestProofFingerprint && requestProofFingerprint !== launchDataProofFingerprint) {
        return res.json({
          success: true,
          skipped: true,
          reason: 'proof-fingerprint-mismatch',
          staleProof: true,
          proofFingerprint: launchDataProofFingerprint,
        });
      }
      const derivedProofFingerprint = v2LaunchDataProofFingerprint(launchData);
      if (launchDataProofFingerprint !== derivedProofFingerprint) {
        return res.json({
          success: true,
          skipped: true,
          reason: 'launch-data-proof-fingerprint-mismatch',
          staleProof: true,
          proofFingerprint: derivedProofFingerprint,
        });
      }
      const launchJournalBinding = v2LaunchDataJournalState(launchData, reportJournal, walletPublicKey);
      if (!launchJournalBinding.backed) {
        return res.json({
          success: true,
          skipped: true,
          reason: launchJournalBinding.missing.length
            ? 'launch-journal-missing'
            : 'launch-journal-mismatch',
          launchJournalMissing: launchJournalBinding.missing.length > 0,
          launchJournalMismatch: launchJournalBinding.mismatches.length > 0,
          missing: launchJournalBinding.missing,
          mismatches: launchJournalBinding.mismatches,
        });
      }
      const launchConfigSnapshot = v2LaunchDataConfigSnapshotState(launchData);
      if (!launchConfigSnapshot.complete) {
        return res.json({
          success: true,
          skipped: true,
          reason: launchConfigSnapshot.state === 'missing'
            ? 'launch-config-snapshot-missing'
            : 'launch-config-snapshot-incomplete',
          launchConfigIncomplete: true,
          missing: launchConfigSnapshot.missing,
        });
      }
      const launchConfigConsistency = v2LaunchDataConfigConsistencyState(launchData, reportJournal, {
        requireJournalFields: true,
      });
      if (!launchConfigConsistency.consistent) {
        return res.json({
          success: true,
          skipped: true,
          reason: 'launch-config-snapshot-mismatch',
          launchConfigMismatch: true,
          mismatches: launchConfigConsistency.mismatches,
        });
      }
      const launchProofCompleteness = v2LaunchDataReportCompletenessState(launchData);
      if (!launchProofCompleteness.complete) {
        return res.json({
          success: true,
          skipped: true,
          reason: 'launch-proof-incomplete',
          launchProofIncomplete: true,
          missing: launchProofCompleteness.missing,
        });
      }
      const submittedTransferEvidenceHash = typeof launchData?.finalSweep?.transferEvidenceHash === 'string' && launchData.finalSweep.transferEvidenceHash.trim()
        ? launchData.finalSweep.transferEvidenceHash.trim()
        : typeof launchData?.transferEvidenceHash === 'string' && launchData.transferEvidenceHash.trim()
          ? launchData.transferEvidenceHash.trim()
          : null;
      if (submittedTransferEvidenceHash) {
        const derivedTransferEvidenceHash = v2TransferEvidenceHash(launchData?.transfer || {});
        if (submittedTransferEvidenceHash !== derivedTransferEvidenceHash) {
          return res.json({
            success: true,
            skipped: true,
            reason: 'transfer-evidence-hash-mismatch',
            staleProof: true,
            transferEvidenceHash: derivedTransferEvidenceHash,
          });
        }
        reportTransferEvidenceHash = derivedTransferEvidenceHash;
      }
      reportProofFingerprint = launchDataProofFingerprint;
      const airdropStatus = v2LaunchDataAirdropCompletionStatus(launchData);
      if (!airdropStatus.complete) {
        return res.json({
          success: true,
          skipped: true,
          reason: airdropStatus.retryRequired
            ? `airdrop-failed:${airdropStatus.failed}`
            : airdropStatus.missing?.length
              ? `airdrop-proof-missing:${airdropStatus.missing.join(',')}`
              : `airdrop-pending:${airdropStatus.pending}`,
          airdropIncomplete: true,
          airdropStatus,
        });
      }
    }

    if (walletPublicKey && rejectIfSecretPinLocked(res, 'publishing a launch report')) {
      return;
    }

    // Journal-backed idempotency: the report publishes during finalization,
    // which is re-runnable after a partial sweep failure. v2 reports are
    // proof-bound, so reuse is only safe when the stored proof fingerprint
    // matches the current proof. If an older/partial report exists for the
    // same mint, publish the current proof and update the journal.
    if (walletPublicKey) {
      const prior = reportJournal?.reportPublish;
      if (prior && prior.mint === mint && prior.jsonUri) {
        const priorFingerprint = typeof prior.proofFingerprint === 'string' ? prior.proofFingerprint : null;
        const priorTransferEvidenceHash = typeof prior.sweepEvidenceHash === 'string' && prior.sweepEvidenceHash.trim()
          ? prior.sweepEvidenceHash.trim()
          : typeof prior.transferEvidenceHash === 'string' && prior.transferEvidenceHash.trim()
            ? prior.transferEvidenceHash.trim()
            : null;
        const priorMatchesTransferEvidence = !reportTransferEvidenceHash
          || priorTransferEvidenceHash === reportTransferEvidenceHash;
        if (!reportProofFingerprint || (priorFingerprint === reportProofFingerprint && priorMatchesTransferEvidence)) {
          console.log(`publish-launch-report: already published for ${mint} — returning recorded URIs`);
          return res.json({
            success: true,
            mint,
            jsonUri: prior.jsonUri,
            htmlUri: prior.htmlUri || null,
            proofFingerprint: priorFingerprint,
            sweepEvidenceHash: priorTransferEvidenceHash,
            publishedAt: prior.publishedAt || null,
            alreadyPublished: true,
          });
        }
        console.log(`publish-launch-report: prior report for ${mint} belongs to a different proof or sweep state — publishing current proof`);
      }
    }

    // Sign with the launch wallet (resolved from the recovery store by pubkey,
    // or inline for demo/unmigrated callers) — the same resolver the LP routes
    // use. The signature is what lets a verifier trust a report keyed to this
    // mint: it's owned by the on-chain creator.
    const { secretKeyArr } = resolveSigner({ tempWalletSecretKey, walletPublicKey });
    const umi = createLaunchReportUmi({ secretKey: Uint8Array.from(secretKeyArr) });

    const result = await publishLaunchReport({
      enabled: true,
      umi,
      reportHtml,
      launchData,
      mint,
      quoteMint: quoteMint || null,
      poolIds: Array.isArray(poolIds) ? poolIds : [],
      appVersion: APP_VERSION,
    });
    // Persist the publish record so re-runs return the same URIs instead
    // of uploading a second copy. Only on a real success with a URI — a
    // skipped/failed result must stay retryable.
    const publishedAt = new Date().toISOString();
    if (walletPublicKey && result && result.jsonUri) {
      const reportPublishPatch = {
        reportPublish: {
          status: 'done',
          mint,
          jsonUri: result.jsonUri,
          htmlUri: result.htmlUri || null,
          proofFingerprint: reportProofFingerprint,
          ...(reportTransferEvidenceHash ? { sweepEvidenceHash: reportTransferEvidenceHash } : {}),
          publishedAt,
        },
      };
      const reportPublishEvent = {
        stage: 'report_published',
        mint,
        proofFingerprint: reportProofFingerprint,
        ...(reportTransferEvidenceHash ? { sweepEvidenceHash: reportTransferEvidenceHash } : {}),
      };
      if (reportJournal?.id) {
        launchJournal.update(reportJournal.id, reportPublishPatch, reportPublishEvent);
      } else {
        launchJournal.upsertForWallet(walletPublicKey, reportPublishPatch, reportPublishEvent);
      }
    }
    return res.json({
      success: true,
      mint,
      publishedAt,
      proofFingerprint: reportProofFingerprint,
      ...(reportTransferEvidenceHash ? { sweepEvidenceHash: reportTransferEvidenceHash } : {}),
      ...result,
    });
  } catch (err) {
    // Publishing must never look like a launch failure.
    console.error('publish-launch-report failed:', err);
    return res.json({ success: true, skipped: false, failed: true, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Demo-mode endpoints (demo-only).
//
// /api/demo/status      — the frontend calls this on app load to learn
//                         whether to show the demo banner and the "Pretend
//                         funding arrived" button. Also reports
//                         vanity-binary availability so the UI can disable
//                         the Vanity CA section gracefully on dev
//                         environments without a C toolchain (CI handles
//                         release builds, so end-user installs always
//                         include the binary).
// /api/demo/inject-funds — backs the "Pretend funding arrived (DEMO)"
//                         button; writes the funding amounts the frontend
//                         already computed into the demo ledger. Returns
//                         403 when demo mode is off so it can never affect
//                         a real launch.
// ---------------------------------------------------------------------------
app.get('/api/demo/status', async (req, res) => {
  // Vanity availability is computed once at startup (cached) and read
  // here on every status call. Cheap; never blocks the demo response.
  const vanity = await vanityAvailability();
  res.json({
    success: true,
    active: isDemoMode(),
    vanity: {
      available: vanity.available,
      // Trim the reason to a single line for the wire — the full multi-line
      // install instructions live in the server log and the binary-not-found
      // throw text. The UI only needs enough to render an explanatory
      // tooltip; users who need the full instructions check the server log.
      reason: vanity.available
        ? null
        : 'vanity_keygen binary not built. Run `npm run build:c` to enable (requires gcc or clang).',
    },
  });
});

app.post('/api/demo/inject-funds', (req, res) => {
  if (!isDemoMode()) {
    return res.status(403).json({ success: false, error: 'demo mode is not active' });
  }
  demoChainService.handleInjectFunds(req, res);
});

// v2 launch-plan preview. This is deliberately side-effect free: it validates
// the v2 launch form and returns a staged local-wallet run bundle that the v2
// shell can render. Real execution is routed separately through the guarded v2
// run-envelope bridge, which re-checks readiness server-side before calling the
// existing classic launch handlers.
app.post('/api/v2/launch-plan', (req, res) => {
  try {
    const plan = buildV2LaunchPlan(req.body || {}, {
      demoMode: isDemoMode(),
    });
    res.json({ success: true, plan });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post('/api/v2/execution-readiness', async (req, res) => {
  try {
    const config = req.body?.config || {};
    const walletPublicKey = String(req.body?.walletPublicKey || config.walletPublicKey || '').trim();
    const { readiness } = await v2ReadinessForManagedWallet({
      walletPublicKey,
      config,
      body: req.body || {},
      requireFundingBalance: true,
    });
    res.json({ success: true, readiness });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

// Verified destinations. A wallet proves control by signing a one-time
// challenge; the funding wallet is proven on-chain and needs no signature.
app.get('/api/v2/destinations', async (req, res) => {
  try {
    const launchWallet = String(req.query?.launchWallet || '').trim();
    let funder = null;
    let funders = [];
    if (launchWallet && isDemoMode()) {
      funders = demoChainService.listDemoFunders(launchWallet);
      funder = funders[0]?.address || null;
    } else if (launchWallet) {
      funder = (await findFundingWallet(launchWallet).catch(() => null))?.funder || null;
      funders = await findFundingWallets(launchWallet).catch(() => []);
    }
    res.json({ success: true, funder, funders, signed: destinationProofStore.listSignedDestinations() });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

// Buy support for an existing token/SOL pool: one SOL-only position below
// the price, capped under the token's cheapest other pool so arbitrage
// cannot take it at once. Preview reads the chain and never signs; open
// re-plans and refuses if the range or cost moved from what was confirmed.
async function resolveSupportPoolId(body = {}) {
  const poolId = String(body.poolId || '').trim();
  if (poolId) return poolId;
  const tokenMint = String(body.tokenMint || '').trim();
  if (!tokenMint) throw new Error('poolId or tokenMint is required');
  const found = await findSolClmmPoolForToken(tokenMint);
  if (!found) throw new Error('No Raydium concentrated-liquidity SOL pool was found for that token.');
  return found;
}

app.post('/api/v2/support/preview', async (req, res) => {
  try {
    const body = req.body || {};
    const walletPublicKey = String(body.walletPublicKey || '').trim() || null;
    if (isDemoMode()) {
      // Practice reads real pools (read-only) and simulates only the send,
      // with the practice wallet's balance. Practice coins have no real
      // pool, so they plan against a sample one.
      let plan = null;
      try {
        const poolId = await resolveSupportPoolId(body);
        plan = await previewSolSupport({ walletPublicKey: null, poolId, solAmount: body.solAmount, depthPct: body.depthPct });
      } catch {
        plan = null;
      }
      if (!plan) return res.json({ success: true, plan: demoChainService.planDemoSolSupport({ ...body, walletPublicKey }) });
      return res.json({ success: true, plan: demoChainService.practiceSupportPlan(plan, walletPublicKey) });
    }
    const poolId = await resolveSupportPoolId(body);
    const plan = await previewSolSupport({
      walletPublicKey,
      poolId,
      solAmount: body.solAmount,
      depthPct: body.depthPct,
    });
    res.json({ success: true, plan });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

app.post('/api/v2/support/open', async (req, res) => {
  const body = req.body || {};
  const walletPublicKey = String(body.walletPublicKey || '').trim();
  if (!walletPublicKey) {
    return res.status(400).json({ success: false, error: 'walletPublicKey is required' });
  }
  if (isDemoMode()) {
    try {
      const result = demoChainService.openDemoSolSupport({ ...body, walletPublicKey });
      if (body.tokenMint || result.token?.mint) {
        coinStore.recordEvent(String(body.tokenMint || result.token.mint), {
          type: 'support_added', practice: true, poolId: result.poolId, txId: null,
          sol: Number(result.depositLamports) / 1e9, tickLower: result.tickLower, tickUpper: result.tickUpper,
        });
      }
      return res.json({ success: true, result });
    } catch (error) {
      return res.status(409).json({ success: false, code: error.code || null, error: error.message, plan: error.plan || null });
    }
  }
  if (rejectIfSecretPinLocked(res, 'adding buy support with a saved wallet')) return;
  let claimed = false;
  try {
    const { secretKeyArr, walletPublicKey: signer } = resolveSigner({ walletPublicKey });
    if (rejectOrClaimLaunchOp(res, signer, 'add buy support')) return;
    claimed = true;
    const poolId = await resolveSupportPoolId(body);
    const result = await openSolSupport({
      tempWalletSecretKey: secretKeyArr,
      poolId,
      solAmount: body.solAmount,
      depthPct: body.depthPct,
      expected: body.expected,
    });
    console.log(`Buy support opened in ${poolId}: nft=${result.nftMint} tx=${result.txId}`);
    coinStore.recordEvent(result.token.mint, {
      type: 'support_added', poolId: result.poolId, txId: result.txId, nftMint: result.nftMint, walletPublicKey,
      sol: Number(result.depositLamports) / 1e9, tickLower: result.tickLower, tickUpper: result.tickUpper,
      outcome: result.adopted ? 'landed (found on-chain after a retry)' : 'landed',
    });
    res.json({ success: true, result });
  } catch (error) {
    if (error.code === 'SUPPORT_PLAN_CHANGED' || error.code === 'SUPPORT_INSUFFICIENT_SOL') {
      return res.status(409).json({ success: false, code: error.code, error: error.message, plan: error.plan || null });
    }
    sendErrorResponse(res, error, 400);
  } finally {
    if (claimed) clearLaunchOpInFlight(walletPublicKey);
  }
});

// Coins: drafts (saved plans), launched coins (journals), and coins added
// by address. On-chain facts are read fresh; records are claims.
// A coin's image, from its on-chain metadata document. Fetched through the
// same SSRF checks as the image proxy; ipfs:// and ar:// map to gateways.
function publicContentUrl(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${text.slice('ipfs://'.length).replace(/^ipfs\//, '')}`;
  if (text.startsWith('ar://')) return `https://arweave.net/${text.slice('ar://'.length)}`;
  return /^https?:\/\//i.test(text) ? text : null;
}

async function metadataImageUrl(metadataUri) {
  const url = publicContentUrl(metadataUri);
  if (!url) return null;
  const parsed = new URL(url);
  assertAllowedProxyUrl(parsed);
  await assertHostResolvesPublic(parsed.hostname);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(parsed.toString(), { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > 512 * 1024) return null;
    const document = JSON.parse(text);
    return publicContentUrl(document?.image);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

app.get('/api/v2/coins', (_req, res) => {
  try {
    const coins = mergeCoins({
      launches: launchStore.list(),
      journals: launchJournal.list({ includeCompleted: true, includeArchived: true }),
      added: coinStore.list(),
      practice: isDemoMode(),
    });
    res.json({ success: true, coins });
  } catch (error) {
    sendErrorResponse(res, error, 500);
  }
});

app.post('/api/v2/coins', async (req, res) => {
  try {
    const mint = validMint(req.body?.mint);
    if (!mint) return res.status(400).json({ success: false, error: 'Paste a valid token mint address.' });
    let name = null;
    let symbol = null;
    let image = null;
    if (!/^Demo/.test(mint)) {
      const connection = new Connection(getRpcUrl(), 'confirmed');
      const account = await readMintAccount(connection, mint).catch(() => null);
      if (!account) {
        return res.status(400).json({ success: false, error: 'That address is not a token mint on this network.' });
      }
      name = account.metadata?.name || null;
      symbol = account.metadata?.symbol || null;
      const info = await getTokenMetadata(mint).catch(() => null);
      name = name || info?.name || null;
      symbol = symbol || info?.symbol || null;
      image = (await metadataImageUrl(account.metadata?.uri).catch(() => null)) || publicContentUrl(info?.imageUrl);
    }
    const coin = coinStore.add({ mint, name, symbol, image, source: 'added' });
    res.json({ success: true, coin });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

app.delete('/api/v2/coins/:mint', (req, res) => {
  try {
    const mint = validMint(req.params.mint);
    if (!mint) return res.status(400).json({ success: false, error: 'Invalid mint' });
    res.json({ success: true, removed: coinStore.remove(mint) });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

// What is true about a coin launched here, fact by fact, checked against the chain
// where the chain can answer. A step's record is a claim: "done" needs the
// chain to agree; a record the chain contradicts is a mismatch, not a tick.
function coinCreationSteps(journal, { account = null, markets = null, launchWalletLamports = null } = {}) {
  const combine = (recorded, chain) => {
    if (chain === 'done') return 'done';
    if (chain === 'not-done') return recorded ? 'mismatch' : 'todo';
    // Neither the record nor the chain can say it happened.
    return recorded ? 'recorded' : 'unrecorded';
  };
  const token = journal?.token || {};
  const counts = sealedMetadataRevealReadiness(journal);
  const recordedPoolIds = v2JournalLiquidityResults(journal)
    .map((pool) => v2TrimmedText(pool?.poolId || pool?.id))
    .filter(Boolean);
  const marketIds = new Set((markets?.pools || []).map((pool) => pool.poolId));
  const steps = [];
  const mintRecorded = Boolean(token.mint) && token.mintAuthorityRenounced === true;
  steps.push({
    id: 'token',
    label: 'Token',
    state: combine(mintRecorded, account && !account.error ? (account.mintAuthority ? 'not-done' : 'done') : 'unknown'),
    detail: account && !account.error ? (account.mintAuthority ? 'The chain still shows a mint authority.' : 'Mint authority revoked on-chain.') : 'Not checked on-chain.',
  });
  const poolsRecorded = counts.recordedPoolCount >= counts.plannedPoolCount && recordedPoolIds.length > 0;
  const poolsOnChain = markets && !markets.error
    ? (recordedPoolIds.length && recordedPoolIds.every((id) => marketIds.has(id)) ? 'done' : 'not-done')
    : 'unknown';
  steps.push({
    id: 'pools',
    label: 'Pools',
    state: combine(poolsRecorded, poolsOnChain),
    detail: `${counts.recordedPoolCount}/${counts.plannedPoolCount} planned pools recorded${poolsOnChain === 'done' ? ', all found on-chain' : poolsOnChain === 'not-done' && recordedPoolIds.length ? '; not all found on-chain' : ''}.`,
  });
  steps.push({
    id: 'locks',
    label: 'Liquidity locks',
    state: combine(counts.positionCount > 0 && counts.lockedPositionCount === counts.positionCount, 'unknown'),
    detail: `${counts.lockedPositionCount}/${counts.positionCount} positions recorded as locked.`,
  });
  if (token.sealedLaunch === true) {
    steps.push({
      id: 'reveal',
      label: 'Identity',
      state: combine(token.sealedMetadataPending !== true, 'unknown'),
      detail: token.sealedMetadataPending === true ? 'The identity is still sealed.' : 'Recorded as revealed.',
    });
  }
  const walletEmptyOnChain = launchWalletLamports === null ? 'unknown' : launchWalletLamports === 0 ? 'done' : 'not-done';
  steps.push({
    id: 'return',
    label: 'Launch wallet',
    state: combine(journal?.transfer?.walletEmpty === true, walletEmptyOnChain),
    detail: launchWalletLamports === null
      ? 'Not checked on-chain.'
      : launchWalletLamports === 0
        ? 'The launch wallet is empty on-chain.'
        : `The launch wallet still holds ${(launchWalletLamports / 1e9).toFixed(4)} SOL.`,
  });
  const walletEntry = journal?.walletPublicKey ? pendingWallets.get(journal.walletPublicKey) : null;
  const { events: _events, ...journalWithoutEvents } = journal || {};
  return {
    journalId: journal?.id || null,
    journalStatus: journal?.status || null,
    stage: journal?.stage || null,
    walletPublicKey: journal?.walletPublicKey || null,
    // Whether the steps can be run from here: the record keeps the launch's
    // plan (older records did not), and this app holds the wallet's key.
    hasPlan: Boolean(journal?.launchConfig && typeof journal.launchConfig === 'object'),
    walletManaged: Boolean(walletEntry),
    journal: journalWithoutEvents,
    steps,
    nextStep: steps.find((step) => step.state !== 'done')?.id || null,
  };
}

app.get('/api/v2/coins/:mint', async (req, res) => {
  try {
    const mint = String(req.params.mint || '').trim();
    const record = coinStore.get(mint);
    const journals = launchJournal.list({ includeCompleted: true, includeArchived: true })
      .filter((journal) => String(journal?.token?.mint || '') === mint);
    const events = [
      ...journals.map((journal) => ({
        at: journal.createdAt,
        type: 'launched_here',
        outcome: journal.status === 'completed' ? 'landed' : journal.status === 'archived' ? 'stopped' : 'in progress',
        journalId: journal.id,
        stage: journal.stage || null,
      })),
      ...(record?.events || []),
    ].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    if (/^Demo/.test(mint)) {
      return res.json({ success: true, coin: { mint, practice: true, account: null, info: null, markets: null, events } });
    }
    if (!validMint(mint)) return res.status(400).json({ success: false, error: 'Invalid mint' });
    const connection = new Connection(getRpcUrl(), 'confirmed');
    const latestJournal = journals
      .slice()
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
    const [account, info, markets, launchWalletLamports] = await Promise.all([
      readMintAccount(connection, mint).catch((error) => ({ error: error.message })),
      getTokenMetadata(mint).catch(() => null),
      listTokenMarkets(mint).catch((error) => ({ error: error.message, pools: [] })),
      latestJournal?.walletPublicKey
        ? connection.getBalance(new PublicKey(latestJournal.walletPublicKey)).catch(() => null)
        : Promise.resolve(null),
    ]);
    const creation = latestJournal
      ? coinCreationSteps(latestJournal, { account, markets, launchWalletLamports })
      : null;
    const image = (account && !account.error ? await metadataImageUrl(account.metadata?.uri).catch(() => null) : null)
      || publicContentUrl(info?.imageUrl)
      || publicContentUrl(latestJournal?.token?.imageUri)
      || record?.image
      || null;
    if (image && record && record.image !== image) coinStore.add({ mint, image, source: record.source });
    res.json({ success: true, coin: { mint, practice: false, account, info, markets, events, creation, image } });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

// Positions this app's wallets hold in a coin's pools (unlocked: buy support
// and other positions they own), and withdrawing one. Withdraw re-reads the
// position and refuses if it changed since it was shown.
app.get('/api/v2/coins/:mint/positions', async (req, res) => {
  try {
    const mint = String(req.params.mint || '').trim();
    if (isDemoMode()) {
      return res.json({ success: true, positions: demoChainService.listDemoPositions(mint) });
    }
    if (!validMint(mint)) return res.status(400).json({ success: false, error: 'Invalid mint' });
    const owners = pendingWallets.list().map((wallet) => wallet.publicKey).filter(Boolean);
    const positions = await listCoinPositions({ tokenMint: mint, owners });
    res.json({ success: true, positions });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

app.post('/api/v2/positions/withdraw', async (req, res) => {
  const body = req.body || {};
  const walletPublicKey = String(body.walletPublicKey || '').trim();
  const tokenMint = String(body.tokenMint || '').trim();
  if (!walletPublicKey || !body.poolId || !body.nftMint) {
    return res.status(400).json({ success: false, error: 'walletPublicKey, poolId, and nftMint are required' });
  }
  if (isDemoMode()) {
    try {
      const result = demoChainService.withdrawDemoPosition(body);
      if (tokenMint) {
        coinStore.recordEvent(tokenMint, {
          type: 'position_withdrawn', practice: true, poolId: body.poolId, nftMint: body.nftMint,
          sol: result.solReturned, walletPublicKey,
        });
      }
      return res.json({ success: true, result });
    } catch (error) {
      return res.status(409).json({ success: false, code: error.code || null, error: error.message });
    }
  }
  if (rejectIfSecretPinLocked(res, 'withdrawing a position with a saved wallet')) return;
  let claimed = false;
  try {
    const { secretKeyArr, walletPublicKey: signer } = resolveSigner({ walletPublicKey });
    if (rejectOrClaimLaunchOp(res, signer, 'withdraw position')) return;
    claimed = true;
    const result = await withdrawPosition({
      tempWalletSecretKey: secretKeyArr,
      poolId: String(body.poolId),
      nftMint: String(body.nftMint),
      expected: body.expected,
    });
    console.log(`Position withdrawn from ${body.poolId}: nft=${body.nftMint} tx=${result.txId}`);
    if (tokenMint) {
      coinStore.recordEvent(tokenMint, {
        type: 'position_withdrawn', poolId: body.poolId, nftMint: body.nftMint, txId: result.txId, walletPublicKey,
        outcome: result.adopted ? 'landed (found withdrawn after a retry)' : 'landed',
      });
    }
    res.json({ success: true, result });
  } catch (error) {
    if (['POSITION_CHANGED', 'POSITION_NOT_FOUND'].includes(error.code)) {
      return res.status(409).json({ success: false, code: error.code, error: error.message });
    }
    sendErrorResponse(res, error, 400);
  } finally {
    if (claimed) clearLaunchOpInFlight(walletPublicKey);
  }
});

app.post('/api/v2/destinations/challenge', (req, res) => {
  try {
    res.json({ success: true, ...destinationProofStore.issueChallenge(req.body?.address) });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

app.post('/api/v2/destinations/verify', (req, res) => {
  try {
    const verified = destinationProofStore.verifyChallenge({
      nonce: req.body?.nonce,
      signature: req.body?.signature,
    });
    res.json({ success: true, ...verified });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

// Saved launches: the operator's planned launch configuration, persisted so
// it survives a restart and can be created programmatically (CLI / runner).
// Distinct from the journal, which records what a launch actually did.
app.get('/api/v2/launch-configs', (_req, res) => {
  try {
    res.json({ success: true, launches: launchStore.list() });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

app.post('/api/v2/launch-configs', (req, res) => {
  try {
    const saved = launchStore.save({
      id: req.body?.id ? String(req.body.id) : null,
      name: req.body?.name ? String(req.body.name) : null,
      config: req.body?.config || {},
      source: req.body?.source === 'cli' ? 'cli' : 'app',
    });
    res.json({ success: true, launch: saved });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

app.post('/api/v2/launch-configs/remove', (req, res) => {
  try {
    const id = String(req.body?.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'id required' });
    res.json({ success: true, removed: launchStore.remove(id) });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

// Flywheel pools: the meme flywheel draws a random pairing from a curated
// pool of memecoins instead of one hardcoded mint. Operators can curate it.
app.get('/api/v2/flywheel-pools', (_req, res) => {
  try {
    res.json({ success: true, pools: launchFlywheels.all() });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

app.post('/api/v2/flywheel-pools/add', (req, res) => {
  try {
    const kind = String(req.body?.kind || 'meme');
    const mints = launchFlywheels.add(kind, req.body?.mint);
    res.json({ success: true, kind, mints });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

app.post('/api/v2/flywheel-pools/remove', (req, res) => {
  try {
    const kind = String(req.body?.kind || 'meme');
    const removed = launchFlywheels.remove(kind, req.body?.mint);
    res.json({ success: true, kind, removed, mints: launchFlywheels.list(kind) });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

app.post('/api/v2/flywheel-pools/pick', (req, res) => {
  try {
    const kind = String(req.body?.kind || 'meme');
    const mint = launchFlywheels.pick(kind, { last: req.body?.last || null });
    res.json({ success: true, kind, mint });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

function latestLaunchJournalForWallet(walletPublicKey) {
  if (!walletPublicKey) return null;
  const active = launchJournal.activeForWallet(walletPublicKey);
  if (active) return active;
  return launchJournal
    .list({ includeCompleted: true, includeArchived: false })
    .filter((entry) => entry.walletPublicKey === walletPublicKey)
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))[0] || null;
}

function v2LaunchDataJournalId(launchData = {}) {
  const directId = typeof launchData?.journalId === 'string' ? launchData.journalId.trim() : '';
  if (directId) return directId;
  return typeof launchData?.recoveryAudit?.journalId === 'string'
    ? launchData.recoveryAudit.journalId.trim()
    : '';
}

function launchJournalForReport(walletPublicKey, launchData = {}) {
  const requestedId = v2LaunchDataJournalId(launchData);
  if (requestedId) {
    const exact = launchJournal.get(requestedId);
    return exact && exact.status !== 'archived' ? exact : null;
  }
  return latestLaunchJournalForWallet(walletPublicKey);
}

function v2ExecutionContextFromJournal(walletPublicKey, body = {}) {
  // The pure fold lives in Core (v2-execution-context); the app supplies
  // the journal it looked up from the Core launch-journal store.
  return buildV2ExecutionContext({ journal: latestLaunchJournalForWallet(walletPublicKey), body });
}

function v2PoolTopologySnapshotFromPlan(plan = {}, journal = null) {
  const planTopology = plan?.poolTopology && typeof plan.poolTopology === 'object'
    ? plan.poolTopology
    : {};
  const journalPoolPlan = journal?.poolPlan && typeof journal.poolPlan === 'object'
    ? journal.poolPlan
    : null;
  const topology = { ...planTopology };
  if (journalPoolPlan) {
    if (Number.isFinite(Number(journalPoolPlan.targetMarketCapUsd))) {
      topology.targetMarketCapUsd = Number(journalPoolPlan.targetMarketCapUsd);
    }
    if (Array.isArray(journalPoolPlan.allocations) && journalPoolPlan.allocations.length > 0) {
      topology.pools = cloneJson(journalPoolPlan.allocations);
    }
    if (journalPoolPlan.airdropPlan && typeof journalPoolPlan.airdropPlan === 'object') {
      topology.airdrop = {
        ...(topology.airdrop && typeof topology.airdrop === 'object' ? topology.airdrop : {}),
        ...cloneJson(journalPoolPlan.airdropPlan),
      };
    }
  }
  return topology;
}

function v2LaunchConfigSnapshotFromPlan(plan = {}, journal = null) {
  const token = plan?.token && typeof plan.token === 'object' ? plan.token : {};
  const journalToken = journal?.token && typeof journal.token === 'object' && Object.keys(journal.token).length > 0
    ? journal.token
    : null;
  const journalPoolPlan = journal?.poolPlan && typeof journal.poolPlan === 'object'
    ? journal.poolPlan
    : null;
  const tokenSource = journalToken || token;
  const topology = v2PoolTopologySnapshotFromPlan(plan, journal);
  const logo = token.logo && typeof token.logo === 'object'
    ? {
      name: token.logo.name || null,
      type: token.logo.type || token.logo.mimeType || null,
      size: Number.isFinite(Number(token.logo.size ?? token.logo.sizeBytes))
        ? Number(token.logo.size ?? token.logo.sizeBytes)
        : null,
    }
    : null;
  return {
    schema: 'trebuchet-v2-launch-config',
    source: 'trebuchet-v2',
    token: {
      name: tokenSource.name || null,
      symbol: tokenSource.symbol || null,
      supply: tokenSource.supply || tokenSource.totalSupply || journalPoolPlan?.tokenTotalSupply || null,
      description: tokenSource.description || null,
      decimals: tokenSource.decimals ?? journalPoolPlan?.tokenDecimals ?? 9,
      mintFormat: tokenSource.mintFormat || token.mintFormat || 'token-2022',
      tokenProgram: tokenSource.tokenProgram || token.tokenProgram || null,
      metadataStandard: tokenSource.metadataStandard || token.metadataStandard || null,
      logo,
      sealedLaunch: tokenSource.sealedLaunch === true,
    },
    launchSol: Number.isFinite(Number(plan?.funding?.launchSol)) ? Number(plan.funding.launchSol) : null,
    mode: plan?.mode || null,
    vanity: plan?.vanity || null,
    poolTopology: topology,
    funding: {
      launchSol: Number.isFinite(Number(plan?.funding?.launchSol)) ? Number(plan.funding.launchSol) : null,
      targetMarketCapUsd: Number.isFinite(Number(topology?.targetMarketCapUsd))
        ? Number(topology.targetMarketCapUsd)
        : null,
    },
    recovery: plan?.recovery || null,
  };
}

function v2ExecutionProofFromContext(context = {}, readiness = {}) {
  const journal = context.journal || null;
  const plan = readiness?.plan || null;
  const tokenInfo = context.createdTokenInfo || journal?.token || null;
  const tokenMint = tokenInfo?.mint || context.tokenMint || readiness?.tokenMint || null;
  const lpResults = Array.isArray(journal?.lp?.results)
    ? journal.lp.results
    : Array.isArray(journal?.lp?.priorResults)
      ? journal.lp.priorResults
      : Array.isArray(context.priorResults)
        ? context.priorResults
        : [];
  const poolIds = [...new Set(lpResults.map((pool) => pool?.poolId).filter(Boolean).map(String))];
  const journalPoolPlan = journal?.poolPlan && typeof journal.poolPlan === 'object'
    ? cloneJson(journal.poolPlan)
    : null;
  const plannedPoolCount = Math.max(
    1,
    Array.isArray(journalPoolPlan?.pools) ? journalPoolPlan.pools.length : 0,
    Array.isArray(plan?.poolTopology?.pools) ? plan.poolTopology.pools.length : 0,
  );
  const reportablePoolIdentity = Boolean(
    plannedPoolCount > 0
    && poolIds.length === plannedPoolCount
    && lpResults.length === plannedPoolCount
  );
  const positionCount = v2ProofPositionCount(lpResults);
  const poolCreateTxCount = v2ProofPoolCreateTxCount(lpResults);
  const positionOpenTxCount = v2ProofPositionOpenTxCount(lpResults);
  const positionLockTxCount = v2ProofPositionLockTxCount(lpResults);
  const positions = lpResults.reduce((counts, pool) => {
    counts.main += Array.isArray(pool?.mainPositions) ? pool.mainPositions.length : 0;
    counts.ladder += Array.isArray(pool?.ladderPositions) ? pool.ladderPositions.length : 0;
    counts.support += Array.isArray(pool?.supportPositions) ? pool.supportPositions.length : 0;
    counts.bootstrap += pool?.bootstrap ? 1 : 0;
    return counts;
  }, { main: 0, ladder: 0, support: 0, bootstrap: 0 });
  const lockCount = lpResults.reduce((count, pool) => {
    const positionsForPool = [
      ...(Array.isArray(pool?.mainPositions) ? pool.mainPositions : []),
      ...(Array.isArray(pool?.ladderPositions) ? pool.ladderPositions : []),
      ...(Array.isArray(pool?.supportPositions) ? pool.supportPositions : []),
      ...(pool?.bootstrap ? [pool.bootstrap] : []),
    ];
    return count + positionsForPool.filter((position) => position?.locked === true).length;
  }, 0);
  const feeKeyCount = lpResults.reduce((count, pool) => {
    const positionsForPool = [
      ...(Array.isArray(pool?.mainPositions) ? pool.mainPositions : []),
      ...(Array.isArray(pool?.ladderPositions) ? pool.ladderPositions : []),
      ...(Array.isArray(pool?.supportPositions) ? pool.supportPositions : []),
      ...(pool?.bootstrap ? [pool.bootstrap] : []),
    ];
    return count + positionsForPool.filter((position) => position?.feeKeyNftMint).length;
  }, 0);
  const feeKeyRecipientSummary = v2ProofFeeKeyRecipientSummary(lpResults);
  const tokenAuthoritiesComplete = Boolean(
    tokenInfo?.mintAuthorityRenounced === true
    && tokenInfo?.freezeAuthorityDisabled === true
    && tokenInfo?.metadataUpdateAuthorityRevoked === true
    && tokenInfo?.metadataImmutable === true
    && (tokenInfo?.mintFormat !== 'token-2022'
      || tokenInfo?.metadataPointerAuthorityRevoked === true)
  );
  const reportableExecutionProof = Boolean(
    tokenMint
    && tokenAuthoritiesComplete
    && reportablePoolIdentity
    && poolCreateTxCount >= plannedPoolCount
    && positionCount > 0
    && positionOpenTxCount >= positionCount
    && lockCount >= positionCount
    && positionLockTxCount >= positionCount
    && feeKeyCount >= lockCount
    && feeKeyRecipientSummary.delivered >= feeKeyRecipientSummary.target
  );
  const airdropPayload =
    readiness?.classicPayloads?.transferAssets?.airdrop ||
    readiness?.classicPayloads?.createLp?.airdrop ||
    null;
  const plannedRecipients = Array.isArray(airdropPayload?.recipients)
    ? airdropPayload.recipients
    : [];
  const configuredAirdropCount = plan?.poolTopology?.airdrop?.enabled
    ? Math.max(0, Number(plan.poolTopology.airdrop.recipientCount || 0))
    : 0;
  const plannedAirdropCount = Math.max(
    Number.isFinite(configuredAirdropCount) ? Math.floor(configuredAirdropCount) : 0,
    plannedRecipients.length,
  );
  const airdropRecord = journal?.airdrop || null;
  const deliveredAirdrop = Array.isArray(airdropRecord?.transferred) ? airdropRecord.transferred : [];
  const failedAirdrop = Array.isArray(airdropRecord?.failed) ? airdropRecord.failed : [];
  const reportPublish = journal?.reportPublish || null;
  const transfer = journal?.transfer || null;
  const destinationWallet =
    transfer?.destinationWallet ||
    readiness?.classicPayloads?.transferAssets?.destinationWallet ||
    plan?.poolTopology?.sweepDestination ||
    null;

  return {
    source: journal ? 'launch-journal' : 'readiness',
    journalId: journal?.id || null,
    status: journal?.status || null,
    stage: journal?.stage || null,
    walletPublicKey: journal?.walletPublicKey || readiness?.walletPublicKey || null,
    updatedAt: journal?.updatedAt || null,
    token: tokenMint ? {
      mint: tokenMint,
      name: tokenInfo?.name || plan?.token?.name || null,
      symbol: tokenInfo?.symbol || plan?.token?.symbol || null,
      decimals: tokenInfo?.decimals ?? plan?.token?.decimals ?? 9,
      totalSupply: tokenInfo?.totalSupply ?? plan?.token?.supply ?? null,
      metadataUri: tokenInfo?.metadataUri || null,
      imageUri: tokenInfo?.imageUri || null,
      mintFormat: tokenInfo?.mintFormat || plan?.token?.mintFormat || null,
      tokenProgram: tokenInfo?.tokenProgram || plan?.token?.tokenProgram || null,
      metadataStandard: tokenInfo?.metadataStandard || plan?.token?.metadataStandard || null,
      metadataPointerAuthorityRevoked: tokenInfo?.metadataPointerAuthorityRevoked === true,
      mintAuthorityRenounced: tokenInfo?.mintAuthorityRenounced === true,
      freezeAuthorityDisabled: tokenInfo?.freezeAuthorityDisabled === true,
      metadataUpdateAuthorityRevoked: tokenInfo?.metadataUpdateAuthorityRevoked === true,
      metadataImmutable: tokenInfo?.metadataImmutable === true,
    } : null,
    liquidity: {
      complete: context.liquidityComplete === true,
      poolCount: lpResults.length,
      poolIds,
      positions,
      lockedPositionCount: lockCount,
      feeKeyCount,
      results: lpResults,
    },
    poolPlan: journalPoolPlan,
    airdrop: {
      plannedRecipientCount: plannedAirdropCount,
      deliveredCount: deliveredAirdrop.length,
      failedCount: failedAirdrop.length,
      transferred: deliveredAirdrop,
      failed: failedAirdrop,
      tokenMint: airdropPayload?.tokenMint || tokenMint || null,
      tokenDecimals: airdropPayload?.tokenDecimals ?? tokenInfo?.decimals ?? plan?.token?.decimals ?? 9,
      recipients: plannedRecipients,
    },
    reportPublish,
    transfer,
    destinationWallet,
    launchConfig: v2LaunchConfigSnapshotFromPlan(plan, journal),
    canPublishReport: reportableExecutionProof,
    canRunAirdrop: Boolean(tokenMint && plannedRecipients.length > 0),
    canRetryAirdrop: failedAirdrop.length > 0,
    canSweep: Boolean(tokenMint && destinationWallet),
  };
}

function v2ProofPositionCount(results = []) {
  return v2ProofPositionRecords(results).length;
}

function v2ProofPositionRecords(results = []) {
  return (Array.isArray(results) ? results : []).flatMap((pool) => {
    if (Array.isArray(pool?.positions) && pool.positions.length) return pool.positions;
    return [
      ...(Array.isArray(pool?.mainPositions) ? pool.mainPositions : []),
      ...(Array.isArray(pool?.ladderPositions) ? pool.ladderPositions : []),
      ...(Array.isArray(pool?.supportPositions) ? pool.supportPositions : []),
      ...(pool?.bootstrap ? [pool.bootstrap] : []),
    ];
  });
}

function v2ProofLockedPositionCount(results = []) {
  return v2ProofPositionRecords(results).filter((position) => position?.locked === true).length;
}

function v2ProofFeeKeyCount(results = []) {
  return v2ProofPositionRecords(results).filter((position) => position?.feeKeyNftMint || position?.feeKeyMint).length;
}

function v2ProofPoolCreateTxCount(results = []) {
  return (Array.isArray(results) ? results : []).filter((pool) => (
    v2TrimmedText(pool?.poolId || pool?.id)
    && v2TrimmedText(pool?.createPoolTx || pool?.txIds?.createPool)
  )).length;
}

function v2ProofPositionOpenTxCount(results = []) {
  return v2ProofPositionRecords(results).filter((position) => (
    v2TrimmedText(position?.positionNftMint || position?.nftMint || position?.positionMint)
    && v2TrimmedText(position?.openTx || position?.txIds?.open)
  )).length;
}

function v2ProofPositionLockTxCount(results = []) {
  return v2ProofPositionRecords(results).filter((position) => (
    position?.locked === true
    && v2TrimmedText(position?.lockTx || position?.txIds?.lock)
  )).length;
}

function v2ProofFeeKeyRecipientSummary(results = []) {
  const targeted = v2ProofPositionRecords(results).filter((position) => v2TrimmedText(position?.recipient));
  const delivered = targeted.filter((position) => (
    v2TrimmedText(position?.transferredTo) === v2TrimmedText(position?.recipient)
    && v2TrimmedText(position?.transferTx || position?.txIds?.transfer)
  ));
  return {
    target: targeted.length,
    delivered: delivered.length,
  };
}

const V2_AUTHORITY_COMPARISON_FIELDS = Object.freeze([
  'mintAuthorityRenounced',
  'freezeAuthorityDisabled',
  'metadataUpdateAuthorityRevoked',
  'metadataImmutable',
]);

function v2OptionalBoolean(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function v2NumberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function v2StableHashString(value) {
  const text = String(value ?? '');
  const bytes = [];
  for (let index = 0; index < text.length; index += 1) {
    let codePoint = text.codePointAt(index);
    if (codePoint > 0xffff) index += 1;
    if (codePoint <= 0x7f) bytes.push(codePoint);
    else if (codePoint <= 0x7ff) bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    else if (codePoint <= 0xffff) bytes.push(0xe0 | (codePoint >>> 12), 0x80 | ((codePoint >>> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    else bytes.push(0xf0 | (codePoint >>> 18), 0x80 | ((codePoint >>> 12) & 0x3f), 0x80 | ((codePoint >>> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
  }
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 0xff);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 0xff);
  const rotate = (word, bits) => (word >>> bits) | (word << (32 - bits));
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array(64).fill(0);
    for (let index = 0; index < 16; index += 1) {
      const cursor = offset + (index * 4);
      words[index] = ((bytes[cursor] << 24) | (bytes[cursor + 1] << 16) | (bytes[cursor + 2] << 8) | bytes[cursor + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotate(words[index - 15], 7) ^ rotate(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotate(words[index - 2], 17) ^ rotate(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + constants[index] + words[index]) >>> 0;
      const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((word, index) => { state[index] = (state[index] + word) >>> 0; });
  }
  return state.map((word) => word.toString(16).padStart(8, '0')).join('');
}

function v2NormalizeAirdropEntry(row = {}) {
  return {
    wallet: row.wallet || row.recipient || row.address || null,
    tokens: v2NumberOrNull(row.tokens),
    amountRaw: row.amountRaw == null ? null : String(row.amountRaw),
    txId: row.txId || row.signature || row.tx || null,
  };
}

function v2NormalizeAirdropForFingerprint(airdrop = {}) {
  const normalizeList = (rows = []) => (Array.isArray(rows) ? rows : [])
    .map(v2NormalizeAirdropEntry)
    .filter((row) => row.wallet)
    .sort((a, b) => [
      a.wallet || '',
      String(a.tokens ?? ''),
      String(a.amountRaw ?? ''),
      a.txId || '',
    ].join('|').localeCompare([
      b.wallet || '',
      String(b.tokens ?? ''),
      String(b.amountRaw ?? ''),
      b.txId || '',
    ].join('|')));
  return {
    recipientsHash: v2StableHashString(JSON.stringify(normalizeList(airdrop.recipients))),
    transferredHash: v2StableHashString(JSON.stringify(normalizeList(airdrop.transferred))),
    failedHash: v2StableHashString(JSON.stringify(normalizeList(airdrop.failed))),
  };
}

function v2TransferEvidenceRows(transfer = {}) {
  const rows = [];
  const tokenTransfers = Array.isArray(transfer?.tokenSweep?.transferred) ? transfer.tokenSweep.transferred : [];
  const nftTransfers = Array.isArray(transfer?.nftSweep?.transferred) ? transfer.nftSweep.transferred : [];
  const tokenErrors = Array.isArray(transfer?.tokenTransferErrors)
    ? transfer.tokenTransferErrors
    : Array.isArray(transfer?.tokenSweep?.errors) ? transfer.tokenSweep.errors : [];
  const nftErrors = Array.isArray(transfer?.nftTransferErrors)
    ? transfer.nftTransferErrors
    : Array.isArray(transfer?.nftSweep?.errors) ? transfer.nftSweep.errors : [];
  const solAmount = v2NumberOrNull(transfer?.solSweep?.solTransferred ?? transfer?.solTransferred);
  const solTx = transfer?.solSweep?.txId || transfer?.solTxId || transfer?.txId || transfer?.signature || null;

  if (solAmount != null || solTx || transfer?.solSweepError) {
    rows.push({
      type: 'sol',
      asset: 'SOL',
      amount: solAmount,
      decimals: null,
      txId: solTx,
      status: transfer?.solSweepError || null,
      error: Boolean(transfer?.solSweepError),
    });
  }

  tokenTransfers.forEach((row) => {
    rows.push({
      type: 'token',
      asset: row.mint || row.tokenMint || null,
      amount: row.amount == null ? null : String(row.amount),
      decimals: v2NumberOrNull(row.decimals),
      txId: row.txId || row.signature || null,
      status: 'transferred',
      error: false,
    });
  });

  nftTransfers.forEach((row) => {
    rows.push({
      type: 'nft',
      asset: row.mint || row.nftMint || null,
      amount: '1',
      programName: row.programName || null,
      txId: row.txId || row.signature || null,
      status: 'transferred',
      error: false,
    });
  });

  tokenErrors.forEach((row) => {
    rows.push({
      type: 'token',
      asset: row.mint || row.tokenMint || null,
      amount: null,
      decimals: v2NumberOrNull(row.decimals),
      txId: row.txId || row.signature || null,
      status: row.error || row.reason || 'transfer failed',
      error: true,
    });
  });

  nftErrors.forEach((row) => {
    rows.push({
      type: 'nft',
      asset: row.mint || row.nftMint || null,
      amount: null,
      programName: row.programName || null,
      txId: row.txId || row.signature || null,
      status: row.error || row.reason || 'transfer failed',
      error: true,
    });
  });

  return rows.sort((a, b) => [
    a.type || '',
    a.asset || '',
    String(a.amount ?? ''),
    String(a.decimals ?? ''),
    a.programName || '',
    a.txId || '',
    a.status || '',
    String(a.error),
  ].join('|').localeCompare([
    b.type || '',
    b.asset || '',
    String(b.amount ?? ''),
    String(b.decimals ?? ''),
    b.programName || '',
    b.txId || '',
    b.status || '',
    String(b.error),
  ].join('|')));
}

function v2TransferEvidenceHash(transfer = {}) {
  if (!transfer || typeof transfer !== 'object' || Object.keys(transfer).length === 0) return null;
  return v2StableHashString(JSON.stringify({
    destinationWallet: transfer.destinationWallet || null,
    status: transfer.status || null,
    walletEmpty: v2OptionalBoolean(transfer.walletEmpty),
    rows: v2TransferEvidenceRows(transfer),
  }));
}

function v2ProofPoolsForFingerprint(results = []) {
  return (Array.isArray(results) ? results : []).map((pool) => {
    const txIds = pool?.txIds || {};
    return {
      poolId: pool?.poolId || pool?.id || null,
      quoteMint: pool?.quoteMint || pool?.quoteAddress || null,
      supplyPercent: v2NumberOrNull(pool?.supplyPercent),
      tickSpacing: v2NumberOrNull(pool?.tickSpacing),
      initialPrice: pool?.initialPrice == null ? null : String(pool.initialPrice),
      launchedSide: pool?.launchedSide || null,
      createPoolTx: pool?.createPoolTx || txIds.createPool || null,
    };
  }).sort((a, b) => [
    a.poolId || '',
    a.quoteMint || '',
    String(a.tickSpacing ?? ''),
    String(a.initialPrice ?? ''),
  ].join('|').localeCompare([
    b.poolId || '',
    b.quoteMint || '',
    String(b.tickSpacing ?? ''),
    String(b.initialPrice ?? ''),
  ].join('|')));
}

function v2ProofPositionsForFingerprint(results = []) {
  return (Array.isArray(results) ? results : []).flatMap((pool) => {
    const poolId = pool?.poolId || pool?.id || null;
    const toRecord = (position = {}, type) => ({
      poolId,
      type: type || position.type || position.kind || null,
      sliceIndex: v2NumberOrNull(position.sliceIndex),
      bandIndex: v2NumberOrNull(position.bandIndex),
      supportIndex: v2NumberOrNull(position.supportIndex),
      sharePercent: v2NumberOrNull(position.sharePercent),
      supplyPercent: v2NumberOrNull(position.supplyPercent),
      lowerMultiplier: v2NumberOrNull(position.lowerMultiplier),
      upperMultiplier: v2NumberOrNull(position.upperMultiplier),
      depthPct: v2NumberOrNull(position.depthPct),
      positionNftMint: position.positionNftMint || position.nftMint || position.positionMint || null,
      feeKeyNftMint: position.feeKeyNftMint || position.feeKeyMint || null,
      locked: v2OptionalBoolean(position.locked),
      recipient: position.recipient || null,
      transferredTo: position.transferredTo || null,
      tickLower: v2NumberOrNull(position.tickLower),
      tickUpper: v2NumberOrNull(position.tickUpper),
      openTx: position.openTx || position.txIds?.open || null,
      lockTx: position.lockTx || position.txIds?.lock || null,
      transferTx: position.transferTx || position.txIds?.transfer || null,
    });
    if (Array.isArray(pool?.positions) && pool.positions.length) {
      return pool.positions.map((position) => toRecord(position, position.type || position.kind || null));
    }
    return [
      ...(Array.isArray(pool?.mainPositions) ? pool.mainPositions.map((position) => toRecord(position, 'main')) : []),
      ...(Array.isArray(pool?.ladderPositions) ? pool.ladderPositions.map((position) => toRecord(position, 'ladder')) : []),
      ...(Array.isArray(pool?.supportPositions) ? pool.supportPositions.map((position) => toRecord(position, 'support')) : []),
      ...(pool?.bootstrap ? [toRecord(pool.bootstrap, 'bootstrap')] : []),
    ];
  }).sort((a, b) => [
    a.poolId || '',
    a.positionNftMint || '',
    a.feeKeyNftMint || '',
    a.type || '',
    String(a.sliceIndex ?? ''),
    String(a.bandIndex ?? ''),
    String(a.supportIndex ?? ''),
    String(a.sharePercent ?? ''),
    String(a.supplyPercent ?? ''),
    String(a.lowerMultiplier ?? ''),
    String(a.upperMultiplier ?? ''),
    String(a.depthPct ?? ''),
    String(a.tickLower ?? ''),
    String(a.tickUpper ?? ''),
    a.recipient || '',
    a.transferredTo || '',
    a.openTx || '',
    a.lockTx || '',
    a.transferTx || '',
  ].join('|').localeCompare([
    b.poolId || '',
    b.positionNftMint || '',
    b.feeKeyNftMint || '',
    b.type || '',
    String(b.sliceIndex ?? ''),
    String(b.bandIndex ?? ''),
    String(b.supportIndex ?? ''),
    String(b.sharePercent ?? ''),
    String(b.supplyPercent ?? ''),
    String(b.lowerMultiplier ?? ''),
    String(b.upperMultiplier ?? ''),
    String(b.depthPct ?? ''),
    String(b.tickLower ?? ''),
    String(b.tickUpper ?? ''),
    b.recipient || '',
    b.transferredTo || '',
    b.openTx || '',
    b.lockTx || '',
    b.transferTx || '',
    ].join('|')));
}


function v2TransferSweptAssetCount(transfer = {}) {
  const tokenRows = Array.isArray(transfer.tokenSweep?.transferred) ? transfer.tokenSweep.transferred.length : 0;
  const nftRows = Array.isArray(transfer.nftSweep?.transferred) ? transfer.nftSweep.transferred.length : 0;
  const tokens = Number(transfer.tokensTransferred || 0);
  const nfts = Number(transfer.nftsTransferred || 0);
  const sol = Number(transfer.solTransferred || 0);
  return (Number.isFinite(tokens) ? tokens : 0)
    + (Number.isFinite(nfts) ? nfts : 0)
    + tokenRows
    + nftRows
    + (Number.isFinite(sol) && sol > 0 ? 1 : 0);
}

function v2TransferHasFinalSweepEvidence(transfer = null) {
  if (!transfer || typeof transfer !== 'object') return false;
  if (!String(transfer.destinationWallet || '').trim()) return false;
  if (transfer.status === 'planned-before-sweep') return false;
  if (transfer.walletEmpty === true) return v2TransferSweepErrorCount(transfer) === 0;
  if (transfer.walletEmpty === false) return false;
  if (v2TransferSweepErrorCount(transfer) > 0) return false;
  return v2TransferSweptAssetCount(transfer) > 0;
}


function v2ProofEffectiveDestination(proof = {}) {
  const transfer = proof?.transfer || null;
  return v2TransferHasWalletEmptyFinalSweepEvidence(transfer)
    ? String(transfer.destinationWallet || '').trim() || null
    : proof?.destinationWallet || null;
}

function v2ProofFromLaunchData(launchData = {}) {
  const pools = Array.isArray(launchData?.pools) ? launchData.pools : [];
  const authorities = launchData?.token?.authorities || {};
  const transfer = launchData?.transfer && typeof launchData.transfer === 'object'
    ? launchData.transfer
    : null;
  return {
    walletPublicKey: launchData.launchWallet || launchData.walletPublicKey || null,
    transfer,
    destinationWallet: v2TransferHasWalletEmptyFinalSweepEvidence(transfer)
      ? transfer.destinationWallet
      : launchData.destinationWallet || null,
    token: {
      mint: launchData?.token?.mint || launchData.mint || null,
      mintFormat: launchData?.token?.mintFormat || null,
      tokenProgram: launchData?.token?.tokenProgram || null,
      metadataStandard: launchData?.token?.metadataStandard || null,
      mintAuthorityRenounced: authorities.mintAuthorityRenounced === true,
      freezeAuthorityDisabled: authorities.freezeAuthorityDisabled === true,
      metadataUpdateAuthorityRevoked: authorities.metadataUpdateAuthorityRevoked === true,
      metadataImmutable: authorities.metadataImmutable === true,
      metadataPointerAuthorityRevoked: authorities.metadataPointerAuthorityRevoked === true,
    },
    liquidity: {
      poolIds: pools.map((pool) => pool?.poolId).filter(Boolean),
      positionCount: v2NumberOrNull(launchData?.liquidity?.positionCount),
      lockedPositionCount: v2NumberOrNull(launchData?.liquidity?.lockedPositionCount),
      feeKeyCount: v2NumberOrNull(launchData?.liquidity?.feeKeyCount),
      results: pools.map((pool) => ({
        poolId: pool?.poolId || null,
        quoteMint: pool?.quoteMint || null,
        supplyPercent: pool?.supplyPercent ?? null,
        tickSpacing: pool?.tickSpacing ?? null,
        initialPrice: pool?.initialPrice ?? null,
        launchedSide: pool?.launchedSide || null,
        createPoolTx: pool?.createPoolTx || null,
        positions: Array.isArray(pool?.positions) ? pool.positions : [],
      })),
    },
    airdrop: launchData.airdrop || {},
  };
}

function v2LaunchProofFingerprint(proof = {}) {
  const results = Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results : [];
  const poolIds = [
    ...(Array.isArray(proof?.liquidity?.poolIds) ? proof.liquidity.poolIds : []),
    ...results.map((pool) => pool?.poolId).filter(Boolean),
  ].filter((value, index, list) => value && list.indexOf(value) === index).sort();
  const terminalTransferEvidenceHash = v2TransferHasWalletEmptyFinalSweepEvidence(proof?.transfer)
    ? v2TransferEvidenceHash(proof.transfer)
    : null;
  return JSON.stringify({
    mint: proof?.token?.mint || null,
    launchWallet: proof?.walletPublicKey || null,
    destinationWallet: v2ProofEffectiveDestination(proof),
    terminalTransferEvidenceHash,
    poolIds,
    pools: v2ProofPoolsForFingerprint(results),
    positionCount: v2OptionalReportCount(proof?.liquidity?.positionCount, v2ProofPositionCount(results)),
    lockedPositionCount: v2OptionalReportCount(proof?.liquidity?.lockedPositionCount, v2ProofLockedPositionCount(results)),
    feeKeyCount: v2OptionalReportCount(proof?.liquidity?.feeKeyCount, v2ProofFeeKeyCount(results)),
    positions: v2ProofPositionsForFingerprint(results),
    authorities: V2_AUTHORITY_COMPARISON_FIELDS.reduce((record, field) => {
      record[field] = v2OptionalBoolean(proof?.token?.[field]);
      return record;
    }, {}),
    airdrop: {
      plannedRecipientCount: Number(proof?.airdrop?.plannedRecipientCount || 0),
      deliveredCount: Number(proof?.airdrop?.deliveredCount || 0),
      failedCount: Number(proof?.airdrop?.failedCount || 0),
      ...v2NormalizeAirdropForFingerprint(proof?.airdrop || {}),
    },
  });
}

function v2LaunchDataProofFingerprint(launchData = {}) {
  return v2LaunchProofFingerprint(v2ProofFromLaunchData(launchData));
}

function v2LaunchConfigSnapshotHasV2Envelope(launchConfig = null) {
  return Boolean(
    launchConfig
      && typeof launchConfig === 'object'
      && String(launchConfig.schema || '').trim() === 'trebuchet-v2-launch-config'
      && String(launchConfig.source || '').trim() === 'trebuchet-v2'
  );
}

function v2LaunchDataConfigSnapshotState(launchData = {}) {
  const launchConfig = launchData?.launchConfig && typeof launchData.launchConfig === 'object'
    ? launchData.launchConfig
    : null;
  const missing = [];
  if (!launchConfig) {
    return { state: 'missing', complete: false, missing: ['snapshot'] };
  }
  if (!v2LaunchConfigSnapshotHasV2Envelope(launchConfig)) {
    missing.push('Trebuchet snapshot marker');
  }
  const token = launchConfig.token && typeof launchConfig.token === 'object'
    ? launchConfig.token
    : null;
  const topology = launchConfig.poolTopology && typeof launchConfig.poolTopology === 'object'
    ? launchConfig.poolTopology
    : null;
  if (!token) {
    missing.push('token');
  } else {
    if (!String(token.name || token.symbol || '').trim()) missing.push('token identity');
    if (!String(token.supply ?? '').trim()) missing.push('token supply');
  }
  if (!topology) {
    missing.push('pool topology');
  } else if (!Array.isArray(topology.pools) || topology.pools.length === 0) {
    missing.push('planned pools');
  }
  return {
    state: missing.length ? 'incomplete' : 'complete',
    complete: missing.length === 0,
    missing,
  };
}

function v2TrimmedText(value) {
  return String(value ?? '').trim();
}

function v2SortedTextList(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(v2TrimmedText)
    .filter(Boolean))]
    .sort();
}

function v2SameTextList(left = [], right = []) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function v2JournalLiquidityResults(journal = {}) {
  if (typeof priorResultsFromJournal === 'function') return priorResultsFromJournal(journal);
  const lp = journal?.lp || {};
  return Array.isArray(lp.results) && lp.results.length > 0
    ? lp.results
    : (Array.isArray(lp.partialResults) ? lp.partialResults : []);
}

function v2FingerprintRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => JSON.stringify(row)).sort();
}

function v2LaunchDataJournalLiquidityState(launchData = {}, journal = {}) {
  const missing = [];
  const mismatches = [];
  const proof = v2ProofFromLaunchData(launchData);
  const launchResults = Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results : [];
  const journalResults = v2JournalLiquidityResults(journal);
  const launchPoolIds = v2SortedTextList([
    ...(Array.isArray(proof?.liquidity?.poolIds) ? proof.liquidity.poolIds : []),
    ...launchResults.map((pool) => pool?.poolId || pool?.id),
  ]);
  const journalPoolIds = v2SortedTextList(journalResults.map((pool) => pool?.poolId || pool?.id));
  const launchPoolCount = v2OptionalReportCount(launchData?.liquidity?.poolCount, launchPoolIds.length);
  if (launchPoolCount > 0) {
    if (journalPoolIds.length <= 0) missing.push('journal pool ids');
    else if (journalPoolIds.length !== launchPoolCount) mismatches.push('pool count');
  }
  if (launchPoolIds.length && !journalPoolIds.length) {
    missing.push('journal pool ids');
  } else if (launchPoolIds.length && journalPoolIds.length && !v2SameTextList(launchPoolIds, journalPoolIds)) {
    mismatches.push('pool ids');
  }

  const launchPoolRows = v2FingerprintRows(v2ProofPoolsForFingerprint(launchResults));
  const journalPoolRows = v2FingerprintRows(v2ProofPoolsForFingerprint(journalResults));
  if (launchPoolRows.length && !journalPoolRows.length) {
    missing.push('journal pool records');
  } else if (launchPoolRows.length && journalPoolRows.length && !v2SameTextList(launchPoolRows, journalPoolRows)) {
    mismatches.push('pool records');
  }

  const launchPositionCount = v2OptionalReportCount(
    launchData?.liquidity?.positionCount,
    v2ProofPositionCount(launchResults),
  );
  const journalPositionCount = v2ProofPositionCount(journalResults);
  if (launchPositionCount > 0) {
    if (journalPositionCount <= 0) missing.push('journal positions');
    else if (journalPositionCount !== launchPositionCount) mismatches.push('position count');
  }
  const launchPositions = v2FingerprintRows(v2ProofPositionsForFingerprint(launchResults));
  const journalPositions = v2FingerprintRows(v2ProofPositionsForFingerprint(journalResults));
  if (launchPositions.length && !journalPositions.length) {
    missing.push('journal position records');
  } else if (launchPositions.length && journalPositions.length && !v2SameTextList(launchPositions, journalPositions)) {
    mismatches.push('position records');
  }

  const launchLockedCount = v2OptionalReportCount(
    launchData?.liquidity?.lockedPositionCount,
    v2ProofLockedPositionCount(launchResults),
  );
  const journalLockedCount = v2ProofLockedPositionCount(journalResults);
  if (launchLockedCount > 0) {
    if (journalLockedCount <= 0) missing.push('journal lock proof');
    else if (journalLockedCount !== launchLockedCount) mismatches.push('lock count');
  }

  const launchFeeKeyCount = v2OptionalReportCount(
    launchData?.liquidity?.feeKeyCount,
    v2ProofFeeKeyCount(launchResults),
  );
  const journalFeeKeyCount = v2ProofFeeKeyCount(journalResults);
  if (launchFeeKeyCount > 0) {
    if (journalFeeKeyCount <= 0) missing.push('journal Fee Key proof');
    else if (journalFeeKeyCount !== launchFeeKeyCount) mismatches.push('Fee Key count');
  }
  const launchFeeKeyRecipients = v2ProofFeeKeyRecipientSummary(launchResults);
  const journalFeeKeyRecipients = v2ProofFeeKeyRecipientSummary(journalResults);
  if (launchFeeKeyRecipients.target > 0) {
    if (journalFeeKeyRecipients.target <= 0) {
      missing.push('journal Fee Key recipients');
    } else if (journalFeeKeyRecipients.target !== launchFeeKeyRecipients.target) {
      mismatches.push('Fee Key recipient count');
    }
    if (launchFeeKeyRecipients.delivered < launchFeeKeyRecipients.target) {
      missing.push('Fee Key recipient delivery proof');
    } else if (journalFeeKeyRecipients.delivered < journalFeeKeyRecipients.target) {
      missing.push('journal Fee Key recipient delivery proof');
    } else if (journalFeeKeyRecipients.delivered !== launchFeeKeyRecipients.delivered) {
      mismatches.push('Fee Key recipient delivery');
    }
  }

  return { missing, mismatches };
}

function v2LaunchDataJournalTokenState(launchData = {}, journal = {}) {
  const missing = [];
  const mismatches = [];
  const authorities = launchData?.token?.authorities && typeof launchData.token.authorities === 'object'
    ? launchData.token.authorities
    : {};
  const journalToken = journal?.token && typeof journal.token === 'object' ? journal.token : {};
  [
    ['mintAuthorityRenounced', 'mint authority'],
    ['freezeAuthorityDisabled', 'freeze authority'],
    ['metadataUpdateAuthorityRevoked', 'metadata update authority'],
    ['metadataImmutable', 'metadata immutability'],
  ].forEach(([field, label]) => {
    if (authorities[field] !== true) return;
    if (typeof journalToken[field] !== 'boolean') {
      missing.push(`journal token authority ${label}`);
      return;
    }
    if (journalToken[field] !== true) mismatches.push(`token authority ${label}`);
  });
  return { missing, mismatches };
}

function v2AirdropReportCount(value, fallbackRows = []) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallbackRows.length;
}

function v2AirdropWalletList(rows = []) {
  return v2SortedTextList((Array.isArray(rows) ? rows : []).map((row) => row?.wallet));
}

function v2AirdropTxList(rows = []) {
  return v2SortedTextList((Array.isArray(rows) ? rows : []).map((row) => row?.txId));
}

function v2LaunchDataJournalAirdropState(launchData = {}, journal = {}) {
  const missing = [];
  const mismatches = [];
  const reportAirdrop = launchData?.airdrop && typeof launchData.airdrop === 'object'
    ? launchData.airdrop
    : {};
  const journalAirdrop = journal?.airdrop && typeof journal.airdrop === 'object'
    ? journal.airdrop
    : {};
  const reportTransferred = v2AirdropRows(reportAirdrop, 'transferred');
  const reportFailedRows = v2AirdropRows(reportAirdrop, 'failed');
  const reportRecipients = v2AirdropRows(reportAirdrop, 'recipients');
  const reportDelivered = v2AirdropReportCount(reportAirdrop.deliveredCount, reportTransferred);
  const reportFailed = v2AirdropReportCount(reportAirdrop.failedCount, reportFailedRows);
  const planned = Math.max(
    v2AirdropReportCount(reportAirdrop.plannedRecipientCount, reportRecipients),
    reportRecipients.length,
    reportDelivered + reportFailed,
  );
  if (planned <= 0) return { missing, mismatches };

  const journalTransferred = v2AirdropRows(journalAirdrop, 'transferred');
  const journalFailedRows = v2AirdropRows(journalAirdrop, 'failed');
  const journalDelivered = journalTransferred.length;
  const journalFailed = journalFailedRows.length;
  if (!journalDelivered && !journalFailed) {
    missing.push('journal airdrop');
    return { missing, mismatches };
  }
  if (reportDelivered !== journalDelivered || reportFailed !== journalFailed) {
    mismatches.push('airdrop counts');
  }

  const reportWallets = v2AirdropWalletList(reportTransferred);
  const journalWallets = v2AirdropWalletList(journalTransferred);
  if (reportWallets.length && !journalWallets.length) {
    missing.push('journal airdrop recipients');
  } else if (reportWallets.length && journalWallets.length && !v2SameTextList(reportWallets, journalWallets)) {
    mismatches.push('airdrop recipients');
  }

  const reportTxs = v2AirdropTxList(reportTransferred);
  const journalTxs = v2AirdropTxList(journalTransferred);
  if (reportTxs.length && !journalTxs.length) {
    missing.push('journal airdrop transactions');
  } else if (reportTxs.length && journalTxs.length && !v2SameTextList(reportTxs, journalTxs)) {
    mismatches.push('airdrop transactions');
  }

  return { missing, mismatches };
}

function v2LaunchDataJournalState(launchData = {}, journal = null, walletPublicKey = null) {
  const missing = [];
  const mismatches = [];
  const requestWallet = v2TrimmedText(walletPublicKey);
  const launchWallet = v2TrimmedText(launchData.launchWallet || launchData.walletPublicKey);
  const reportJournalId = v2TrimmedText(launchData.journalId || launchData?.recoveryAudit?.journalId);
  const tokenMint = v2TrimmedText(launchData?.token?.mint || launchData.mint);

  if (!requestWallet) missing.push('wallet public key');
  if (!launchWallet) missing.push('launch wallet');
  if (!reportJournalId) missing.push('journal id');
  if (!journal || typeof journal !== 'object') {
    missing.push('launch journal');
    return { backed: false, missing, mismatches };
  }

  const journalWallet = v2TrimmedText(journal.walletPublicKey);
  const journalId = v2TrimmedText(journal.id);
  const journalMint = v2TrimmedText(journal?.token?.mint || journal?.token?.tokenMint);
  const journalPools = Array.isArray(journal?.poolPlan?.allocations)
    ? journal.poolPlan.allocations
    : [];
  const launchTransfer = launchData?.transfer && typeof launchData.transfer === 'object'
    ? launchData.transfer
    : null;
  const journalTransfer = journal?.transfer && typeof journal.transfer === 'object'
    ? journal.transfer
    : null;
  const launchTransferTerminal = v2TransferHasWalletEmptyFinalSweepEvidence(launchTransfer);
  const launchTransferDestination = v2TrimmedText(launchTransfer?.destinationWallet);
  const journalTransferDestination = v2TrimmedText(journalTransfer?.destinationWallet);

  if (!journalWallet) missing.push('journal wallet');
  if (!journalId) missing.push('journal id');
  if (!journalMint) missing.push('journal token');
  if (journalPools.length <= 0) missing.push('journal pool plan');

  if (requestWallet && journalWallet && requestWallet !== journalWallet) mismatches.push('request wallet');
  if (launchWallet && journalWallet && launchWallet !== journalWallet) mismatches.push('launch wallet');
  if (reportJournalId && journalId && reportJournalId !== journalId) mismatches.push('journal id');
  if (tokenMint && journalMint && tokenMint !== journalMint) mismatches.push('journal token mint');
  const tokenBinding = v2LaunchDataJournalTokenState(launchData, journal);
  missing.push(...tokenBinding.missing);
  mismatches.push(...tokenBinding.mismatches);
  const liquidityBinding = v2LaunchDataJournalLiquidityState(launchData, journal);
  missing.push(...liquidityBinding.missing);
  mismatches.push(...liquidityBinding.mismatches);
  const airdropBinding = v2LaunchDataJournalAirdropState(launchData, journal);
  missing.push(...airdropBinding.missing);
  mismatches.push(...airdropBinding.mismatches);
  if (launchTransferTerminal) {
    if (!journalTransfer) {
      missing.push('journal sweep transfer');
    } else if (!v2TransferHasWalletEmptyFinalSweepEvidence(journalTransfer)) {
      missing.push('terminal journal sweep');
    } else if (
      launchTransferDestination
      && journalTransferDestination
      && launchTransferDestination !== journalTransferDestination
    ) {
      mismatches.push('sweep destination');
    } else {
      const launchTransferHash = v2TransferEvidenceHash(launchTransfer);
      const journalTransferHash = v2TransferEvidenceHash(journalTransfer);
      if (!journalTransferHash) {
        missing.push('journal sweep evidence hash');
      } else if (launchTransferHash !== journalTransferHash) {
        mismatches.push('sweep evidence hash');
      }
    }
  }

  return {
    backed: missing.length === 0 && mismatches.length === 0,
    missing,
    mismatches,
  };
}

function v2ReportNumbersMatch(a, b) {
  if (a == null || a === '' || b == null || b === '') return true;
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return v2TrimmedText(a) === v2TrimmedText(b);
  return Math.abs(left - right) < 1e-9;
}

function v2ReportRequiredNumbersMatch(a, b) {
  if (a == null || a === '' || b == null || b === '') return false;
  return v2ReportNumbersMatch(a, b);
}

function v2ReportTextMatches(a, b) {
  const left = v2TrimmedText(a);
  const right = v2TrimmedText(b);
  if (!left || !right) return true;
  return left === right;
}

function v2ReportRequiredTextMatches(a, b) {
  const left = v2TrimmedText(a);
  const right = v2TrimmedText(b);
  return Boolean(left && right && left === right);
}

function v2ReportTextMatchesWhenSnapshotPresent(a, b) {
  return v2TrimmedText(a) ? v2ReportRequiredTextMatches(a, b) : true;
}

function v2ReportNumbersMatchWhenSnapshotPresent(a, b) {
  return a == null || a === '' ? true : v2ReportRequiredNumbersMatch(a, b);
}

function v2ReportPoolRowsMatch(snapshotPool = {}, reportPool = {}, { requireReportFields = false } = {}) {
  const textMatch = requireReportFields ? v2ReportRequiredTextMatches : v2ReportTextMatches;
  const numberMatch = requireReportFields ? v2ReportRequiredNumbersMatch : v2ReportNumbersMatch;
  return textMatch(snapshotPool.quoteToken || snapshotPool.quoteSymbol, reportPool.quoteToken || reportPool.quoteSymbol || reportPool.quote)
    && v2ReportTextMatchesWhenSnapshotPresent(snapshotPool.quoteMint, reportPool.quoteMint)
    && numberMatch(snapshotPool.supplyPercent, reportPool.supplyPercent)
    && v2ReportNumbersMatchWhenSnapshotPresent(snapshotPool.ammConfigIndex, reportPool.ammConfigIndex);
}

function v2ReportTextMatchesForStrictness(a, b, requireFields = false) {
  return requireFields ? v2ReportRequiredTextMatches(a, b) : v2ReportTextMatches(a, b);
}

function v2ReportNumbersMatchForStrictness(a, b, requireFields = false) {
  return requireFields ? v2ReportRequiredNumbersMatch(a, b) : v2ReportNumbersMatch(a, b);
}

function v2LaunchDataConfigConsistencyState(launchData = {}, journal = null, options = {}) {
  const requireJournalFields = options?.requireJournalFields === true;
  const launchConfig = launchData?.launchConfig && typeof launchData.launchConfig === 'object'
    ? launchData.launchConfig
    : null;
  if (!launchConfig) return { consistent: false, mismatches: ['snapshot'] };
  const token = launchConfig.token && typeof launchConfig.token === 'object' ? launchConfig.token : {};
  const topology = launchConfig.poolTopology && typeof launchConfig.poolTopology === 'object' ? launchConfig.poolTopology : {};
  const mismatches = [];

  if (!v2ReportRequiredTextMatches(token.name, launchData.name)) mismatches.push('token name');
  if (!v2ReportRequiredTextMatches(token.symbol, launchData.symbol)) mismatches.push('token symbol');
  if (!v2ReportRequiredNumbersMatch(token.supply, launchData.totalSupply)) mismatches.push('token supply');
  if (!v2ReportRequiredNumbersMatch(token.decimals, launchData.decimals)) mismatches.push('token decimals');

  const snapshotPools = Array.isArray(topology.pools) ? topology.pools : [];
  const reportPools = Array.isArray(launchData.plannedPools) ? launchData.plannedPools : [];
  if (snapshotPools.length !== reportPools.length) {
    mismatches.push('planned pool count');
  } else {
    snapshotPools.forEach((pool, index) => {
      if (!v2ReportPoolRowsMatch(pool, reportPools[index], { requireReportFields: true })) {
        mismatches.push(`planned pool ${index + 1}`);
      }
    });
  }

  const journalToken = journal?.token && typeof journal.token === 'object' ? journal.token : null;
  const journalPoolPlan = journal?.poolPlan && typeof journal.poolPlan === 'object'
    ? journal.poolPlan
    : {};
  if (journalToken) {
    const journalSupply = journalToken.totalSupply ?? journalToken.supply ?? journalPoolPlan.tokenTotalSupply;
    const journalDecimals = journalToken.decimals ?? journalPoolPlan.tokenDecimals;
    if (!v2ReportTextMatchesForStrictness(token.name, journalToken.name, requireJournalFields)) mismatches.push('journal token name');
    if (!v2ReportTextMatchesForStrictness(token.symbol, journalToken.symbol, requireJournalFields)) mismatches.push('journal token symbol');
    if (!v2ReportNumbersMatchForStrictness(token.supply, journalSupply, requireJournalFields)) mismatches.push('journal token supply');
    if (!v2ReportNumbersMatchForStrictness(token.decimals, journalDecimals, requireJournalFields)) mismatches.push('journal token decimals');
  } else if (requireJournalFields) {
    mismatches.push('journal token');
  }

  const journalPools = Array.isArray(journalPoolPlan.allocations) ? journalPoolPlan.allocations : [];
  if (journalPools.length > 0) {
    if (snapshotPools.length !== journalPools.length) {
      mismatches.push('journal planned pool count');
    } else {
      snapshotPools.forEach((pool, index) => {
        if (!v2ReportPoolRowsMatch(pool, journalPools[index], { requireReportFields: requireJournalFields })) {
          mismatches.push(`journal planned pool ${index + 1}`);
        }
      });
    }
  }

  return {
    consistent: mismatches.length === 0,
    mismatches,
  };
}

function v2LaunchDataPositionRows(launchData = {}) {
  const pools = Array.isArray(launchData?.pools) ? launchData.pools : [];
  return pools.flatMap((pool) => {
    const positions = Array.isArray(pool?.positions) ? pool.positions : [];
    return positions.map((position = {}) => ({
      ...position,
      poolId: position.poolId || pool?.poolId || pool?.id || null,
      positionNftMint: position.positionNftMint || position.nftMint || position.positionMint || null,
      feeKeyNftMint: position.feeKeyNftMint || position.feeKeyMint || null,
      openTx: position.openTx || position.txIds?.open || null,
      lockTx: position.lockTx || position.txIds?.lock || null,
      transferTx: position.transferTx || position.txIds?.transfer || null,
    }));
  });
}

function v2ReportCount(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function v2OptionalReportCount(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  return v2ReportCount(value, fallback);
}

function v2ReportCountIsExplicit(value) {
  return value !== undefined && value !== null && value !== '';
}

function v2AirdropRows(airdrop = {}, key) {
  return Array.isArray(airdrop?.[key])
    ? airdrop[key].map(v2NormalizeAirdropEntry).filter((row) => row.wallet)
    : [];
}

function v2AirdropHasHashOnlyRows(airdrop = {}, key) {
  const rows = Array.isArray(airdrop?.[key]) ? airdrop[key] : [];
  const hash = typeof airdrop?.[`${key}Hash`] === 'string' ? airdrop[`${key}Hash`].trim() : '';
  return Boolean(hash && rows.length === 0);
}

function v2AirdropDeliveryEvidenceState(airdrop = {}) {
  const planned = v2ReportCount(airdrop.plannedRecipientCount, 0);
  const transferredRows = v2AirdropRows(airdrop, 'transferred');
  const failedRows = v2AirdropRows(airdrop, 'failed');
  const recipientRows = v2AirdropRows(airdrop, 'recipients');
  const delivered = v2ReportCount(airdrop.deliveredCount, transferredRows.length);
  const failed = v2ReportCount(airdrop.failedCount, failedRows.length);
  const required = planned > 0 || delivered > 0 || failed > 0;
  const expectedCount = Math.max(planned, delivered);
  const recipientWallets = new Set([
    ...recipientRows,
    ...transferredRows,
    ...failedRows,
  ].map((row) => row.wallet).filter(Boolean));
  const deliveredWallets = new Set(transferredRows.map((row) => row.wallet).filter(Boolean));
  const transactionCount = transferredRows.filter((row) => v2TrimmedText(row.txId)).length;
  const missing = [];

  if (required) {
    if (failed > 0 || failedRows.length > 0) missing.push('zero failed recipients');
    if (recipientWallets.size < expectedCount) missing.push('airdrop recipient rows');
    if (deliveredWallets.size < expectedCount || transferredRows.length < expectedCount) missing.push('airdrop delivered rows');
    if (delivered < expectedCount) missing.push('airdrop delivered count');
    if (transactionCount < expectedCount) missing.push('airdrop transaction signatures');
    if (
      (planned > 0 && v2AirdropHasHashOnlyRows(airdrop, 'recipients'))
      || (delivered > 0 && v2AirdropHasHashOnlyRows(airdrop, 'transferred'))
      || (failed > 0 && v2AirdropHasHashOnlyRows(airdrop, 'failed'))
    ) {
      missing.push('full airdrop rows');
    }
  }

  return {
    required,
    planned,
    delivered,
    failed,
    pending: Math.max(0, planned - delivered - failed),
    complete: !required || missing.length === 0,
    retryRequired: failed > 0,
    recipientCount: recipientWallets.size,
    deliveredRowCount: transferredRows.length,
    transactionCount,
    missing,
  };
}

function v2LaunchDataReportCompletenessState(launchData = {}) {
  const missing = [];
  const addMissing = (value) => {
    if (!missing.includes(value)) missing.push(value);
  };
  const launchWallet = v2TrimmedText(launchData.launchWallet || launchData.walletPublicKey);
  const tokenMint = v2TrimmedText(launchData?.token?.mint || launchData.mint);
  const authorities = launchData?.token?.authorities && typeof launchData.token.authorities === 'object'
    ? launchData.token.authorities
    : {};
  const authorityFields = [
    'mintAuthorityRenounced',
    'freezeAuthorityDisabled',
    'metadataUpdateAuthorityRevoked',
    'metadataImmutable',
  ];
  const plannedPools = Array.isArray(launchData.plannedPools) ? launchData.plannedPools : [];
  const pools = Array.isArray(launchData.pools) ? launchData.pools : [];
  const liquidity = launchData?.liquidity && typeof launchData.liquidity === 'object'
    ? launchData.liquidity
    : {};
  const plannedPositionCount = plannedPools.reduce((sum, pool) => (
    sum + v2ReportCount(pool?.plannedPositionCount, 0)
  ), 0);
  const positions = v2LaunchDataPositionRows(launchData);
  const poolCount = v2OptionalReportCount(liquidity.poolCount, pools.length);
  const reportedPositionCount = v2OptionalReportCount(liquidity.positionCount, positions.length);
  const recordedPositionCount = Math.max(reportedPositionCount, positions.length);
  const lockedRowCount = positions.filter((position) => position?.locked === true).length;
  const lockedPositionCount = v2ReportCount(
    liquidity.lockedPositionCount,
    lockedRowCount,
  );
  const feeKeyRowCount = positions.filter((position) => v2TrimmedText(position?.feeKeyNftMint)).length;
  const feeKeyCount = v2ReportCount(
    liquidity.feeKeyCount,
    feeKeyRowCount,
  );
  const missingAuthorityFields = authorityFields.filter((field) => authorities[field] !== true);
  if (launchData?.token?.mintFormat === 'token-2022'
      && authorities.metadataPointerAuthorityRevoked !== true) {
    missingAuthorityFields.push('metadataPointerAuthorityRevoked');
  }
  const poolRowsMissingCreateProof = pools.filter((pool) => (
    !v2TrimmedText(pool?.poolId || pool?.id)
    || !v2TrimmedText(pool?.createPoolTx || pool?.txIds?.createPool)
  ));
  const positionRowsMissingOpenProof = positions.filter((position) => (
    !v2TrimmedText(position?.poolId)
    || !v2TrimmedText(position?.positionNftMint)
    || !v2TrimmedText(position?.openTx)
  ));
  const lockedRowsMissingProof = positions.filter((position) => (
    position?.locked !== true
    || !v2TrimmedText(position?.lockTx)
  ));
  const feeKeyRowsMissingProof = positions.filter((position) => (
    !v2TrimmedText(position?.feeKeyNftMint)
  ));
  const recipientRowsMissingTransfer = positions.filter((position) => (
    v2TrimmedText(position?.recipient)
    && (
      v2TrimmedText(position?.transferredTo) !== v2TrimmedText(position?.recipient)
      || !v2TrimmedText(position?.transferTx)
    )
  ));
  const airdropEvidence = v2AirdropDeliveryEvidenceState(launchData?.airdrop || {});

  if (!launchWallet) addMissing('launch wallet');
  if (!tokenMint) addMissing('token mint');
  if (missingAuthorityFields.length) addMissing('authority proof');
  if (plannedPools.length <= 0) addMissing('planned pools');
  if (pools.length <= 0) addMissing('pool proof');
  if (plannedPools.length > 0 && pools.length !== plannedPools.length) addMissing('pool count');
  if (v2ReportCountIsExplicit(liquidity.poolCount) && poolCount !== pools.length) addMissing('pool count');
  if (poolRowsMissingCreateProof.length) addMissing('pool create proof');
  if (plannedPositionCount <= 0) addMissing('planned position count');
  if (plannedPositionCount > 0 && recordedPositionCount < plannedPositionCount) addMissing('position count');
  if (v2ReportCountIsExplicit(liquidity.positionCount) && reportedPositionCount !== positions.length) addMissing('position count');
  if (positions.length < recordedPositionCount) addMissing('position records');
  if (positionRowsMissingOpenProof.length) addMissing('position open proof');
  if (recordedPositionCount > 0 && lockedPositionCount < recordedPositionCount) addMissing('lock count');
  if (v2ReportCountIsExplicit(liquidity.lockedPositionCount) && lockedPositionCount !== lockedRowCount) addMissing('lock count');
  if (recordedPositionCount > 0 && lockedRowsMissingProof.length) addMissing('lock proof');
  if (lockedPositionCount > 0 && feeKeyCount < lockedPositionCount) addMissing('fee key count');
  if (v2ReportCountIsExplicit(liquidity.feeKeyCount) && feeKeyCount !== feeKeyRowCount) addMissing('fee key count');
  if (lockedPositionCount > 0 && feeKeyRowsMissingProof.length) addMissing('fee key proof');
  if (recipientRowsMissingTransfer.length) addMissing('fee key recipient transfer proof');
  airdropEvidence.missing.forEach(addMissing);

  return {
    complete: missing.length === 0,
    missing,
  };
}

function v2AirdropCompletionStatus(proof = {}) {
  const airdrop = proof?.airdrop || {};
  return v2AirdropDeliveryEvidenceState({
    ...airdrop,
    plannedRecipientCount: v2OptionalReportCount(
      airdrop.plannedRecipientCount,
      Array.isArray(airdrop.recipients) ? airdrop.recipients.length : 0,
    ),
  });
}

function v2LaunchDataAirdropCompletionStatus(launchData = {}) {
  const airdrop = launchData?.airdrop || {};
  const audit = launchData?.airdropAudit || {};
  return v2AirdropDeliveryEvidenceState({
    ...airdrop,
    plannedRecipientCount: v2OptionalReportCount(
      airdrop.plannedRecipientCount,
      v2OptionalReportCount(
        audit.plannedRecipientCount,
        Array.isArray(airdrop.recipients) ? airdrop.recipients.length : 0,
      ),
    ),
    deliveredCount: v2OptionalReportCount(
      airdrop.deliveredCount,
      v2OptionalReportCount(
        audit.deliveredCount,
        Array.isArray(airdrop.transferred) ? airdrop.transferred.length : 0,
      ),
    ),
    failedCount: v2OptionalReportCount(
      airdrop.failedCount,
      v2OptionalReportCount(
        audit.failedCount,
        Array.isArray(airdrop.failed) ? airdrop.failed.length : 0,
      ),
    ),
  });
}

function v2LocalDossierFilenameMatchesKind(filename, kind) {
  const normalized = String(filename || '').trim().toLowerCase();
  if (kind === 'local-proof-json') return normalized.endsWith('.json');
  if (kind === 'local-dossier-html') return normalized.endsWith('.html');
  return false;
}

function v2LocalDossierFinalizationIssue(dossier = null, proof = {}) {
  if (!dossier || typeof dossier !== 'object') return 'missing';
  const kind = String(dossier.kind || '').trim();
  const filename = String(dossier.filename || '').trim();
  const downloadedAt = String(dossier.downloadedAt || '').trim();
  const dataVersion = Number(dossier.dataVersion);
  const proofFingerprint = String(dossier.proofFingerprint || '').trim();
  if (dossier.status !== 'downloaded') return 'not downloaded';
  if (!['local-dossier-html', 'local-proof-json'].includes(kind)) return 'unknown artifact kind';
  if (!filename || !v2LocalDossierFilenameMatchesKind(filename, kind)) return 'filename does not match artifact kind';
  if (!downloadedAt) return 'download timestamp missing';
  if (!Number.isInteger(dataVersion) || dataVersion <= 0) return 'data version missing';
  if (!proofFingerprint) return 'proof fingerprint missing';
  if (proofFingerprint !== v2LaunchProofFingerprint(proof)) return 'proof fingerprint mismatch';
  const proofMint = String(proof?.token?.mint || '').trim();
  const dossierMint = String(dossier.mint || '').trim();
  if (proofMint && !dossierMint) return 'token mint missing';
  if (proofMint && dossierMint !== proofMint) return 'token mint mismatch';
  const terminalSweepHash = v2TransferHasWalletEmptyFinalSweepEvidence(proof?.transfer)
    ? v2TransferEvidenceHash(proof.transfer)
    : null;
  if (terminalSweepHash) {
    const dossierSweepHash = String(
      dossier.sweepEvidenceHash
      || dossier.transferEvidenceHash
      || dossier.finalSweep?.transferEvidenceHash
      || '',
    ).trim();
    if (dossierSweepHash !== terminalSweepHash) return 'terminal sweep evidence hash mismatch';
  }
  return null;
}

function v2ReportPublishUri(report = null) {
  return String(report?.jsonUri || report?.htmlUri || '').trim();
}

function v2ReportPublishUriHasPermanentScheme(uri = '') {
  const value = String(uri || '').trim();
  return Boolean(
    /^https?:\/\//i.test(value)
      || /^ar:\/\//i.test(value)
      || /^ipfs:\/\//i.test(value)
  );
}

function v2ReportPublishHasPermanentEvidence(report = null) {
  if (!report || typeof report !== 'object') return false;
  const uri = v2ReportPublishUri(report);
  const dataVersion = Number(report.dataVersion);
  const generatedMetadata = Boolean(
    report.status === 'done'
      || report.alreadyPublished === true
      || String(report.publishedAt || '').trim()
      || (Number.isInteger(dataVersion) && dataVersion > 0)
  );
  return Boolean(uri && v2ReportPublishUriHasPermanentScheme(uri) && generatedMetadata);
}

function v2ReportPublishFinalizationIssue(report = null, proof = {}) {
  if (!report || typeof report !== 'object') return 'missing';
  const uri = v2ReportPublishUri(report);
  if (!uri) return 'permanent URI missing';
  if (!v2ReportPublishUriHasPermanentScheme(uri)) return 'unsupported report URI';
  if (!v2ReportPublishHasPermanentEvidence(report)) return 'publish metadata missing';
  const reportFingerprint = String(report.proofFingerprint || '').trim();
  if (!reportFingerprint || reportFingerprint !== v2LaunchProofFingerprint(proof)) return 'proof fingerprint mismatch';
  const proofMint = String(proof?.token?.mint || '').trim();
  const reportMint = String(report.mint || '').trim();
  if (proofMint && !reportMint) return 'token mint missing';
  if (proofMint && reportMint !== proofMint) return 'token mint mismatch';
  const terminalSweepHash = v2TransferHasWalletEmptyFinalSweepEvidence(proof?.transfer)
    ? v2TransferEvidenceHash(proof.transfer)
    : null;
  const reportSweepHash = String(
    report.sweepEvidenceHash
    || report.transferEvidenceHash
    || report.finalSweep?.transferEvidenceHash
    || '',
  ).trim();
  if (terminalSweepHash && reportSweepHash !== terminalSweepHash) {
    return 'terminal sweep evidence hash mismatch';
  }
  return null;
}

function v2TransferFinalizationIssue(readiness = {}, evidence = {}) {
  if (readiness?.nextEndpoint !== '/api/transfer-assets') return null;
  const proof = readiness.proof || null;
  const airdropStatus = v2AirdropCompletionStatus(proof);
  if (airdropStatus.retryRequired) {
    return `Airdrop has ${airdropStatus.failed} failed recipient${airdropStatus.failed === 1 ? '' : 's'}; retry before final sweep.`;
  }
  if (airdropStatus.pending > 0) {
    return `${airdropStatus.pending} airdrop recipient${airdropStatus.pending === 1 ? '' : 's'} still pending; run airdrop before final sweep.`;
  }
  if (!airdropStatus.complete) {
    const missing = Array.isArray(airdropStatus.missing)
      ? airdropStatus.missing.filter(Boolean)
      : [];
    return missing.length
      ? `Airdrop proof is incomplete (${missing.join(', ')}); refresh or rerun airdrop before final sweep.`
      : 'Airdrop proof is incomplete; refresh or rerun airdrop before final sweep.';
  }
  if (!proof) return 'Refresh readiness so Trebuchet can verify the launch proof before final sweep.';

  const report = proof.reportPublish || null;
  const reportUri = v2ReportPublishUri(report);
  const localDossier = evidence?.localDossier || proof?.localDossier || null;
  const localDossierIssue = localDossier
    ? v2LocalDossierFinalizationIssue(localDossier, proof)
    : null;
  const localDossierCurrent = Boolean(localDossier && !localDossierIssue);

  if (!reportUri && localDossierIssue) {
    return `Local dossier proof is stale or incomplete (${localDossierIssue}); download a fresh dossier before final sweep.`;
  }
  if (reportUri) {
    const reportIssue = v2ReportPublishFinalizationIssue(report, proof);
    if (reportIssue === 'terminal sweep evidence hash mismatch') {
      return 'Launch report is missing terminal sweep evidence; republish before final sweep.';
    }
    if (reportIssue === 'token mint missing' || reportIssue === 'token mint mismatch') {
      return 'Launch report is not bound to this token mint; republish before final sweep.';
    }
    if (reportIssue) {
      return 'Launch report is stale for this proof; republish before final sweep.';
    }
  }
  if (userPrefs.get().publishLaunchReport === false && !reportUri && !localDossierCurrent) {
    return 'Report publishing is off; attach the local dossier before final sweep.';
  }
  if (!reportUri && !localDossierCurrent) {
    return proof.canPublishReport
      ? 'Publish or attach the launch report before final sweep.'
      : 'Attach the local dossier before final sweep.';
  }
  return null;
}

async function v2FundingBalanceContext(walletPublicKey, { requireFundingBalance = false } = {}) {
  if (!requireFundingBalance || isDemoMode() || !walletPublicKey) {
    return { requireFundingBalance: false };
  }
  try {
    return {
      requireFundingBalance: true,
      walletBalance: await checkWalletBalanceMultiToken(walletPublicKey),
    };
  } catch (error) {
    return {
      requireFundingBalance: true,
      walletBalanceError: launchJournal.errorMessage(error),
    };
  }
}

async function v2ReadinessForManagedWallet({
  walletPublicKey,
  config,
  body = {},
  requireFundingBalance = false,
}) {
  if (walletPublicKey) new PublicKey(walletPublicKey);
  const wallet = walletPublicKey ? pendingWallets.get(walletPublicKey) : null;
  const context = v2ExecutionContextFromJournal(walletPublicKey, body);
  const fundingBalanceContext = await v2FundingBalanceContext(walletPublicKey, {
    requireFundingBalance,
  });
  const readiness = buildV2ExecutionReadiness(config || {}, {
    demoMode: isDemoMode(),
    walletPublicKey,
    walletAvailable: Boolean(wallet),
    secretAvailable: Array.isArray(wallet?.secretKey),
    secretPinLocked: secretStore.isSecretPinLocked(),
    rpc: { activeUrl: getRpcConfig().active },
    requireCurrentFundingEstimate: true,
    ...context,
    ...fundingBalanceContext,
    fundingEstimate: body.fundingEstimate,
    airdrop: body.airdrop,
    airdropRecipients: body.airdropRecipients,
  });
  readiness.proof = v2ExecutionProofFromContext(context, readiness);
  return { wallet, context, readiness };
}

async function v2WalletBalanceObservation(walletPublicKey) {
  if (!walletPublicKey) return null;
  const capturedAt = new Date().toISOString();
  try {
    const balance = await checkWalletBalanceMultiToken(walletPublicKey);
    const sol = Number(balance?.sol);
    return {
      ok: true,
      capturedAt,
      sol: Number.isFinite(sol) ? sol : null,
      tokenMintCount: Object.keys(balance?.tokens || {}).length,
    };
  } catch (error) {
    return {
      ok: false,
      capturedAt,
      error: launchJournal.errorMessage(error),
    };
  }
}

function v2ObservedWalletDelta(before, after) {
  const beforeSol = Number(before?.sol);
  const afterSol = Number(after?.sol);
  const observed = {
    before,
    after,
    note:
      'Launch-wallet SOL balance delta observed around the guarded classic call. ' +
      'It can include swaps, pool deposits, sweeps, rent, refunds, and network fees.',
  };
  if (before?.ok === true && after?.ok === true && Number.isFinite(beforeSol) && Number.isFinite(afterSol)) {
    const deltaSol = afterSol - beforeSol;
    observed.beforeSol = beforeSol;
    observed.afterSol = afterSol;
    observed.deltaSol = deltaSol;
    observed.outflowSol = deltaSol < 0 ? Math.abs(deltaSol) : 0;
    observed.inflowSol = deltaSol > 0 ? deltaSol : 0;
  }
  if (before?.ok === false || after?.ok === false) {
    observed.error = after?.error || before?.error || 'Could not observe wallet balance delta';
  }
  return observed;
}

async function runV2ClassicLpPreflight(payload = {}) {
  try {
    return await preflightCreatePoolsAndPositions({
      tokenTotalSupply: payload.tokenTotalSupply,
      targetMarketCapUsd: payload.targetMarketCapUsd,
      allocations: payload.allocations,
    });
  } catch (error) {
    const message = launchJournal.errorMessage(error);
    const wrapped = new Error(message);
    wrapped.statusCode = 400;
    wrapped.code = 'V2_LP_PREFLIGHT_FAILED';
    wrapped.failedPhase = error.failedPhase || 'pre_flight';
    wrapped.failedAllocationIndex = error.failedAllocationIndex ?? null;
    wrapped.failedAllocation = error.failedAllocation ?? null;
    wrapped.probeCode = error.probeCode || null;
    wrapped.errorDetails = launchFailureDetails(error, {
      route: 'v2-execute-next-preflight-create-lp',
      failedPhase: wrapped.failedPhase,
      failedAllocationIndex: wrapped.failedAllocationIndex,
    });
    throw wrapped;
  }
}

const launchServices = createLaunchExecutionServices({
  PublicKey,
  airdropInFlight,
  airdropProgressBegin,
  airdropProgressEnd,
  airdropProgressStep,
  checkWalletBalanceMultiToken,
  claimLaunchOp,
  clearAirdropInFlight,
  clearLaunchOpInFlight,
  createPoolsAndPositions,
  createTokenWithMetaplex,
  executeAirdrop,
  findFundingWallet,
  finishSweepWithSolGate,
  finishTokenCreation,
  isWalletEffectivelyEmpty,
  launchFailureDetails,
  launchJournal,
  logoBase64FromCreateTokenInput,
  lpProgressBegin,
  lpProgressEnd,
  lpProgressEvent,
  markAirdropInFlight,
  materializePhase1RecoveryResults,
  mergePriorResults,
  normalizeMintFormat,
  normalizeTokenDescription,
  normalizeTokenName,
  normalizeTokenSymbol,
  normalizeVanityTargetBase58,
  normalizeWholeTokenSupply,
  pendingWallets,
  recordLpJournalProgress,
  recordTokenJournalProgress,
  reconcileWalletOperation,
  reconcileMetadataReveal: (input) => requireWalletExecution().recoverMetadataReveal(input),
  getTransferReceipts: (wallet) => requireWalletExecution().getTransferReceipts(wallet),
  registerOfficialBrandLaunch,
  requireSecretPinUnlocked,
  requireTokenCompleteForLiquidity,
  resolveSigner,
  revealSealedMetadataAfterLiquidity,
  revealSealedMetadataForJournal,
  sweepAllTokensToDestination,
  sweepNftsToDestination,
  sweepSolToDestination,
  transferJournalSummary,
  transferMetadataAuthority,
  unsafeSweepDestinationReason,
  unverifiedDestinationReason,
  validateTransferAirdropPayload,
  vanityAvailability,
  vanityCaStore,
});

async function serveLaunchOperation(res, execute) {
  try { return res.json(await execute()); }
  catch (error) { sendErrorResponse(res, error); }
}

async function executeV2NextClassicOperation(readiness) {
  const endpoint = readiness?.nextEndpoint;
  if (endpoint === '/api/create-token') {
    return launchServices.createToken(readiness.classicPayloads.createToken);
  }
  if (endpoint === '/api/finish-token-creation') {
    return launchServices.finishToken(readiness.classicPayloads.finishToken);
  }
  if (endpoint === '/api/create-lp') {
    const preflight = await runV2ClassicLpPreflight(readiness.classicPayloads.preflightCreateLp);
    const result = await launchServices.createLiquidity(readiness.classicPayloads.createLp);
    return {
      ...result,
      v2Preflight: preflight,
    };
  }
  if (endpoint === '/api/resume-launch') {
    return launchServices.resumeLiquidity(readiness.classicPayloads.resumeLaunch);
  }
  if (endpoint === '/api/reveal-sealed-metadata') {
    return launchServices.revealMetadata(readiness.classicPayloads.revealMetadata);
  }
  if (endpoint === '/api/transfer-assets') {
    return launchServices.transferAssets(readiness.classicPayloads.transferAssets);
  }
  const error = new Error('No executable classic endpoint is ready');
  error.statusCode = 409;
  throw error;
}

app.post('/api/v2/demo-launch/run', async (req, res) => {
  if (!isDemoMode()) {
    return res.status(403).json({
      success: false,
      error: 'Demo launch runs are only available when demo mode is active',
    });
  }

  try {
    const config = req.body?.config || {};
    const walletPublicKey = String(req.body?.walletPublicKey || config.walletPublicKey || '').trim();
    if (!walletPublicKey) {
      return res.status(400).json({ success: false, error: 'walletPublicKey required' });
    }
    new PublicKey(walletPublicKey);
    const wallet = demoManagedWallets.get(walletPublicKey);
    if (!wallet || !Array.isArray(wallet.secretKey)) {
      return res.status(404).json({
        success: false,
        error: 'Demo launch wallet secret is unavailable; generate or import a v2 demo wallet first',
      });
    }

    const readiness = buildV2ExecutionReadiness(config, {
      demoMode: true,
      walletPublicKey,
      walletAvailable: true,
      secretAvailable: true,
      fundingEstimate: req.body?.fundingEstimate,
      airdrop: req.body?.airdrop,
      airdropRecipients: req.body?.airdropRecipients,
    });
    if (readiness.blockers.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'Demo launch is blocked',
        readiness,
      });
    }

    const tempWalletSecretKey = wallet.secretKey;
    const tokenResult = await invokeJsonHandler(demoChainService.handleCreateToken, {
      tempWalletSecretKey,
      ...readiness.classicPayloads.createToken,
    });
    const tokenMint = tokenResult.tokenMint;
    const tokenDecimals = tokenResult.decimals ?? readiness.plan.token.decimals;
    const tokenTotalSupply = String(tokenResult.totalSupply ?? readiness.plan.token.supply);
    const lpReadiness = buildV2ExecutionReadiness(config, {
      demoMode: true,
      walletPublicKey,
      walletAvailable: true,
      secretAvailable: true,
      tokenMint,
      fundingEstimate: req.body?.fundingEstimate,
      airdrop: req.body?.airdrop,
      airdropRecipients: req.body?.airdropRecipients,
    });
    if (lpReadiness.blockers.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'Demo launch LP is blocked',
        readiness: lpReadiness,
      });
    }
    const createLpPayload = {
      ...lpReadiness.classicPayloads.createLp,
      tempWalletSecretKey,
      tokenMint,
      tokenDecimals,
      tokenTotalSupply,
      allocations: demoAllocationsForV2(lpReadiness.classicPayloads.createLp.allocations),
      airdrop: lpReadiness.classicPayloads.createLp.airdrop
        ? {
          ...lpReadiness.classicPayloads.createLp.airdrop,
          tokenMint,
          tokenDecimals,
        }
        : null,
    };
    const lpResult = await invokeJsonHandler(demoChainService.handleCreateLp, createLpPayload);
    const sweepDestination = lpReadiness.plan.poolTopology.sweepDestination || walletPublicKey;
    const transferPayload = {
      ...lpReadiness.classicPayloads.transferAssets,
      tempWalletSecretKey,
      destinationWallet: sweepDestination,
      tokenMint,
      tokenDecimals,
      airdrop: createLpPayload.airdrop,
    };
    const transferResult = await invokeJsonHandler(
      demoChainService.handleTransferAssets,
      transferPayload,
      {
        airdropProgress: {
          begin: airdropProgressBegin,
          step: airdropProgressStep,
          end: airdropProgressEnd,
        },
      },
    );
    const completedReadiness = buildV2ExecutionReadiness(config, {
      demoMode: true,
      walletPublicKey,
      walletAvailable: true,
      secretAvailable: true,
      tokenMint,
      liquidityComplete: true,
      transfer: transferResult,
      fundingEstimate: req.body?.fundingEstimate,
      airdrop: req.body?.airdrop,
      airdropRecipients: req.body?.airdropRecipients,
    });
    const runId = crypto
      .createHash('sha256')
      .update(`${walletPublicKey}:${tokenMint}:${Date.now()}`)
      .digest('hex')
      .slice(0, 16);

    // The practiced coin is a coin (in Practice): it gets a page.
    coinStore.add({
      mint: tokenMint,
      name: config?.token?.name || tokenResult?.name || null,
      symbol: config?.token?.symbol || tokenResult?.symbol || null,
      image: typeof config?.token?.logo?.dataUrl === 'string' && config.token.logo.dataUrl.length < 400_000
        ? config.token.logo.dataUrl
        : null,
      source: 'practice',
    });
    coinStore.recordEvent(tokenMint, { type: 'practice_launch', practice: true, outcome: 'landed' });
    res.json({
      success: true,
      run: {
        id: `demo-v2-${runId}`,
        runtime: 'demo',
        walletPublicKey,
        token: tokenResult,
        liquidity: lpResult,
        transfer: transferResult,
        readiness: completedReadiness,
        usedDefaultSweepDestination: !lpReadiness.plan.poolTopology.sweepDestination,
        completedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    sendErrorResponse(res, error, error.statusCode || 500);
  }
});

app.get('/api/v2/wallets', async (_req, res) => {
  try {
    const secretPinLocked = secretStore.isSecretPinLocked();
    const sourceWallets = isDemoMode()
      ? Array.from(demoManagedWallets.values())
      : pendingWallets.list();
    const wallets = sourceWallets.map((wallet, index) => managedWalletMetadata(wallet, {
      label: index === 0 ? 'Launch wallet' : `Local wallet ${index + 1}`,
      secretPinLocked: wallet.secretKey ? undefined : secretPinLocked,
    }));
    res.json({ success: true, wallets, secretPinLocked });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

app.post('/api/v2/wallets/generate', async (_req, res) => {
  try {
    const demoMode = isDemoMode();
    let managedWallet;
    if (!demoMode && rejectIfSecretPinLocked(res, 'generating a Trebuchet-managed wallet')) {
      return;
    }

    const walletInfo = await generateTemporaryWallet();
    const qrCode = await getWalletQRCode(walletInfo.publicKey);
    if (demoMode) {
      demoChainService.registerWallet(walletInfo.publicKey);
      rememberDemoManagedWallet({
        publicKey: walletInfo.publicKey,
        secretKey: walletInfo.secretKey,
        mnemonic: walletInfo.mnemonic,
        createdAt: new Date().toISOString(),
      });
      managedWallet = {
        publicKey: walletInfo.publicKey,
        secretKey: walletInfo.secretKey,
        mnemonic: walletInfo.mnemonic,
        createdAt: new Date().toISOString(),
      };
    } else {
      managedWallet = pendingWallets.add(
        walletInfo.publicKey,
        walletInfo.secretKey,
        walletInfo.mnemonic,
      );
    }
    rememberManagedDiscoveryWallet(managedWallet, 'Launch wallet');

    res.json({
      success: true,
      wallet: managedWalletMetadata(managedWallet, {
        label: 'Launch wallet',
        qrCode,
      }),
    });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

app.post('/api/v2/wallets/import', async (req, res) => {
  try {
    const demoMode = isDemoMode();
    let managedWallet;
    if (!demoMode && rejectIfSecretPinLocked(res, 'importing a Trebuchet-managed wallet')) {
      return;
    }

    const { keypair, mnemonic } = parseImportedWalletSecret(req.body?.secret || req.body?.secretKey || req.body?.mnemonic);
    const publicKey = keypair.publicKey.toBase58();
    const secretKey = Array.from(keypair.secretKey);
    const qrCode = await getWalletQRCode(publicKey);
    if (demoMode) {
      demoChainService.registerWallet(publicKey);
      rememberDemoManagedWallet({
        publicKey,
        secretKey,
        mnemonic,
        createdAt: new Date().toISOString(),
      });
      managedWallet = {
        publicKey,
        secretKey,
        mnemonic,
        createdAt: new Date().toISOString(),
      };
    } else {
      managedWallet = pendingWallets.add(publicKey, secretKey, mnemonic);
    }
    rememberManagedDiscoveryWallet(managedWallet, 'Imported wallet');

    res.json({
      success: true,
      wallet: managedWalletMetadata(managedWallet, {
        label: 'Imported wallet',
        source: 'imported-local',
        qrCode,
      }),
    });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

app.post('/api/v2/run-envelope/arm', async (req, res) => {
  try {
    const demoMode = isDemoMode();
    const walletPublicKey = String(req.body?.walletPublicKey || '').trim();
    const config = req.body?.config || {};
    const fundingEstimate = req.body?.fundingEstimate || null;
    const recoveryEndpoint = String(req.body?.recoveryEndpoint || '').trim();
    const reviewedPlan = req.body?.reviewedPlan || null;
    const reviewedPlanDigest = String(req.body?.reviewedPlanDigest || '').trim().toLowerCase();
    if (!walletPublicKey) {
      return res.status(400).json({ success: false, error: 'walletPublicKey required' });
    }
    new PublicKey(walletPublicKey);
    if (!demoMode && rejectIfSecretPinLocked(res, 'arming a Trebuchet local run')) return;

    const wallet = pendingWallets.get(walletPublicKey);
    if (!demoMode && (!wallet || !Array.isArray(wallet.secretKey))) {
      return res.status(404).json({
        success: false,
        error: 'Trebuchet-managed wallet secret is unavailable',
      });
    }
    if (recoveryEndpoint && !V2_RECOVERY_ENDPOINTS.has(recoveryEndpoint)) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_RECOVERY_ENDPOINT',
        error: 'The requested recovery operation is not eligible for a recovery envelope.',
      });
    }

    let recoveryReadiness = null;
    if (!demoMode && recoveryEndpoint) {
      const recoveryContext = await v2ReadinessForManagedWallet({
        walletPublicKey,
        config,
        body: req.body || {},
        requireFundingBalance: true,
      });
      recoveryReadiness = recoveryContext.readiness;
      const finalizationIssue = v2TransferFinalizationIssue(recoveryReadiness, {
        localDossier: req.body?.localDossier,
      });
      if (recoveryReadiness.nextEndpoint !== recoveryEndpoint
          || recoveryReadiness.blockers.length > 0
          || finalizationIssue) {
        return res.status(409).json({
          success: false,
          code: 'RECOVERY_ARM_BLOCKED',
          error: finalizationIssue
            || recoveryReadiness.blockers[0]?.detail
            || 'Recovery state changed. Refresh the Finish phase and review the remaining action.',
          readiness: recoveryReadiness,
        });
      }
    } else if (!demoMode) {
      const expectedFundingFingerprint = v2FundingEstimateFingerprint(config);
      const actualFundingFingerprint = String(fundingEstimate?.v2FundingFingerprint || '').trim();
      if (!(Number(fundingEstimate?.totalSol) > 0) || actualFundingFingerprint !== expectedFundingFingerprint) {
        return res.status(409).json({
          success: false,
          code: 'RUN_ENVELOPE_FUNDING_STALE',
          error: 'Run a current funding estimate before arming this launch.',
        });
      }
    }
    const canonicalPlan = buildV2LaunchPlan({
      ...config,
      walletPublicKey,
    }, {
      demoMode,
      ...(reviewedPlan?.generatedAt ? { now: reviewedPlan.generatedAt } : {}),
    });
    if (!recoveryEndpoint) {
      const reviewedPlanVerification = verifyLaunchPlan(reviewedPlan);
      const submittedDigest = String(reviewedPlan?.integrity?.digest || '').trim().toLowerCase();
      const canonicalDigest = String(canonicalPlan.integrity?.digest || '').trim().toLowerCase();
      if (
        !reviewedPlanVerification.valid
        || !/^[a-f0-9]{64}$/.test(reviewedPlanDigest)
        || reviewedPlanDigest !== submittedDigest
        || reviewedPlanDigest !== canonicalDigest
      ) {
        return res.status(409).json({
          success: false,
          code: 'RUN_ENVELOPE_PLAN_MISMATCH',
          error: 'The launch plan changed after review. Stage and review the current plan before arming.',
          planErrors: reviewedPlanVerification.errors,
        });
      }
    }
    const fullPlan = canonicalPlan;
    const plan = recoveryEndpoint
      ? v2RecoveryAuthorizationPlan(fullPlan, recoveryEndpoint, recoveryReadiness)
      : fullPlan;
    pruneV2RunEnvelopes();
    for (const [id, existing] of v2RunEnvelopes.entries()) {
      if (existing.walletPublicKey === walletPublicKey) v2RunEnvelopes.delete(id);
    }
    const envelopeId = `run-${crypto.randomBytes(16).toString('hex')}`;
    const armedAtMs = Date.now();
    const fundingTotalSol = Number(fundingEstimate?.totalSol || 0);
    const envelope = {
      id: envelopeId,
      walletPublicKey,
      status: 'armed',
      operationCount: plan.operations.length,
      executedOperationCount: 0,
      estimatedSolCost: recoveryEndpoint ? null : plan.funding.estimatedSolCost,
      maxSpendSol: recoveryEndpoint ? null : Math.max(plan.funding.estimatedSolCost, fundingTotalSol),
      authorizationKind: recoveryEndpoint ? 'recovery' : 'launch',
      nextEndpoint: recoveryEndpoint || null,
      planDigest: plan.integrity?.digest || null,
      configFingerprint: fullPlan.v2LaunchConfigFingerprint,
      walletFingerprint: fullPlan.v2LaunchWalletFingerprint,
      fundingEstimateHash: demoMode || recoveryEndpoint ? null : v2RunEnvelopeFundingHash(fundingEstimate),
      armedAt: new Date(armedAtMs).toISOString(),
      expiresAt: new Date(armedAtMs + V2_RUN_ENVELOPE_TTL_MS).toISOString(),
      expiresAtMs: armedAtMs + V2_RUN_ENVELOPE_TTL_MS,
      lastExecutedEndpoint: null,
      plan,
    };
    v2RunEnvelopes.set(envelope.id, envelope);
    launchJournal.upsertForWallet(
      walletPublicKey,
      {
        status: 'active',
        stage: 'launch_plan_armed',
        launchConfig: v2LaunchConfigSnapshotFromPlan(fullPlan),
        error: null,
        errorDetails: null,
      },
      {
        stage: 'launch_plan_armed',
        configFingerprint: fullPlan.v2LaunchConfigFingerprint,
        operationCount: plan.operations.length,
        authorizationKind: recoveryEndpoint ? 'recovery' : 'launch',
        nextEndpoint: recoveryEndpoint || null,
      },
    );

    res.json({
      success: true,
      envelope: publicV2RunEnvelope(envelope),
    });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

app.post('/api/v2/run-envelope/execute-next', async (req, res) => {
  if (isDemoMode()) {
    return res.status(409).json({
      success: false,
      error: 'Use the v2 demo launch runner while demo mode is active.',
    });
  }

  try {
    const config = req.body?.config || {};
    const walletPublicKey = String(req.body?.walletPublicKey || config.walletPublicKey || '').trim();
    if (!walletPublicKey) {
      return res.status(400).json({ success: false, error: 'walletPublicKey required' });
    }
    const runEnvelope = requireV2RunEnvelope(
      String(req.body?.runEnvelopeId || '').trim(),
      walletPublicKey,
    );
    const { wallet, readiness } = await v2ReadinessForManagedWallet({
      walletPublicKey,
      config,
      body: req.body || {},
      requireFundingBalance: true,
    });

    const configMatchesEnvelope = runEnvelope.configFingerprint === readiness.plan?.v2LaunchConfigFingerprint;
    const walletMatchesEnvelope = runEnvelope.walletFingerprint === readiness.plan?.v2LaunchWalletFingerprint;
    const fundingMatchesEnvelope = !runEnvelope.fundingEstimateHash
      || runEnvelope.fundingEstimateHash === v2RunEnvelopeFundingHash(req.body?.fundingEstimate);
    const endpointMatchesEnvelope = !runEnvelope.nextEndpoint
      || runEnvelope.nextEndpoint === readiness.nextEndpoint;
    if (!configMatchesEnvelope || !walletMatchesEnvelope || !fundingMatchesEnvelope || !endpointMatchesEnvelope) {
      throw v2RunEnvelopeError(
        'RUN_ENVELOPE_MISMATCH',
        'Launch configuration, wallet, or funding changed after arming. Review and arm the run again.',
      );
    }

    if (!wallet || !Array.isArray(wallet.secretKey)) {
      return res.status(409).json({
        success: false,
        code: 'WALLET_SECRET_UNAVAILABLE',
        error: 'Trebuchet-managed wallet secret is unavailable.',
        readiness,
      });
    }
    if (readiness.blockers.length > 0) {
      return res.status(409).json({
        success: false,
        code: 'V2_EXECUTION_BLOCKED',
        error: 'Resolve execution blockers before running the next classic operation.',
        readiness,
      });
    }
    if (!readiness.nextEndpoint) {
      return res.status(409).json({
        success: false,
        code: 'NO_NEXT_ENDPOINT',
        error: 'No classic endpoint is ready to execute.',
        readiness,
      });
    }

    const confirmedEndpoint = String(req.body?.confirmNextEndpoint || '').trim();
    if (confirmedEndpoint !== readiness.nextEndpoint) {
      return res.status(409).json({
        success: false,
        code: 'STALE_V2_READINESS',
        error: `Readiness changed; expected confirmation for ${readiness.nextEndpoint}.`,
        readiness,
      });
    }
    const finalizationIssue = v2TransferFinalizationIssue(readiness, {
      localDossier: req.body?.localDossier,
    });
    if (finalizationIssue) {
      return res.status(409).json({
        success: false,
        code: 'V2_FINALIZATION_BLOCKED',
        error: finalizationIssue,
        readiness,
      });
    }

    const balanceBefore = await v2WalletBalanceObservation(walletPublicKey);
    const result = await executeV2NextClassicOperation(readiness);
    const balanceAfter = await v2WalletBalanceObservation(walletPublicKey);
    const observedWalletDelta = v2ObservedWalletDelta(balanceBefore, balanceAfter);
    const followup = await v2ReadinessForManagedWallet({
      walletPublicKey,
      config,
      body: {
        ...req.body,
        tokenMint: result?.tokenMint || result?.mint || req.body?.tokenMint,
        liquidityComplete: Array.isArray(result?.results) && result.results.length > 0,
      },
      requireFundingBalance: true,
    });
    runEnvelope.executedOperationCount += 1;
    runEnvelope.lastExecutedEndpoint = readiness.nextEndpoint;
    const terminalSweepComplete = readiness.nextEndpoint === '/api/transfer-assets'
      && result?.walletEmpty === true
      && result?.hasPartialFailure !== true;
    const recoveryAuthorizationComplete = runEnvelope.authorizationKind === 'recovery';
    // A missing next endpoint can also mean a recoverable proof/funding
    // blocker. Keep the authorization record armed until the authoritative
    // terminal sweep says the wallet is empty. Recovery envelopes authorize
    // exactly one saved-journal action and must be reviewed again if another
    // recovery action remains afterward.
    runEnvelope.status = terminalSweepComplete || recoveryAuthorizationComplete ? 'complete' : 'armed';
    const envelopeResponse = publicV2RunEnvelope(runEnvelope);
    if (runEnvelope.status === 'complete') v2RunEnvelopes.delete(runEnvelope.id);

    res.json({
      success: true,
      envelope: envelopeResponse,
      executed: {
        endpoint: readiness.nextEndpoint,
        action: readiness.nextAction,
        result,
        observedWalletDelta,
      },
      readiness: followup.readiness,
      proof: followup.readiness.proof,
      executionObservation: {
        endpoint: readiness.nextEndpoint,
        walletPublicKey,
        observedWalletDelta,
      },
      journal: followup.context.journal || null,
    });
  } catch (error) {
    sendErrorResponse(res, error, error.statusCode || 500);
  }
});

// Renderer POSTs here after its splash video and first-run disclaimer
// have both been dismissed, signalling "now is a safe time to show
// an update-available modal — the main UI is visible underneath".
//
// The bridge module forwards the signal to main.js, which runs the
// silent update check. The bridge fires the handler at most once
// per process, so repeated POSTs (e.g. dev-mode page reloads) are
// harmless. In web mode (npm run web, no Electron) the bridge has
// no handler registered and the endpoint just returns ran:false —
// the renderer doesn't care about the response either way.
app.post('/api/trigger-startup-update-check', (_req, res) => {
  const result = updateCheckBridge.trigger();
  res.json({ success: true, ...result });
});

app.post('/api/check-for-updates', (_req, res) => {
  const result = updateCheckBridge.triggerManual();
  res.json({ success: true, ...result });
});

// Live airdrop progress poll. Returns the current { total, completed,
// failedCount, lastWallet, lastTokens, totalTokens, status, startedAt }
// for the given launch wallet, or null when nothing is tracked. The
// frontend polls this every ~500ms during a transfer that includes an
// airdrop so the user sees the progress bar tick forward in real time.
//
// Read-only and cheap — pure in-memory Map lookup. Same in demo and real
// mode (both code paths write into airdropProgress as they process
// recipients).
app.get('/api/airdrop-progress', (req, res) => {
  const wallet = req.query.wallet;
  if (!wallet || typeof wallet !== 'string') {
    return res.status(400).json({ success: false, error: 'wallet query param required' });
  }
  const state = airdropProgressGet(wallet);
  res.json({ success: true, state });
});

// Live LP progress poll. Returns events that have occurred since the
// client-provided cursor index, plus the current run status. The frontend
// polls this during /api/create-lp and translates each event into a row
// marking on the phase progress tree so rows transition pending → done
// one at a time instead of all flipping when the response lands.
//
// Read-only. Pure in-memory lookup. Currently driven by demo mode (the
// only code path that writes lp progress events) — real mode could plug
// into the same infrastructure later by wiring its onProgress callback
// through.
app.get('/api/lp-progress', (req, res) => {
  const wallet = req.query.wallet;
  if (!wallet || typeof wallet !== 'string') {
    return res.status(400).json({ success: false, error: 'wallet query param required' });
  }
  const since = Number.isFinite(Number(req.query.since)) ? Number(req.query.since) : 0;
  const state = lpProgressGet(wallet, since);
  res.json({ success: true, state });
});

// Lightweight RPC health check — sends a getVersion JSON-RPC call and
// reports back the version + latency. Used by the "Test" button in the UI
// before saving a new endpoint.
app.post('/api/rpc-config/test', async (req, res) => {
  const result = await testRpc(req.body.url);
  res.json({ success: true, result });
});

// RPC health polling endpoint — called every 30s by the frontend to drive
// the health indicator dot. Sends a lightweight getHealth JSON-RPC call
// (lighter than getVersion — no blockhash fetch) against the currently
// active RPC and reports latency + health status. getHealth is a Solana
// JSON-RPC method that returns "ok" when the node is healthy — it's
// universally supported and costs essentially nothing.
app.get('/api/rpc-health', async (_req, res) => {
  if (isDemoMode()) return demoChainService.handleRpcHealth(_req, res);
  const url = getRpcConfig().active;
  try {
    const start = Date.now();
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth', params: [] }),
      signal: AbortSignal.timeout(8000),
    });
    const latencyMs = Date.now() - start;
    if (!resp.ok) {
      return res.json({ success: true, health: 'error', latencyMs, error: `HTTP ${resp.status}` });
    }
    const json = await resp.json();
    if (json.error) {
      return res.json({ success: true, health: 'error', latencyMs, error: json.error.message });
    }
    const healthy = json.result === 'ok';
    res.json({
      success: true,
      health: healthy ? (latencyMs < 400 ? 'good' : 'slow') : 'error',
      latencyMs,
    });
  } catch (e) {
    res.json({ success: true, health: 'error', latencyMs: null, error: e.message });
  }
});



// ---------------------------------------------------------------------------
// Token creation
// ---------------------------------------------------------------------------

function uploadLogo(req, res, next) {
  upload.single('logo')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    if (req.file) {
      try {
        // Authoritative logo validation: type + byte cap + 200×200 pixel
        // ceiling (see validators.js for why the ceiling exists). The
        // frontend pre-checks the same rule for a friendlier error, but
        // the server never trusts the client.
        const { mime } = assertLogoConstraints(req.file.buffer);
        req.file.detectedMime = mime;
        assertClassicLogoDimensions(req.file.buffer);
      } catch (logoError) {
        return res.status(400).json({ success: false, error: logoError.message });
      }
    }
    next();
  });
}

const V2_LOGO_DATA_URL_RE = /^data:(image\/(?:png|jpeg|gif));base64,([A-Za-z0-9+/=]+)$/;
const V2_MAX_LOGO_BYTES = 100 * 1024;
const CLASSIC_LOGO_MIN_DIMENSION = 64;
const CLASSIC_LOGO_MAX_DIMENSION = 200;

function assertClassicLogoDimensions(buffer) {
  const dimensions = detectLogoImageDimensions(buffer);
  if (!dimensions) {
    throw new Error('Token logo dimensions could not be read');
  }
  if (dimensions.width > CLASSIC_LOGO_MAX_DIMENSION || dimensions.height > CLASSIC_LOGO_MAX_DIMENSION) {
    throw new Error(
      `Token logo is ${dimensions.width}x${dimensions.height}px; max is ` +
        `${CLASSIC_LOGO_MAX_DIMENSION}x${CLASSIC_LOGO_MAX_DIMENSION}px`,
    );
  }
  if (dimensions.width < CLASSIC_LOGO_MIN_DIMENSION || dimensions.height < CLASSIC_LOGO_MIN_DIMENSION) {
    throw new Error(
      `Token logo is ${dimensions.width}x${dimensions.height}px; minimum is ` +
        `${CLASSIC_LOGO_MIN_DIMENSION}x${CLASSIC_LOGO_MIN_DIMENSION}px`,
    );
  }
}

function logoBase64FromCreateTokenInput(input, logoFile) {
  if (logoFile) {
    const logoMime = logoFile.detectedMime;
    return `data:${logoMime};base64,${logoFile.buffer.toString('base64')}`;
  }

  const logo = input?.logo;
  const dataUrl = typeof input?.logoDataUrl === 'string'
    ? input.logoDataUrl
    : (logo && typeof logo === 'object' && typeof logo.dataUrl === 'string' ? logo.dataUrl : null);
  if (!dataUrl) return null;

  const match = dataUrl.match(V2_LOGO_DATA_URL_RE);
  if (!match) throw new Error('Token logo must be a PNG, JPG, or GIF data URL');
  const decoded = Buffer.from(match[2], 'base64');
  if (decoded.length > V2_MAX_LOGO_BYTES) throw new Error('Token logo must be 100KB or smaller');
  const detectedMime = normalizeLogoImageMime(decoded);
  assertClassicLogoDimensions(decoded);
  return `data:${detectedMime};base64,${decoded.toString('base64')}`;
}

function recordTokenJournalProgress(walletPublicKey, event) {
  if (!walletPublicKey || !event) return;
  const token = {};
  if (event.tokenMint) token.mint = event.tokenMint;
  if (event.metadataUri) token.metadataUri = event.metadataUri;
  if (event.metadataHash) token.metadataHash = event.metadataHash;
  if (event.imageUri) token.imageUri = event.imageUri;
  if (event.onChainMetadataUri) token.onChainMetadataUri = event.onChainMetadataUri;
  if (event.mintFormat) token.mintFormat = event.mintFormat;
  if (event.tokenProgram) token.tokenProgram = event.tokenProgram;
  if (event.metadataStandard) token.metadataStandard = event.metadataStandard;
  if (typeof event.metadataPointerAuthorityRevoked === 'boolean') {
    token.metadataPointerAuthorityRevoked = event.metadataPointerAuthorityRevoked;
  }
  if (typeof event.sealedLaunch === 'boolean') token.sealedLaunch = event.sealedLaunch;
  if (event.stage === 'logo_stamped') token.logoStamped = true;
  if (event.stage === 'logo_stamp_skipped') {
    token.logoStamped = false;
    token.logoStampSkipReason = event.reason || null;
  }
  if (typeof event.sealedMetadataPending === 'boolean') {
    token.sealedMetadataPending = event.sealedMetadataPending;
  }
  if (typeof event.mintAuthorityRenounced === 'boolean') {
    token.mintAuthorityRenounced = event.mintAuthorityRenounced;
  }
  if (typeof event.freezeAuthorityDisabled === 'boolean') {
    token.freezeAuthorityDisabled = event.freezeAuthorityDisabled;
  }
  if (typeof event.metadataUpdateAuthorityRevoked === 'boolean') {
    token.metadataUpdateAuthorityRevoked = event.metadataUpdateAuthorityRevoked;
  }
  if (typeof event.metadataImmutable === 'boolean') {
    token.metadataImmutable = event.metadataImmutable;
  }
  if (typeof event.metadataAuthorityKept === 'boolean') {
    token.metadataAuthorityKept = event.metadataAuthorityKept;
  }

  launchJournal.upsertForWallet(
    walletPublicKey,
    {
      stage: event.stage || 'token_progress',
      token: Object.keys(token).length > 0 ? token : undefined,
    },
    event,
  );
}

function transferJournalSummary({
  destinationWallet,
  tokensTransferred,
  solTransferred,
  nftSweep,
  tokenSweep,
  solSweep,
  solSweepError,
  solSweepSkipped,
  walletEmpty,
}) {
  return {
    destinationWallet,
    tokensTransferred,
    solTransferred,
    nftsTransferred: nftSweep?.transferred?.length || 0,
    tokenSweep: tokenSweep || { transferred: [], errors: [] },
    nftSweep: nftSweep || { transferred: [], errors: [] },
    solSweep: solSweep || { solTransferred: solTransferred || 0 },
    tokenTransferErrors: tokenSweep?.errors || [],
    nftTransferErrors: nftSweep?.errors || [],
    solSweepError: solSweepError || null,
    solSweepSkipped: solSweepSkipped || null,
    walletEmpty,
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function recordLpJournalProgress(walletPublicKey, event) {
  if (!walletPublicKey || !event) return;

  const journal = launchJournal.activeForWallet(walletPublicKey);
  const partialResults = journalResultList(journal);
  const patch = { stage: event.stage || 'lp_progress' };

  if (applyLpEventToResults(partialResults, event, journal)) {
    patch.lp = { partialResults };
  }

  launchJournal.upsertForWallet(walletPublicKey, patch, event);
}

function mergePriorResults(priorResults, recoveredResults) {
  const merged = cloneJson(priorResults || []);
  for (const recovered of recoveredResults || []) {
    upsertJournalResult(merged, recovered);
  }
  return merged;
}

function materializePhase1RecoveryResults(journal, priorResults, allocations) {
  const completedAllocations = new Set((priorResults || []).map((r) => r.allocationIndex));
  const poolCreateEvents = unsafeCreatedPoolEvents(journal, priorResults);
  const byAllocation = new Map();
  const blockedEvents = [];

  for (const event of poolCreateEvents) {
    const allocIdx = Number(event.allocationIndex);
    if (!Number.isInteger(allocIdx) || allocIdx < 0 || allocIdx >= allocations.length) {
      blockedEvents.push({ ...event, reason: 'allocation index is outside the current plan' });
      continue;
    }
    if (completedAllocations.has(allocIdx)) continue;
    if (!event.poolId) {
      blockedEvents.push({ ...event, reason: 'pool_create_done is missing poolId' });
      continue;
    }
    const bucket = byAllocation.get(allocIdx) || [];
    bucket.push(event);
    byAllocation.set(allocIdx, bucket);
  }

  const recoveredResults = [];
  for (const [allocationIndex, events] of byAllocation.entries()) {
    const poolIds = [...new Set(events.map((event) => event.poolId).filter(Boolean))];
    if (poolIds.length !== 1) {
      blockedEvents.push(...events.map((event) => ({
        ...event,
        reason: 'multiple created pools recorded for one allocation',
      })));
      continue;
    }

    let distribution;
    try {
      distribution = normalizeDistribution(allocations[allocationIndex]?.distribution);
    } catch (err) {
      blockedEvents.push(...events.map((event) => ({
        ...event,
        reason: `distribution cannot be normalized: ${launchJournal.errorMessage(err)}`,
      })));
      continue;
    }

    const alloc = allocations[allocationIndex] || {};
    const mainPositions = latestEventsByIndex(
      journal.events,
      'main_open_done',
      'sliceIndex',
      allocationIndex,
    ).map(({ index, event }) => {
      if (index >= distribution.length) {
        blockedEvents.push({ ...event, reason: 'main slice index is outside the current distribution' });
        return null;
      }
      return {
        sliceIndex: index,
        sharePercent: Number.isFinite(Number(event.sharePercent))
          ? Number(event.sharePercent)
          : distribution[index]?.sharePercent,
        tickLower: Number.isFinite(event.tickLower) ? event.tickLower : null,
        tickUpper: Number.isFinite(event.tickUpper) ? event.tickUpper : null,
        nftMint: event.nftMint || null,
        locked: false,
        recipient: distribution[index]?.recipient || null,
        transferredTo: null,
        txIds: { open: event.txId || null, lock: null, transfer: null },
      };
    }).filter(Boolean);

    const ladderPositions = latestEventsByIndex(
      journal.events,
      'ladder_open_done',
      'bandIndex',
      allocationIndex,
    ).map(({ index, event }) => ({
      bandIndex: index,
      tickLower: Number.isFinite(event.tickLower) ? event.tickLower : null,
      tickUpper: Number.isFinite(event.tickUpper) ? event.tickUpper : null,
      nftMint: event.nftMint || null,
      locked: false,
      txIds: { open: event.txId || null, lock: null },
    }));

    const supportPositions = (journal.events || [])
      .filter((event) => event.stage === 'support_open_done' && event.allocationIndex === allocationIndex)
      .slice(-1)
      .map((event) => ({
        tickLower: Number.isFinite(event.tickLower) ? event.tickLower : null,
        tickUpper: Number.isFinite(event.tickUpper) ? event.tickUpper : null,
        depthPct: Number.isFinite(event.depthPct) ? event.depthPct : null,
        quoteRaw: event.quoteAmountRaw || null,
        nftMint: event.nftMint || null,
        locked: false,
        txIds: { open: event.txId || null, lock: null },
      }));

    const missingNftEvent = [...mainPositions, ...ladderPositions, ...supportPositions]
      .find((position) => !position.nftMint);
    if (missingNftEvent) {
      blockedEvents.push(...events.map((event) => ({
        ...event,
        reason: 'one or more recorded open events is missing nftMint',
      })));
      continue;
    }

    const createEvent = events.at(-1);
    recoveredResults.push({
      allocationIndex,
      phase1Incomplete: true,
      recoveredFrom: 'journal_events',
      quoteSymbol: alloc.quoteSymbolOverride || alloc.quoteToken || `allocation ${allocationIndex + 1}`,
      quoteAddress: alloc.quoteToken || null,
      supplyPercent: alloc.supplyPercent,
      poolId: poolIds[0],
      mainPositions,
      ladderPositions,
      supportPositions,
      bootstrap: null,
      txIds: { createPool: createEvent.txId || null },
    });
  }

  return { recoveredResults, blockedEvents };
}

async function finishTokenCreationHandler(req, res) {
  return serveLaunchOperation(res, () => launchServices.finishToken(req.body));
}

app.post('/api/finish-token-creation', finishTokenCreationHandler);

function sealedMetadataRevealReadiness(journal) {
  const results = v2JournalLiquidityResults(journal);
  const plannedPoolCount = Math.max(
    1,
    Array.isArray(journal?.poolPlan?.allocations) ? journal.poolPlan.allocations.length : 0,
    Array.isArray(journal?.poolPlan?.pools) ? journal.poolPlan.pools.length : 0,
  );
  const recordedPoolCount = results.filter((pool) => v2TrimmedText(pool?.poolId || pool?.id)).length;
  const positionCount = v2ProofPositionCount(results);
  const lockedPositionCount = v2ProofLockedPositionCount(results);
  const ready = recordedPoolCount >= plannedPoolCount
    && positionCount > 0
    && lockedPositionCount === positionCount;
  return {
    ready,
    plannedPoolCount,
    recordedPoolCount,
    positionCount,
    lockedPositionCount,
  };
}

async function revealSealedMetadataForJournal({ walletPublicKey, secretKeyArr }) {
  const journal = latestLaunchJournalForWallet(walletPublicKey);
  const token = journal?.token;
  if (!journal || !token?.mint) throw new Error('No launch journal with a token mint was found.');
  if (token.sealedLaunch !== true || token.sealedMetadataPending !== true) {
    return {
      tokenMint: token.mint,
      metadataUri: token.metadataUri || null,
      sealedMetadataPending: false,
      skipped: true,
    };
  }
  const revealReadiness = sealedMetadataRevealReadiness(journal);
  if (!revealReadiness.ready) {
    const error = new Error(
      'Identity remains sealed until every planned pool exists and every liquidity position is locked. '
      + `Recorded ${revealReadiness.recordedPoolCount}/${revealReadiness.plannedPoolCount} pools and `
      + `${revealReadiness.lockedPositionCount}/${revealReadiness.positionCount} locked positions.`,
    );
    error.code = 'SEALED_METADATA_WAITING_FOR_LOCKS';
    error.statusCode = 409;
    error.revealReadiness = revealReadiness;
    throw error;
  }
  // Deferred sealed launches upload their identity only now. The URIs go in
  // the journal before any chain write, so a retried reveal reuses them.
  const identity = getSealedIdentity(token.mint);
  let metadataUri = token.metadataUri;
  if (!metadataUri) {
    if (!identity) {
      throw new Error('This sealed launch has no uploaded identity and its sealed identity is not on this machine.');
    }
    const uploaded = await uploadSealedIdentity({
      tempWalletSecretKey: secretKeyArr,
      identity,
      // The journal's metadataHash is the launch commitment; keep it.
      onProgress: (event) => recordTokenJournalProgress(walletPublicKey, { ...event, metadataHash: undefined }),
    });
    metadataUri = uploaded.metadataUri;
    launchJournal.update(
      journal.id,
      { token: { metadataUri, imageUri: uploaded.imageUri } },
      { stage: 'sealed_identity_uploaded', tokenMint: token.mint, metadataUri },
    );
  }
  const result = await revealSealedTokenMetadata({
    tempWalletSecretKey: secretKeyArr,
    tokenMint: token.mint,
    name: token.name,
    symbol: token.symbol,
    metadataUri,
    metadataHash: token.metadataHash,
    imageSha256: identity?.imageSha256 || null,
    metadataExecution: { update: requireWalletExecution().updateMetadata, recover: requireWalletExecution().recoverMetadataReveal },
    onProgress: (event) => recordTokenJournalProgress(walletPublicKey, event),
  });
  const finalMetadataHash = result.finalMetadataHash || token.metadataHash;
  launchJournal.update(
    journal.id,
    {
      status: 'active',
      stage: 'metadata_revealed',
      error: null,
      errorDetails: null,
      token: {
        sealedMetadataPending: false,
        metadataUri,
        metadataHash: finalMetadataHash,
        sealedCommitment: token.metadataHash,
        metadataOperationId: result.operationId || token.metadataOperationId,
        metadataTransactionId: result.txId || token.metadataTransactionId,
        onChainMetadataUri: metadataUri,
        mintFormat: result.mintFormat || token.mintFormat,
        tokenProgram: result.tokenProgram || token.tokenProgram,
        metadataStandard: result.metadataStandard || token.metadataStandard,
        metadataPointerAuthorityRevoked: result.metadataPointerAuthorityRevoked
          ?? token.metadataPointerAuthorityRevoked,
        metadataUpdateAuthorityRevoked: true,
        metadataImmutable: true,
        isSafe: true,
      },
    },
    { stage: 'metadata_revealed', tokenMint: token.mint, metadataUri, operationId: result.operationId, txId: result.txId },
  );
  removeSealedIdentity(token.mint);
  const updated = launchJournal.get(journal.id);
  registerOfficialBrandLaunch({ journal: updated, token: updated.token, secretKey: secretKeyArr });
  const followupScan = setTimeout(() => void runBrandShieldScan(), 20_000);
  followupScan.unref?.();
  return result;
}

async function revealSealedMetadataAfterLiquidity({ walletPublicKey, secretKeyArr }) {
  const journal = latestLaunchJournalForWallet(walletPublicKey);
  if (journal?.token?.sealedLaunch !== true || journal?.token?.sealedMetadataPending !== true) {
    return revealSealedMetadataForJournal({ walletPublicKey, secretKeyArr });
  }
  const readiness = sealedMetadataRevealReadiness(journal);
  if (!readiness.ready) {
    return {
      success: false,
      skipped: true,
      pending: true,
      code: 'SEALED_METADATA_WAITING_FOR_LOCKS',
      reason: 'Identity remains sealed until every planned liquidity position is locked.',
      readiness,
    };
  }
  return revealSealedMetadataForJournal({ walletPublicKey, secretKeyArr });
}

async function revealSealedMetadataHandler(req, res) {
  return serveLaunchOperation(res, () => launchServices.revealMetadata(req.body));
}

app.post('/api/reveal-sealed-metadata', revealSealedMetadataHandler);

async function createTokenHandler(req, res) {
  if (isDemoMode()) return demoChainService.handleCreateToken(req, res);
  return serveLaunchOperation(res, () => launchServices.createToken(req.body, { logoFile: req.file }));
}

app.post('/api/create-token', uploadLogo, createTokenHandler);

// ---------------------------------------------------------------------------
// LP / pool creation endpoints
// ---------------------------------------------------------------------------

// CLMM fee tier list: drives the per-pool fee dropdown in Step 2. Pulls
// from Raydium's published config endpoint with a process-lifetime cache;
// returns a hardcoded fallback list if the endpoint is unreachable so
// the UI never breaks. Restart the app to pick up newly-added Raydium tiers.
app.get('/api/clmm-fee-tiers', async (_req, res) => {
  try {
    const tiers = await getClmmFeeTiers();
    res.json({ success: true, tiers });
  } catch (error) {
    console.error('Error fetching CLMM fee tiers:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Image proxy for token logos. The 3D coin preview (coinRenderer.js) draws the
// back-face token logo into a WebGL texture, which requires the source image to
// be CORS-clean — many logo hosts (CDNs, indexers) don't send CORS headers, so
// loading them directly with crossOrigin fails and the coin falls back to
// embossing the symbol text. Re-serving the logo from our own origin sidesteps
// CORS entirely, so the coin shows the real logo for every token — the same
// logo the pool-configuration rows already display via plain <img> tags.
//
// This is a read-only passthrough, but we still guard it like a proxy: https
// only, block loopback/private/link-local hosts (SSRF), enforce a timeout, only
// pass through real image content-types, and cap the response size.
// SSRF defense for /api/proxy-image (F8).
//
// A literal-hostname denylist is not enough on its own: a public DNS name can
// resolve to a private IP (e.g. an attacker's domain pointing at 169.254.169.254
// cloud metadata or an RFC1918 address), and a permitted host can 30x-redirect
// to an internal one. So this proxy now (a) resolves the hostname and rejects
// if ANY resolved address is private/loopback/link-local, and (b) follows
// redirects MANUALLY, re-validating every hop. The trigger here is a token logo
// URL, which is fully attacker-controlled, so this endpoint is the obvious SSRF
// surface in the app.
//
// Residual caveat: a TOCTOU DNS-rebinding window remains — the address could
// change between our resolve and fetch's own resolve. Fully closing it needs a
// pinned-IP custom dispatcher, which is heavier than warranted for a logo
// proxy; the checks below close the realistic vectors.
function isPrivateIp(ip) {
  const a = String(ip).toLowerCase();
  if (a === '::1' || a === '::') return true;             // IPv6 loopback / unspecified
  if (a.startsWith('fe80:')) return true;                 // IPv6 link-local
  if (a.startsWith('fc') || a.startsWith('fd')) return true; // IPv6 unique-local fc00::/7
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — validate the embedded IPv4
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const v4 = mapped ? mapped[1] : a;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
    const o = v4.split('.').map(Number);
    if (o[0] === 0 || o[0] === 127) return true;          // 0.0.0.0/8, loopback
    if (o[0] === 10) return true;                          // 10/8
    if (o[0] === 169 && o[1] === 254) return true;         // link-local / cloud metadata
    if (o[0] === 192 && o[1] === 168) return true;         // 192.168/16
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16/12
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT 100.64/10
  }
  return false;
}

// Reject obviously-private literals fast (covers IP-literal hostnames before
// any DNS work). Hostnames are resolved-and-checked separately.
function assertAllowedProxyUrl(parsed) {
  if (parsed.protocol !== 'https:') throw new Error('only https urls allowed');
  const host = parsed.hostname.toLowerCase();
  const literalPrivate =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host);
  if (literalPrivate) throw new Error('host not allowed');
}

// Resolve a hostname and throw if any resolved address is private.
async function assertHostResolvesPublic(hostname) {
  let addrs;
  try {
    addrs = await dnsPromises.lookup(hostname, { all: true });
  } catch (e) {
    throw new Error('host not resolvable');
  }
  if (!addrs || addrs.length === 0) throw new Error('host not resolvable');
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new Error('host resolves to a private address');
  }
}

async function fetchProxyImage(parsed) {
  // Time-box the whole fetch (including redirect chain) so a slow/hung host
  // can't pin the request.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  // Follow redirects manually so each hop is re-validated. fetch with
  // redirect:'manual' returns the 3xx response instead of chasing it for us.
  const MAX_HOPS = 4;
  let currentUrl = parsed;
  let upstream;
  try {
    for (let hop = 0; ; hop++) {
      assertAllowedProxyUrl(currentUrl);
      await assertHostResolvesPublic(currentUrl.hostname);
      const resp = await fetch(currentUrl.toString(), {
        signal: controller.signal,
        headers: { Accept: 'image/*' },
        redirect: 'manual',
      });
      if (resp.status >= 300 && resp.status < 400) {
        if (hop >= MAX_HOPS) throw new Error('too many redirects');
        const loc = resp.headers.get('location');
        if (!loc) throw new Error('redirect without location');
        // Resolve relative redirects against the current URL; the next loop
        // iteration re-runs the full protocol + host + IP validation on it.
        currentUrl = new URL(loc, currentUrl);
        continue;
      }
      upstream = resp;
      break;
    }
    if (!upstream.ok) throw new Error('upstream ' + upstream.status);

    const type = (upstream.headers.get('content-type') || '').toLowerCase();
    if (!type.startsWith('image/')) throw new Error('not an image');

    const MAX_BYTES = 2 * 1024 * 1024; // logos are tiny; refuse anything large
    const declared = Number(upstream.headers.get('content-length') || 0);
    if (declared && declared > MAX_BYTES) throw new Error('image too large');

    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.length > MAX_BYTES) throw new Error('image too large');
    return { type, body };
  } finally {
    clearTimeout(timer);
  }
}

// One upstream fetch per URL at a time: a coin card and its color reading
// ask for the same logo together.
const proxyImageInflight = new Map();

app.get('/api/proxy-image', async (req, res) => {
  const raw = req.query.url;
  try {
    if (!raw || typeof raw !== 'string') throw new Error('url required');

    let parsed;
    try {
      parsed = new URL(raw);
    } catch (e) {
      throw new Error('invalid url');
    }
    // Validate before touching the cache, so a disallowed URL is refused
    // even if it was somehow cached.
    assertAllowedProxyUrl(parsed);
    const cacheControl = isContentAddressed(raw)
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=86400';

    const cached = getCachedImage(raw);
    if (cached) {
      res.set('Content-Type', cached.type);
      res.set('Cache-Control', cacheControl);
      res.set('X-Trebuchet-Image-Cache', 'hit');
      res.send(cached.body);
      return;
    }
    const failed = recentImageFailure(raw);
    if (failed) throw new Error(failed);

    let pending = proxyImageInflight.get(raw);
    if (!pending) {
      pending = fetchProxyImage(parsed)
        .then((image) => {
          putCachedImage(raw, image);
          return image;
        })
        .catch((error) => {
          rememberImageFailure(raw, error.message);
          throw error;
        })
        .finally(() => proxyImageInflight.delete(raw));
      proxyImageInflight.set(raw, pending);
    }
    const image = await pending;
    res.set('Content-Type', image.type);
    res.set('Cache-Control', cacheControl);
    res.set('X-Trebuchet-Image-Cache', 'miss');
    res.send(image.body);
  } catch (error) {
    // 404 (not 500) so a failed proxy cleanly triggers the client's image
    // onerror path and the coin falls back to the embossed symbol quietly.
    res.status(404).json({ success: false, error: error.message });
  }
});

// Mint-compatibility cache. The Raydium CLMM compat check (program
// ownership, Token-2022 extensions, whitelist status) reads on-chain
// data that NEVER changes for a given mint — a token's program owner
// and Token-2022 extensions are baked at mint creation and immutable.
// Once we've successfully checked a mint, the result is permanent for
// the lifetime of the server process.
//
// This cache exists because /api/quote-token-info is called frequently
// by the frontend (every quote-token input/change), and each compat
// check costs one Solana RPC call (getAccountInfo). For the meme
// flywheel mint specifically, repeated calls during a single launch
// configuration session would generate enough RPC traffic to trigger
// rate limiting. The cache turns those into zero-cost lookups.
//
// We cache the SUCCESS path only — failures (RPC down, mint not on
// chain) are left uncached so the user can retry without waiting for
// the cache to clear.
const compatCache = new Map();

// Step 2 swap-probe cache. Stores the verdict of probeRaydiumPriceStrict
// for arbitrary (non-known-safe) quote tokens. The /api/quote-token-info
// endpoint runs the probe to tell the user whether their chosen quote
// token is Raydium-tradeable BEFORE they commit time to funding.
//
// Why cache: the frontend re-resolves quote-token info on every input
// change as the user types/pastes a mint, which would hammer the
// Raydium Trade API without caching. The 3-minute TTL is the plan's
// resolved decision (long enough to absorb keystroke storms, short
// enough that the cached "tradeable" claim doesn't drift far from
// reality if Raydium's pools change).
//
// Cache entry shape:
//   { verdict: 'tradeable' | 'no-route' | 'unreachable',
//     priceUsd: Decimal | null,   // only set when verdict='tradeable'
//     expiresAt: ms-epoch }
//
// IMPORTANT: This is a Step 2 short-circuit. The pool-create-time
// just-in-time probe in createPoolsAndPositions still runs fresh
// for every non-SOL quote regardless of this cache.
const step2ProbeCache = new Map();
const STEP2_PROBE_TTL_MS = 3 * 60 * 1000;  // 3 minutes

// On-chain display-price cache. Same motivation as the probe cache above:
// this endpoint fires on every input change, and the on-chain lookup is
// three pool-discovery calls plus one RPC read per candidate pool — all
// against the USER'S RPC. Uncached, that is a rate-limit trap on the free
// public endpoint and a sluggish editor on any endpoint. Shorter TTL than
// the probe cache because this IS the price the user is about to launch
// against — a minute is long enough to absorb a keystroke storm and short
// enough that the shown number tracks a live market. Keyed by mint AND
// the RPC in use, so switching RPC never serves a price read elsewhere.
// Spread findings are cached too (they are a property of the market, not
// a transient failure); read errors are not, so the user can retry.
const onChainPriceCache = new Map();
const ON_CHAIN_PRICE_TTL_MS = 60 * 1000;

// Quote-token info: when the user picks/enters a quote token in the UI,
// we look up its symbol/decimals/USD price for inline display. For known
// quote tokens (SOL/USDC/USDT) we use built-in constants. For arbitrary
// SPL mint addresses we look the metadata up via GeckoTerminal — falling
// back to a truncated address as the symbol if the token isn't indexed
// (in which case the user will need to fill in manual overrides).
app.post('/api/quote-token-info', async (req, res) => {
  // Demo: synthetic, instant, never blocks. Real mode below does on-chain
  // reads, authority audits, Raydium probes, and pool-price discovery.
  if (isDemoMode()) return demoChainService.handleQuoteTokenInfo(req, res);
  try {
    const { quoteToken } = req.body;
    if (!quoteToken) throw new Error('quoteToken required');

    if (isDemoMode()) {
      const upper = String(quoteToken).toUpperCase();
      const known = KNOWN_QUOTES[upper] ? { ...KNOWN_QUOTES[upper] } : null;
      const address = known?.address || String(quoteToken);
      return res.json({
        success: true,
        info: {
          ...(known || {}),
          address,
          symbol: known?.symbol || 'DEMO',
          decimals: known?.decimals ?? 6,
          priceUsd: upper === 'SOL' ? '200' : '1',
          priceSource: 'demo-ledger',
          compatible: true,
          isToken2022: false,
          extensions: [],
          disallowedNames: [],
          freezeAuthorityDisabled: true,
          mintAuthorityRenounced: true,
          freezeAuthorityBlock: false,
          mintAuthorityWarning: false,
          raydiumTradeable: 'yes',
          swapRoute: 'raydium',
          demo: true,
        },
      });
    }

    // Resolve identity / metadata first (existing logic), then run a
    // separate Raydium-CLMM compatibility check at the end. The compat
    // check requires the on-chain mint to exist; for known symbols we
    // skip it because SOL/USDC/USDT are all classic SPL Token (always
    // compatible) and we don't need an RPC round-trip to confirm that.
    const { Connection, PublicKey } = await import('@solana/web3.js');

    let infoOut = null;

    const upper = quoteToken.toUpperCase();
    if (KNOWN_QUOTES[upper]) {
      // Known token — use built-in constants for symbol/decimals/programId
      // (and imageUrl/name, which we hardcode for the well-known three),
      // and only hit external indexers for the live price.
      const info = { ...KNOWN_QUOTES[upper] };
      const priceUsd = await getUsdPrice(info.address);
      // priceSource label: SOL uses the dedicated 'sol' label (matches
      // what funding-estimate emits for SOL pools); USDC/USDT come from
      // the aggregator chain (no Step 2 probe since they're in
      // KNOWN_SAFE_QUOTES) so they get 'oracle'.
      const priceSource = upper === 'SOL' ? 'sol' : 'oracle';
      infoOut = {
        ...info,
        priceUsd: priceUsd ? priceUsd.toString() : null,
        priceSource,
        // Known quotes are all classic SPL Token and definitionally compatible.
        compatible: true,
        isToken2022: false,
        extensions: [],
        disallowedNames: [],
        // Known quotes are in KNOWN_SAFE_QUOTES — authority audit is
        // pre-vetted. Surface the fields explicitly so the UI doesn't
        // need a special case for known vs arbitrary.
        freezeAuthorityDisabled: true,
        mintAuthorityRenounced: true,
        freezeAuthorityBlock: false,
        mintAuthorityWarning: false,
        // Known quotes have well-established Raydium liquidity. Skip
        // the Step 2 probe — pool-create time still runs a fresh probe
        // so we can't silently use stale data here.
        raydiumTradeable: 'yes',
        swapRoute: 'raydium',
      };
    } else {
      // Arbitrary mint address. tokenInfoService reads decimals + symbol
      // on-chain (always works for any real mint), then tries GeckoTerminal
      // first then DexScreener as a price fallback. priceUsd may still come
      // back null if both indexers fail; the frontend handles that by
      // surfacing the Advanced overrides as the recommended next step.
      // imageUrl/name come from Gecko or DexScreener and may also be null
      // for tokens neither indexer has — the frontend just hides the logo.
      const meta = await getTokenMetadata(quoteToken);
      if (meta && meta.decimals != null) {
        infoOut = {
          address: quoteToken,
          symbol: meta.symbol,
          decimals: meta.decimals,
          priceUsd: meta.priceUsd ? meta.priceUsd.toString() : null,
          // Baseline priceSource: the aggregator chain (Gecko →
          // DexScreener via tokenInfoService) is what produced this
          // price. If a Raydium probe succeeds below, it'll overwrite
          // both priceUsd and priceSource with the probe-derived
          // values.
          priceSource: meta.priceUsd ? 'oracle' : null,
          name: meta.name ?? null,
          imageUrl: meta.imageUrl ?? null,
        };
      } else {
        // Hit only when the mint doesn't actually exist on-chain (or the
        // user's RPC is down / wrong). Return a placeholder so the UI can
        // still render something sane while the user corrects the input.
        infoOut = {
          address: quoteToken,
          symbol: quoteToken.slice(0, 4) + '…',
          decimals: null,
          priceUsd: null,
          name: null,
          imageUrl: null,
        };
      }

      // On-chain pool price FIRST — the same source and rules the launch
      // uses (deepest in-range pool with >= $100; spread refused), so the
      // number the user sees in the editor is the number the launch will
      // use. Overrides the aggregator baseline above when it qualifies.
      // A spread finding is surfaced as a warning rather than hidden.
      try {
        const ocKey = `${getRpcUrl()}|${quoteToken}`;
        const ocHit = onChainPriceCache.get(ocKey);
        let oc;
        if (ocHit && ocHit.expiresAt > Date.now()) {
          oc = ocHit.result;
        } else {
          const solUsdForDisplay = await getUsdPrice(WSOL_MINT_ADDRESS);
          oc = await getQuoteTokenOnChainPrice({ mint: quoteToken, solUsd: solUsdForDisplay });
          // Cache a price or a spread finding; leave null (nothing usable /
          // read failure) uncached so a transient RPC blip is retried.
          if (oc) onChainPriceCache.set(ocKey, { result: oc, expiresAt: Date.now() + ON_CHAIN_PRICE_TTL_MS });
        }
        if (oc && oc.priceUsd) {
          infoOut.priceUsd = oc.priceUsd.toString();
          infoOut.priceSource = `on-chain:${oc.anchorSymbol}`;
          infoOut.pricePoolId = oc.poolId;
          infoOut.priceLiquidityUsd = Number(oc.liquidityUsd.toString());
          infoOut.pricePoolsQualified = oc.qualifyingCount;
          infoOut.pricePoolsDiscovered = oc.discoveredCount;
        } else if (oc && oc.spreadError) {
          infoOut.priceWarning = oc.spreadError;
        }
      } catch (ocErr) {
        console.warn('quote-token-info: on-chain price lookup failed:', ocErr.message);
      }

      // Try the Raydium CLMM compatibility check + authority audit. If the
      // mint doesn't exist on-chain (or RPC is down) this will throw — in
      // that case we still return what we found from indexers, but mark
      // compat as unknown so the UI doesn't silently let the user pick a
      // token we couldn't verify.
      //
      // Cache hit short-circuit: a mint's compat profile (program owner,
      // Token-2022 extensions, whitelist status, freeze/mint authorities)
      // is immutable-ish on-chain. Authorities CAN be revoked but never
      // re-added, and a token that has had its authorities revoked at
      // some point won't suddenly have them again. So caching is safe.
      const cachedCompat = compatCache.get(quoteToken);
      if (cachedCompat) {
        infoOut.compatible = cachedCompat.compatible;
        infoOut.isToken2022 = cachedCompat.isToken2022;
        infoOut.extensions = cachedCompat.extensions;
        infoOut.disallowedNames = cachedCompat.disallowedNames;
        if (cachedCompat.decimals != null) {
          infoOut.decimals = cachedCompat.decimals;
        }
        // Old cache entries (written by a previous code version that
        // didn't include the authority audit) lack these fields. Treat
        // undefined as "not audited" — same as a fresh-fetch RPC
        // failure — rather than letting the downstream derivation
        // produce !undefined === true (false positive block/warning).
        infoOut.freezeAuthorityDisabled =
          cachedCompat.freezeAuthorityDisabled ?? null;
        infoOut.mintAuthorityRenounced =
          cachedCompat.mintAuthorityRenounced ?? null;
      } else {
        try {
          const connection = new Connection(getRpcConfig().active, 'confirmed');
          const compat = await getMintCompatibilityWithRaydiumClmm(
            connection,
            new PublicKey(quoteToken),
          );
          infoOut.compatible = compat.compatible;
          infoOut.isToken2022 = compat.isToken2022;
          infoOut.extensions = compat.extensions;
          infoOut.disallowedNames = compat.disallowedNames;
          infoOut.freezeAuthorityDisabled = compat.freezeAuthorityDisabled;
          infoOut.mintAuthorityRenounced = compat.mintAuthorityRenounced;
          // If we read decimals from chain and indexers gave us a different
          // number, trust the chain (the chain is the source of truth).
          if (compat.decimals != null) {
            infoOut.decimals = compat.decimals;
          }
          // Cache the success. We only cache successful checks because a
          // failure mode (RPC down, mint not yet on chain) is transient —
          // the user could retry seconds later with a healthy RPC. Caching
          // failures would force users to wait out a TTL after recovery.
          compatCache.set(quoteToken, {
            compatible: compat.compatible,
            isToken2022: compat.isToken2022,
            extensions: compat.extensions,
            disallowedNames: compat.disallowedNames,
            decimals: compat.decimals,
            freezeAuthorityDisabled: compat.freezeAuthorityDisabled,
            mintAuthorityRenounced: compat.mintAuthorityRenounced,
          });
        } catch (e) {
          console.warn('Compat check failed:', e.message);
          infoOut.compatible = null; // null = "unknown", distinct from false
          infoOut.compatError = e.message;
          // We couldn't verify authorities. Don't claim they're safe.
          infoOut.freezeAuthorityDisabled = null;
          infoOut.mintAuthorityRenounced = null;
        }
      }

      // Step 2 Raydium-route probe.
      //
      // Per the price-safety plan's Milestone D: tell the user EARLY
      // (while they're still picking a quote token) whether Raydium can
      // actually route a swap against their choice. If it can't, they
      // should pick a different token — pool creation at Step 5 will
      // hard-fail with a pre_flight error otherwise, but only after
      // they've already invested time and SOL in Steps 3-4.
      //
      // Three possible outcomes, mirrored in the response's
      // raydiumTradeable field:
      //   'yes'      — probe succeeded, route exists. Use the probe-
      //                derived price for display (more truthful than
      //                the aggregator's number).
      //   'no'       — Trade API was reached but returned no route.
      //                Block the user from continuing with this quote.
      //   'unknown'  — couldn't reach Trade API right now. Allow
      //                continuation but warn the user; we'll catch it
      //                again at Step 5.
      //
      // The 3-minute cache absorbs keystroke storms (this endpoint
      // hits per keystroke in the frontend) without disturbing the
      // pool-create-time probe, which always runs fresh regardless.
      const isSafeQuote =
        infoOut.address && KNOWN_SAFE_QUOTES.has(infoOut.address);
      const needsProbe =
        !isSafeQuote &&
        infoOut.address &&
        typeof infoOut.decimals === 'number' &&
        infoOut.decimals >= 0 &&
        infoOut.compatible !== false; // skip if we already know it's not raydium-compatible

      if (isSafeQuote) {
        infoOut.raydiumTradeable = 'yes';
        infoOut.swapRoute = 'raydium';
      } else if (needsProbe) {
        // Cache lookup with TTL check.
        const cachedProbe = step2ProbeCache.get(infoOut.address);
        const now = Date.now();
        if (cachedProbe && cachedProbe.expiresAt > now) {
          // Translate the cache verdict ('tradeable' | 'no-route') into
          // the API contract value ('yes' | 'no' | 'unknown').
          if (cachedProbe.verdict === 'jupiter') {
            // No Raydium route, but the auto-buy routes it through Jupiter.
            infoOut.raydiumTradeable = 'no';
            infoOut.swapRoute = 'jupiter';
            if (cachedProbe.priceUsd) {
              infoOut.priceUsd = cachedProbe.priceUsd;
              infoOut.priceSource = 'jupiter-probe (cached)';
            }
          } else if (cachedProbe.verdict === 'tradeable') {
            infoOut.raydiumTradeable = 'yes';
            infoOut.swapRoute = 'raydium';
            if (cachedProbe.priceUsd) {
              // Prefer the probe-derived price over the aggregator price.
              // The probe IS the price the pool will be created at later;
              // showing it here means the user sees the same number
              // throughout the flow.
              infoOut.priceUsd = cachedProbe.priceUsd;
              infoOut.priceSource = 'raydium-probe (cached)';
            }
          } else if (cachedProbe.verdict === 'no-route') {
            infoOut.raydiumTradeable = 'no';
            infoOut.swapRoute = 'none';
          } else {
            // Future-proof: unknown verdict in cache → treat as unknown
            // and force a fresh probe by not short-circuiting.
            infoOut.raydiumTradeable = 'unknown';
            infoOut.swapRoute = 'unknown';
          }
        } else {
          // Run the probe. We need SOL/USD to convert the probe's
          // SOL→token rate into USD.
          let solUsdForProbe = null;
          try {
            solUsdForProbe = await getUsdPrice(KNOWN_QUOTES.SOL.address);
          } catch (_) { /* silent — handled below */ }

          if (!solUsdForProbe || !solUsdForProbe.gt(0)) {
            // Can't probe without SOL/USD. Mark as unknown but don't
            // cache — the user retrying in a moment may succeed.
            infoOut.raydiumTradeable = 'unknown';
            infoOut.swapRoute = 'unknown';
            infoOut.raydiumProbeError =
              'Could not resolve SOL/USD to run the probe';
          } else {
            try {
              const probeResult = await probeRaydiumPriceStrict({
                quoteMint: infoOut.address,
                quoteDecimals: infoOut.decimals,
                solUsd: solUsdForProbe,
              });
              // Probe succeeded. Cache and update infoOut.
              const priceStr = probeResult.effectiveQuoteUsd.toString();
              step2ProbeCache.set(infoOut.address, {
                verdict: 'tradeable',
                priceUsd: priceStr,
                expiresAt: now + STEP2_PROBE_TTL_MS,
              });
              infoOut.raydiumTradeable = 'yes';
              infoOut.swapRoute = 'raydium';
              infoOut.priceUsd = priceStr;
              infoOut.priceSource = 'raydium-probe';
            } catch (probeErr) {
              const code = probeErr.code || 'UNKNOWN';
              // Raydium has no route: the auto-buy falls back to Jupiter
              // (e.g. PumpSwap-only tokens), so check that before blocking.
              const jupiterRoute = code === 'NO_ROUTE'
                ? await discoverJupiterRoute({
                  quoteMint: infoOut.address,
                  quoteDecimals: infoOut.decimals,
                  solUsd: solUsdForProbe,
                  forceFresh: true,
                }).catch(() => null)
                : null;
              if (jupiterRoute?.available) {
                const priceStr = jupiterRoute.effectiveQuoteUsd.toString();
                step2ProbeCache.set(infoOut.address, {
                  verdict: 'jupiter',
                  priceUsd: priceStr,
                  expiresAt: now + STEP2_PROBE_TTL_MS,
                });
                infoOut.raydiumTradeable = 'no';
                infoOut.swapRoute = 'jupiter';
                infoOut.priceUsd = priceStr;
                infoOut.priceSource = 'jupiter-probe';
              } else if (code === 'NO_ROUTE') {
                // Cache the verdict — the user typing the same mint
                // 10 times in a row shouldn't probe 10 times.
                step2ProbeCache.set(infoOut.address, {
                  verdict: 'no-route',
                  priceUsd: null,
                  expiresAt: now + STEP2_PROBE_TTL_MS,
                });
                infoOut.raydiumTradeable = 'no';
                infoOut.swapRoute = 'none';
                // Raydium has no pool, but we may already have an
                // aggregator price from getTokenMetadata earlier in
                // this function. Label its source so the frontend
                // techLine renders correctly. If priceUsd is null
                // here (no aggregator either), the frontend's
                // no-price warning takes over.
                if (infoOut.priceUsd != null) {
                  infoOut.priceSource = 'oracle';
                }
              } else {
                // Network/HTTP/bad-response errors are transient.
                // Don't cache the failure — let the user retry by
                // re-typing or by refreshing.
                infoOut.raydiumTradeable = 'unknown';
                infoOut.swapRoute = 'unknown';
                infoOut.raydiumProbeError = probeErr.message;
              }
            }
          }
        }
      } else {
        // Couldn't determine decimals or compatibility — can't probe.
        infoOut.raydiumTradeable = 'unknown';
        infoOut.swapRoute = 'unknown';
      }

      // Derive the user-facing block / warning flags from the authority
      // audit, so the frontend can just check one boolean each.
      //
      // freezeAuthorityBlock: a non-null freeze authority on a non-known
      // quote token is a hard block. The deployer can freeze the launch
      // wallet's quote-token balance mid-launch and brick the entire
      // process. Funds would become unrecoverable through normal sweep.
      //
      // mintAuthorityWarning: a non-null mint authority is a soft warning.
      // Supply can be inflated (devaluing pool contents), but the launch
      // itself can still proceed. User should be cautious.
      //
      // For known-safe quotes, both flags are false. For tokens where the
      // authority audit didn't run (RPC down, mint not on-chain), both
      // flags are null — the UI should show "couldn't verify" rather
      // than green-lighting them.
      if (isSafeQuote) {
        infoOut.freezeAuthorityBlock = false;
        infoOut.mintAuthorityWarning = false;
      } else if (infoOut.freezeAuthorityDisabled === null) {
        // Audit didn't run successfully — surface as unknown.
        infoOut.freezeAuthorityBlock = null;
        infoOut.mintAuthorityWarning = null;
      } else {
        infoOut.freezeAuthorityBlock = !infoOut.freezeAuthorityDisabled;
        infoOut.mintAuthorityWarning = !infoOut.mintAuthorityRenounced;
      }
    }

    res.json({ success: true, info: infoOut });
  } catch (error) {
    console.error('Error fetching quote token info:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Estimate funding required for the configured pool/distribution setup.
// Returns SOL + per-quote token amounts the wallet needs.
//
// targetMarketCapUsd is optional. It's only required when at least one
// allocation has bootstrap.mode === 'custom', so that the estimator can
// size the bootstrap quote-side USD value (= bootstrap.supplyPercent ×
// targetMarketCapUsd / 100). All-minimal launches don't need it.
app.post('/api/estimate-lp-funding', async (req, res) => {
  try {
    const {
      allocations,
      targetMarketCapUsd,
      publishLaunchReport,
      airdrop,
    } = req.body;
    if (!Array.isArray(allocations) || allocations.length === 0) {
      throw new Error('allocations must be a non-empty array');
    }
    // Whether to include the launch-report publish cost. Honour an explicit
    // request flag (the live cost preview sends it so the estimate tracks the
    // toggle without a persist race); otherwise fall back to the saved pref.
    const reportEnabled = (typeof publishLaunchReport === 'boolean')
      ? publishLaunchReport
      : (userPrefs.get().publishLaunchReport !== false);
    const classicEstimate = await estimateRequiredFunding({
      allocations,
      targetMarketCapUsd,
      publishLaunchReport: reportEnabled,
      ...(isDemoMode() ? {
        priceOracle: async (mint) => new Decimal(mint === KNOWN_QUOTES.SOL.address ? 200 : 1),
        routeDiscovery: async () => null,
      } : {}),
    });
    const airdropEnabled = airdrop?.enabled === true;
    const requestedAirdropCostSol = airdropEnabled
      ? Math.max(0, Number(airdrop?.executionCostSol) || 0)
      : 0;
    const computedAirdropCostSol = airdropEnabled
      ? estimateAirdropExecutionCostSol(airdrop?.recipientCount)
      : 0;
    const airdropExecutionCostSol = Math.max(requestedAirdropCostSol, computedAirdropCostSol);
    const estimate = {
      ...classicEstimate,
      totalSol: classicEstimate.totalSol + airdropExecutionCostSol,
      subtotalSol: classicEstimate.subtotalSol + airdropExecutionCostSol,
      solLamports: classicEstimate.solLamports + Math.ceil(airdropExecutionCostSol * 1_000_000_000),
      solBreakdown: airdropExecutionCostSol > 0
        ? [
          ...classicEstimate.solBreakdown,
          {
            label: 'Airdrop recipient accounts and transaction fees',
            sol: airdropExecutionCostSol,
          },
        ]
        : classicEstimate.solBreakdown,
      airdropExecutionCostSol,
      includesAirdropExecutionCost: true,
    };
    res.json({ success: true, estimate });
  } catch (error) {
    console.error('Error estimating LP funding:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===========================================================================
// Auto-swap quote tokens: job-and-poll architecture
// ===========================================================================
//
// The acquire-quote-tokens flow runs SOL→token swaps to seed the ephemeral
// wallet with bootstrap quote-side liquidity for non-SOL pools, before
// token/pool creation.
//
// ARCHITECTURE: This used to use Server-Sent Events for live progress
// updates. SSE turned out to be unreliable in our Electron+localhost setup:
// streams would silently disconnect mid-run while the actual swaps continued
// successfully on-chain. The UI would stay stuck on "Swapping…" even though
// the work had landed. After many rounds of band-aids (keepalives, idle
// watchdogs, auto-retries, Nagle tuning, padding bytes), the conclusion was
// that SSE itself was the problem — possibly Chromium fetch+ReadableStream
// buffering, possibly a Node http server quirk, hard to pin down exactly.
//
// So now: a classic job-and-poll design. Three endpoints:
//
//   POST /api/acquire-quote-tokens
//       Body: { tempWalletSecretKey, autoSwapPlan }
//       Returns immediately with { jobId } — the actual work runs in
//       the background. No streaming.
//
//   GET /api/acquire-quote-tokens/:jobId
//       Returns the current state of a job. Frontend polls every 2s.
//
//   DELETE /api/acquire-quote-tokens/:jobId
//       Optional — removes a completed job promptly. Jobs also auto-
//       expire after 10 minutes as a safety net.
//
// Polling is naturally robust against network blips: a failed poll just
// retries on the next interval. No watchdogs, no keepalives, no buffering
// concerns. The downside is per-row update latency goes from "instant" to
// "up to 2 seconds" — a tiny tradeoff for actually-working reliability.
//
// CONCURRENCY: same worker-pool model as before, controlled by the
// AUTOSWAP_CONCURRENCY constant defined at the top of this file (default
// 4). Change the constant and rebuild to tune.
//
// IDEMPOTENT: swapSolForQuote reads the wallet's current quote-token
// balance and only swaps the missing delta. Safe to call repeatedly —
// re-issuing the POST after a previous run's failures will skip rows
// that already have enough balance.

// In-memory job store. Map<jobId, JobState>. Process-lifetime; a server
// restart loses in-flight job state, but the frontend will re-issue the
// POST and start fresh. For the Electron launcher's "one wallet at a
// time" usage pattern, persistence-to-disk would be overkill.
const acquireJobs = new Map();

// Auto-expire completed jobs after 10 minutes so we don't leak memory
// if the frontend forgets to DELETE them. Plenty of time for the user
// to finish the funding step.
const JOB_EXPIRY_MS = 10 * 60 * 1000;

function startAcquireJob({ ownerKeypair, autoSwapPlan, onFinished = null }) {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const job = {
    jobId,
    status: 'running',
    total: autoSwapPlan.length,
    completed: 0,
    results: [],
    pendingMints: autoSwapPlan.map((p) => p.quoteMint),
    inProgressMints: new Set(),
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
  };
  acquireJobs.set(jobId, job);

  // Kick off the work in the background. Don't await — POST returns
  // immediately, work continues in the Node event loop.
  runAcquireJob(job, { ownerKeypair, autoSwapPlan }).catch((err) => {
    // Defensive — runAcquireJob wraps everything internally, but if
    // anything escapes, mark the job done so the frontend stops polling.
    console.error(`[acquire][${jobId}] FATAL unhandled error:`, err);
    job.status = 'done';
    job.finishedAt = Date.now();
    job.error = err.message;
  }).finally(() => {
    // Notify the caller the job is over (success OR failure) so it can
    // release the per-wallet operation lock. Guarded so a callback
    // throw can't surface as an unhandled rejection.
    if (onFinished) {
      try { onFinished(); } catch (_) { /* release is best-effort */ }
    }
  });

  // Schedule cleanup. setTimeout's return value isn't used — we just
  // want the entry gone after the expiry window.
  setTimeout(() => {
    if (acquireJobs.has(jobId)) {
      acquireJobs.delete(jobId);
      console.log(`[acquire][${jobId}] expired and removed from store`);
    }
  }, JOB_EXPIRY_MS);

  return jobId;
}

async function runAcquireJob(job, { ownerKeypair, autoSwapPlan }) {
  const { jobId } = job;
  console.log(
    `[acquire][${jobId}] starting: ${autoSwapPlan.length} item(s), ` +
      `wallet=${ownerKeypair.publicKey.toBase58()}`,
  );

  // Worker-pool size comes from the AUTOSWAP_CONCURRENCY constant defined
  // at the top of this file. Logged here so the user can confirm the
  // value the running build was compiled with.
  console.log(`[acquire][${jobId}] concurrency=${AUTOSWAP_CONCURRENCY}`);
  let nextIndex = 0;

  /**
   * One worker pulls items from the shared queue index until empty.
   * Multiple workers run concurrently, each handling one swap at a time.
   * Failures on one don't affect the others; everyone reports their own
   * result by mutating the shared job object.
   *
   * Node's event loop serializes the mutations (single-threaded JS), so
   * the counter increments and array pushes are safe even with multiple
   * workers running concurrently.
   *
   * Heavily instrumented — these log lines made it possible to diagnose
   * the SSE-era stream-disconnection bugs by reading server output, and
   * they're equally useful for any future issues.
   */
  async function worker(workerId) {
    while (nextIndex < autoSwapPlan.length) {
      const idx = nextIndex++;
      const item = autoSwapPlan[idx];
      const {
        allocationIndex,
        quoteMint,
        quoteSymbol,
        quoteDecimals,
        targetRaw,
        minRaw, // actual bootstrap need; targetRaw is the oversize ambition
        quoteUsd,
        solUsd,
        // sizingMultiplier and estSolSpend let the swap honor the
        // estimator's mode-aware budget. Without these the swap function
        // uses its default 2× sizing and 0.05 SOL hard cap, both of which
        // were sized for dust targets — custom-mode bootstraps get
        // silently floored to ~$10 of acquired quote token.
        sizingMultiplier,
        estSolSpend,
      } = item;

      console.log(
        `[acquire][${jobId}][w${workerId}] picked up ${quoteSymbol} (${quoteMint})`,
      );
      job.inProgressMints.add(quoteMint);
      const t0 = Date.now();

      try {
        // Derive the per-swap SOL cap from the estimator's budget. We
        // give the swap function ~20% headroom over what the estimator
        // budgeted, so the actual swap can complete even if there's
        // minor on-chain drift between estimate and execution time.
        // Default to the legacy 0.05 SOL cap when estSolSpend isn't
        // present (very old plan items from before the estimator added
        // this field).
        const maxSpendLamports = estSolSpend != null
          ? new BN(Math.ceil(Number(estSolSpend) * 1.2 * 1e9))
          : undefined;

        const r = await swapSolForQuote({
          ownerKeypair,
          quoteMint,
          targetRaw: new BN(String(targetRaw)),
          // minRaw is the actual on-chain bootstrap requirement (e.g. $1).
          // Pass it so swapSolForQuote can stop retrying as soon as the
          // minimum is met, rather than chasing the oversize targetRaw
          // (e.g. $2). Falls back to targetRaw if the plan item didn't
          // include minRaw (older callers).
          minRaw: minRaw ? new BN(String(minRaw)) : new BN(String(targetRaw)),
          quoteUsd: new Decimal(quoteUsd),
          solUsd: new Decimal(solUsd),
          quoteDecimals: Number(quoteDecimals),
          // Custom-mode plans send a smaller sizingMultiplier (1.10) to
          // keep the swap-side oversize proportional to the size of the
          // ask. Falls back to undefined (= swapSolForQuote's default 2)
          // when older plans don't include it.
          sizingMultiplier: sizingMultiplier != null
            ? Number(sizingMultiplier)
            : undefined,
          maxSpendLamports,
        });
        const result = {
          allocationIndex,
          quoteMint,
          quoteSymbol,
          success: true,
          txId: r.txId,
          swappedRaw: r.swappedRaw.toString(),
          alreadyHadRaw: r.alreadyHadRaw.toString(),
          finalBalanceRaw: r.finalBalanceRaw.toString(),
        };
        job.results.push(result);
        console.log(
          `[acquire][${jobId}][w${workerId}] ${quoteSymbol} SUCCESS in ` +
            `${Date.now() - t0}ms (tx=${r.txId || 'none'})`,
        );
      } catch (e) {
        console.error(
          `[acquire][${jobId}][w${workerId}] ${quoteSymbol} FAILED in ` +
            `${Date.now() - t0}ms:`,
          e.message,
        );
        const result = {
          allocationIndex,
          quoteMint,
          quoteSymbol,
          success: false,
          error: e.message,
        };
        job.results.push(result);
      }

      // Atomic progress update (Node single-threadedness saves us here).
      job.completed++;
      job.inProgressMints.delete(quoteMint);
      job.pendingMints = job.pendingMints.filter((m) => m !== quoteMint);
    }
    console.log(
      `[acquire][${jobId}][w${workerId}] worker done ` +
        `(nextIndex=${nextIndex}/${autoSwapPlan.length})`,
    );
  }

  const poolSize = Math.min(AUTOSWAP_CONCURRENCY, autoSwapPlan.length);
  console.log(`[acquire][${jobId}] spawning ${poolSize} workers`);
  await Promise.all(
    Array.from({ length: poolSize }, (_, i) => worker(i + 1)),
  );

  job.status = 'done';
  job.finishedAt = Date.now();
  console.log(
    `[acquire][${jobId}] all workers done: ${job.results.length}/${job.total} results ` +
      `in ${((job.finishedAt - job.startedAt) / 1000).toFixed(1)}s`,
  );
}

/**
 * POST endpoint: kick off a new acquire job.
 * Returns immediately with { jobId } — the frontend polls GET for status.
 */
app.post('/api/acquire-quote-tokens', async (req, res) => {
  if (isDemoMode()) {
    // Hand the demo handler the shared job store + expiry so its fake jobs
    // live in the same Map the unchanged GET/DELETE poll endpoints read.
    return demoChainService.handleAcquireQuoteTokens(req, res, {
      acquireJobs,
      jobExpiryMs: JOB_EXPIRY_MS,
    });
  }
  try {
    const { tempWalletSecretKey, autoSwapPlan } = req.body;
    if (!Array.isArray(autoSwapPlan) || autoSwapPlan.length === 0) {
      // No-op case — return a synthetic "already done" job so the
      // frontend doesn't have to special-case empty plans.
      const jobId = `job_${Date.now()}_empty`;
      acquireJobs.set(jobId, {
        jobId,
        status: 'done',
        total: 0,
        completed: 0,
        results: [],
        pendingMints: [],
        inProgressMints: new Set(),
        startedAt: Date.now(),
        finishedAt: Date.now(),
        error: null,
      });
      return res.json({ jobId });
    }
    if (req.body.walletPublicKey
        && rejectIfSecretPinLocked(res, 'acquiring quote tokens with a saved launch wallet')) {
      return;
    }
    const { secretKeyArr, keypair: ownerKeypair } =
      resolveSigner({ tempWalletSecretKey, walletPublicKey: req.body.walletPublicKey });

    // Per-wallet mutex. The acquire job spends the wallet's SOL on swaps
    // in the background — a duplicate job doubles the SOL spent, and an
    // acquire racing a create-lp can drain the SOL the launch budgeted.
    // Unlike the other guarded endpoints, the lock here must outlive the
    // HTTP response (the job runs after we return), so startAcquireJob
    // releases it via onFinished when the job completes.
    const acquireWalletPk = ownerKeypair.publicKey.toBase58();
    if (rejectOrClaimLaunchOp(res, acquireWalletPk, 'acquire-quote-tokens')) {
      return;
    }

    const jobId = startAcquireJob({
      ownerKeypair,
      autoSwapPlan,
      onFinished: () => clearLaunchOpInFlight(acquireWalletPk),
    });
    res.json({ jobId });
  } catch (error) {
    console.error('[acquire] error starting job:', error);
    sendErrorResponse(res, error);
  }
});

/**
 * GET endpoint: poll for status of an in-flight acquire job.
 *
 * Response shape:
 *   {
 *     jobId, status: 'running' | 'done',
 *     total, completed,
 *     results: [{ quoteMint, quoteSymbol, success, txId?, error?, ... }],
 *     pendingMints: [<mint>, ...],     // not yet picked up by a worker
 *     inProgressMints: [<mint>, ...],  // currently being swapped
 *     error: <string> | null,          // only set on fatal job-level errors
 *   }
 *
 * Returns 404 if the jobId isn't in the store (expired or invalid).
 */
app.get('/api/acquire-quote-tokens/:jobId', (req, res) => {
  const job = acquireJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found or expired' });
  }
  // Set isn't JSON-friendly — convert to array for the wire.
  res.json({
    jobId: job.jobId,
    status: job.status,
    total: job.total,
    completed: job.completed,
    results: job.results,
    pendingMints: job.pendingMints,
    inProgressMints: Array.from(job.inProgressMints),
    error: job.error,
  });
});

/**
 * DELETE endpoint: explicitly remove a completed job. Optional —
 * jobs auto-expire after JOB_EXPIRY_MS. Frontend calls this after
 * consuming the final state to free memory promptly.
 */
app.delete('/api/acquire-quote-tokens/:jobId', (req, res) => {
  const existed = acquireJobs.delete(req.params.jobId);
  res.json({ deleted: existed });
});
// Pre-commit dry run of pool creation. Resolves prices, runs the
// just-in-time Raydium probe, applies the drift guard — but does NO
// on-chain action. Powers the Milestone C confirmation modal in the
// frontend: the user sees the actual initialPrice each pool will be
// created at and confirms before the irreversible /api/create-lp call.
//
// Error shape matches /api/create-lp's pre_flight branch so the
// frontend can handle both with the same code path.
app.post('/api/preflight-create-lp', async (req, res) => {
  // Demo: synthetic resolved prices, no RPC, no on-chain mint reads.
  if (isDemoMode()) return demoChainService.handlePreflightCreateLp(req, res);
  try {
    const {
      tokenTotalSupply,
      targetMarketCapUsd,
      allocations,
    } = req.body;

    if (!Array.isArray(allocations) || allocations.length === 0) {
      throw new Error('allocations must be a non-empty array');
    }
    if (!tokenTotalSupply || !targetMarketCapUsd) {
      throw new Error('tokenTotalSupply and targetMarketCapUsd required');
    }

    if (isDemoMode()) {
      const launchedTokenUsd = new Decimal(targetMarketCapUsd).div(tokenTotalSupply);
      const resolvedPrices = allocations.map((allocation, allocationIndex) => {
        const upper = String(allocation.quoteToken || '').toUpperCase();
        const known = KNOWN_QUOTES[upper] || null;
        const quoteUsd = new Decimal(allocation.quoteUsdOverride || (upper === 'SOL' ? 200 : 1));
        return {
          allocationIndex,
          quoteMint: known?.address || allocation.quoteMint || allocation.quoteToken,
          quoteSymbol: allocation.quoteSymbolOverride || known?.symbol || 'DEMO',
          quoteUsd: quoteUsd.toString(),
          source: 'demo-ledger',
          driftPct: 0,
          initialPrice: launchedTokenUsd.div(quoteUsd).toString(),
        };
      });
      return res.json({
        success: true,
        preflight: { resolvedPrices, solUsd: '200', demo: true },
      });
    }

    const result = await preflightCreatePoolsAndPositions({
      tokenTotalSupply,
      targetMarketCapUsd,
      allocations,
    });

    res.json({
      success: true,
      preflight: result,
    });
  } catch (error) {
    // Preflight failures are always pre_flight by definition. Surface
    // them in the same envelope shape that /api/create-lp uses on
    // failure so the frontend's error handler treats both identically.
    const message = launchJournal.errorMessage(error);
    const errorDetails = launchFailureDetails(error, {
      route: 'preflight-create-lp',
      failedPhase: error.failedPhase || 'pre_flight',
      failedAllocationIndex: error.failedAllocationIndex ?? null,
    });
    console.error('Preflight failed:', message);
    res.status(400).json({
      success: false,
      error: message,
      errorDetails,
      failedPhase: error.failedPhase || 'pre_flight',
      failedAllocationIndex: error.failedAllocationIndex ?? null,
      failedAllocation: error.failedAllocation ?? null,
      probeCode: error.probeCode || null,
    });
  }
});


// Run the full LP creation flow: createPool + main positions + bootstrap +
// lock + (optional) recipient transfers, for every allocation.
async function createLpHandler(req, res) {
  if (isDemoMode()) {
    // Derive wallet pubkey here (mirrors what handleCreateLp does
    // internally) so we can scope the progress events to this launch.
    // Safe to swallow errors — if pubkey derivation fails the handler
    // itself will report the same error; the progress just won't track.
    let demoWpk = null;
    try {
      const sk = typeof req.body.tempWalletSecretKey === 'string'
        ? JSON.parse(req.body.tempWalletSecretKey)
        : req.body.tempWalletSecretKey;
      demoWpk = walletPubkeyFromSecretArray(sk);
    } catch (_) { /* leave demoWpk null, hooks become no-ops */ }
    if (demoWpk) lpProgressBegin(demoWpk);
    const hooks = demoWpk
      ? { event: (e) => lpProgressEvent(demoWpk, e) }
      : { event: () => {} };
    try {
      return await demoChainService.handleCreateLp(req, res, {
        lpProgress: hooks,
      });
    } finally {
      if (demoWpk) lpProgressEnd(demoWpk);
    }
  }
  return serveLaunchOperation(res, () => launchServices.createLiquidity(req.body));
}

app.post('/api/create-lp', createLpHandler);

// Resume a partially-completed launch. Used when a previous /api/create-lp
// call failed partway — either in the main-positions phase (Phase 1) or
// the bootstrap phase (Phase 2). Caller passes:
//   - the SAME inputs as create-lp (token mint, supply, allocations, etc)
//   - priorResults: the partialResults array from the failed attempt
// The orchestrator iterates the allocations:
//   - For each allocation whose index is in priorResults with a poolId:
//     skip pool creation, re-fetch bootstrap context from chain. If the
//     prior entry also has a bootstrap populated, Phase 2 skips that too.
//   - For each allocation NOT in priorResults: do the full Phase 1 flow.
// Stateless — server can be restarted between failure and resume without
// affecting recovery, because everything we need lives on chain.
async function resumeLaunchHandler(req, res) {
  if (isDemoMode()) return demoChainService.handleResumeLaunch(req, res);
  return serveLaunchOperation(res, () => launchServices.resumeLiquidity(req.body));
}

app.post('/api/resume-launch', resumeLaunchHandler);

// ---------------------------------------------------------------------------
// Launch diagnostic — paste a token address, see what's on chain
// ---------------------------------------------------------------------------

app.get('/api/diagnose-launch', async (req, res) => {
  try {
    const { tokenMint } = req.query;
    if (!tokenMint) {
      return res.status(400).json({ success: false, error: 'tokenMint query param required' });
    }

    const connection = new Connection(getRpcConfig().active, 'confirmed');
    const CLMM_PROGRAM = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
    const report = { tokenMint, token: {}, pools: [] };

    // 1. Token info
    try {
      const mintPk = new PublicKey(tokenMint);
      const mintInfo = await connection.getAccountInfo(mintPk);
      if (!mintInfo) {
        return res.status(404).json({ success: false, error: 'Token mint not found on chain' });
      }
      report.token.exists = true;
      report.token.owner = mintInfo.owner.toBase58();

      const supply = await connection.getTokenSupply(mintPk);
      report.token.supply = supply.value.uiAmount;
      report.token.decimals = supply.value.decimals;

      if (mintInfo.data.length >= 82) {
        const mintAuthOption = mintInfo.data.readUInt32LE(0);
        report.token.mintAuthority = mintAuthOption === 0 ? null
          : new PublicKey(mintInfo.data.slice(4, 36)).toBase58();
      }
    } catch (e) {
      report.token.error = e.message;
    }

    // 2. Discover pools by deriving pool PDAs for this token paired with SOL.
    //    The CLMM pool PDA seed is based on the sorted mint pair (mintA < mintB)
    //    and the amm config. We try spawning configs that are likely used.
    //    This is more reliable than the Raydium API for freshly-created pools.
    const KNOWN_AMM_CONFIGS = [
      { index: 4,  id: '9iFER3bpjf1PTTCQCfTRu17EJgvsxo9pVyA9QWwEuX4x' },  // 0.01%
      { index: 5,  id: '3XCQJQryqpDvvZBfGxR7CLAw5dpGJ9aa7kt1jRLdyxuZ' },  // 0.05%
      { index: 8,  id: '3h2e43PunVA5K34vwKCLHWhZF4aZpyaC9RmxvshGAQpL' },  // 0.04%
      { index: 3,  id: 'A1BBtTYJd4i3xU8D6Tc2FzU6ZN4oXZWXKZnCxwbHXr8x' },  // 1%
    ];
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const QUOTE_MINTS = [SOL_MINT];  // Could extend with USDC, etc.

    const launchMintPk = new PublicKey(tokenMint);
    const discoveredPools = [];

    for (const quoteMintStr of QUOTE_MINTS) {
      const quoteMintPk = new PublicKey(quoteMintStr);
      // Determine mintA/mintB ordering (CLMM sorts mints)
      const mintA = launchMintPk.toBase58() < quoteMintStr ? launchMintPk : quoteMintPk;
      const mintB = launchMintPk.toBase58() < quoteMintStr ? quoteMintPk : launchMintPk;

      for (const cfg of KNOWN_AMM_CONFIGS) {
        try {
          const ammConfigPk = new PublicKey(cfg.id);
          const [poolPda] = PublicKey.findProgramAddressSync(
            [
              Buffer.from('pool'),
              ammConfigPk.toBuffer(),
              mintA.toBuffer(),
              mintB.toBuffer(),
            ],
            CLMM_PROGRAM
          );
          const poolInfo = await connection.getAccountInfo(poolPda);
          if (poolInfo && poolInfo.owner.equals(CLMM_PROGRAM)) {
            discoveredPools.push({
              id: poolPda.toBase58(),
              config: cfg,
              quoteMint: quoteMintStr,
              quoteSymbol: quoteMintStr === SOL_MINT ? 'SOL' : quoteMintStr.slice(0, 8),
              mintA: mintA.toBase58(),
              mintB: mintB.toBase58(),
            });
            console.log(`  Found pool: ${poolPda.toBase58()} (config ${cfg.index}, quote ${quoteMintStr === SOL_MINT ? 'SOL' : quoteMintStr.slice(0,8)})`);
          }
        } catch {}
      }
    }

    // 3. Per-pool diagnostics
    for (const p of discoveredPools) {
      try {
        const poolId = new PublicKey(p.id);
        const poolInfo = await connection.getAccountInfo(poolId);
        if (!poolInfo || !poolInfo.owner.equals(CLMM_PROGRAM)) continue;

        // Pool already validated during discovery

        const quoteMint = p.quoteMint;
        const quoteSymbol = p.quoteSymbol || '?';

        // Discover position NFTs by scanning the pool's position PDAs.
        // CLMM position NFTs are minted by the program; we find them by
        // checking the user's wallet token accounts (if provided) and
        // verifying each candidate against the CLMM program.
        const positions = [];
        const userWalletParam = req.query.wallet || null;

        if (userWalletParam) {
          // Fast path: scan the user's wallet for position NFTs
          const userPk = new PublicKey(userWalletParam);
          const tokenAccounts = [];
          for (const programAddress of [
            'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
          ]) {
            try {
              const accountsForProgram = await connection.getParsedTokenAccountsByOwner(
                userPk,
                { programId: new PublicKey(programAddress) },
              );
              tokenAccounts.push(...accountsForProgram.value);
            } catch {
              // Some RPC providers disable parsed Token-2022 scans. Keep
              // diagnostics useful with whichever program query succeeded.
            }
          }
          for (const ta of tokenAccounts) {
            const info = ta.account.data.parsed.info;
            // Position NFTs: decimals=0, amount=1
            if (info.tokenAmount.decimals !== 0 || info.tokenAmount.uiAmount !== 1) continue;
            const nftMint = new PublicKey(info.mint);
            // Verify this is a CLMM position by checking if a position PDA exists
            try {
              const [posPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('position'), nftMint.toBuffer()],
                CLMM_PROGRAM
              );
              const posData = await connection.getAccountInfo(posPda);
              if (!posData) continue;


              // Extract position data
              const tickLower = posData.data.readInt32LE(8 + 32 + 32);
              const tickUpper = posData.data.readInt32LE(8 + 32 + 32 + 4);
              const holder = userWalletParam;

              // Check lock status
              let locked = false;
              try {
                const BURN_EARN = new PublicKey('lockC9UHYmzhfPqVX7BGpNrkCWrAVBVpRhb8P6UZ6yX');
                const [lockPda] = PublicKey.findProgramAddressSync(
                  [Buffer.from('lock_position'), BURN_EARN.toBuffer(), nftMint.toBuffer()],
                  BURN_EARN
                );
                locked = !!(await connection.getAccountInfo(lockPda));
              } catch {}

              positions.push({
                nftMint: nftMint.toBase58(),
                holder,
                tickLower,
                tickUpper,
                locked,
              });
            } catch { /* not a CLMM position */ }
          }
        }



        report.pools.push({
          poolId: p.id,
          quoteMint,
          quoteSymbol,
          feeRate: p.config?.index || '?',
          tvl: '0',
          totalPositions: positions.length,
          lockedPositions: positions.filter(po => po.locked).length,
          holders: [...new Set(positions.map(po => po.holder).filter(Boolean))],
          positions,
        });
      } catch (e) {
        console.warn(`Pool ${p.id} diagnostic failed:`, e.message);
      }
    }

    // 4. Summary
    report.summary = {
      poolCount: report.pools.length,
      totalPositions: report.pools.reduce((s, p) => s + p.totalPositions, 0),
      lockedPositions: report.pools.reduce((s, p) => s + p.lockedPositions, 0),
      needsBootstrap: report.pools.some(p => p.totalPositions > 0),
      needsLock: report.pools.some(p => p.lockedPositions < p.totalPositions),
    };

    console.log(
      `Diagnostic for ${tokenMint}: ${report.summary.poolCount} pool(s), ${report.summary.totalPositions} positions`
    );

    res.json({ success: true, report });
  } catch (e) {
    console.error('diagnose-launch error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});



// ---------------------------------------------------------------------------
// Final transfer / sweep
// ---------------------------------------------------------------------------

// Transfer everything from the ephemeral wallet to the user's destination.
//
// ORDER MATTERS HERE. Each token/NFT transfer costs SOL for the tx fee
// (and possibly destination-ATA rent), so SOL has to be swept LAST.
// Otherwise the wallet runs out of lamports partway through and the
// remaining transfers fail with insufficient funds.
//
// Steps:
//   1. NFTs (Fee Keys from locked positions, position NFTs, anything
//      with decimals=0 and amount=1). Token-2022-aware.
//   2. All fungible SPL tokens — the launched token itself AND anything
//      acquired via auto-swap during funding (BITCOIN, USDC, etc.).
//      Previously only the launched token was handled, so anything
//      else got stranded.
//   3. Remaining SOL (last, for the reason above).
//
// Per-asset failures within a step are isolated — a single bad transfer
// doesn't abort the others. Aggregate counts are reported in the
// response so the frontend can summarize.
function validateTransferAirdropPayload(airdrop) {
  if (!airdrop) return;
  if (typeof airdrop !== 'object') {
    throw new Error('Airdrop payload must be an object');
  }

  const recipients = Array.isArray(airdrop.recipients) ? airdrop.recipients : [];
  const expectedCount = Number(airdrop.recipientCount);
  if (Number.isFinite(expectedCount) && expectedCount > 0 && recipients.length !== Math.floor(expectedCount)) {
    throw new Error(
      `Airdrop declares ${Math.floor(expectedCount)} recipient${Math.floor(expectedCount) === 1 ? '' : 's'}, ` +
        `but ${recipients.length} executable row${recipients.length === 1 ? ' is' : 's are'} attached`,
    );
  }
  if (recipients.length === 0) return;

  if (!airdrop.tokenMint) throw new Error('Airdrop token mint is required when recipients are attached');
  try {
    new PublicKey(airdrop.tokenMint);
  } catch {
    throw new Error('Airdrop token mint must be a valid Solana address');
  }
  const tokenDecimals = Number(airdrop.tokenDecimals);
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 18) {
    throw new Error('Airdrop token decimals must be an integer between 0 and 18');
  }

  const seen = new Set();
  recipients.forEach((row, index) => {
    const wallet = String(row?.wallet || '').trim();
    try {
      new PublicKey(wallet);
    } catch {
      throw new Error(`Airdrop recipient ${index + 1}: wallet must be a valid Solana address`);
    }
    if (seen.has(wallet)) {
      throw new Error(`Airdrop recipient ${index + 1}: duplicate wallet ${wallet.slice(0, 8)}...`);
    }
    seen.add(wallet);

    const tokens = Number(row?.tokens ?? row?.amount);
    if (!Number.isFinite(tokens) || tokens <= 0) {
      throw new Error(`Airdrop recipient ${index + 1}: token amount must be greater than 0`);
    }
  });
}

// Launch assets only go to a proven wallet: the one that funded the launch
// wallet (on-chain), or one that signed a Trebuchet challenge. Returns why an
// address is not allowed, or null.
async function unverifiedDestinationReason(address, launchWallet, { funder } = {}) {
  const destination = String(address || '').trim();
  if (!destination) return 'No destination.';
  if (destinationProofStore.isSignedDestination(destination)) return null;
  const fundingWallet = funder !== undefined
    ? funder
    : (await findFundingWallet(launchWallet).catch(() => null))?.funder || null;
  if (fundingWallet && fundingWallet === destination) return null;
  return `${destination} is not verified. Launch assets only go to the wallet that funded the launch wallet, or to a wallet that has signed in Trebuchet.`;
}

async function transferAssetsHandler(req, res) {
  if (isDemoMode()) {
    return demoChainService.handleTransferAssets(req, res, {
      airdropProgress: {
        begin: airdropProgressBegin,
        step: airdropProgressStep,
        end: airdropProgressEnd,
      },
    });
  }
  return serveLaunchOperation(res, () => launchServices.transferAssets(req.body));
}

app.post('/api/transfer-assets', transferAssetsHandler);

// ---------------------------------------------------------------------------
// Airdrop retry — used when /api/transfer-assets returns partial airdrop
// failures and the user clicks the "Retry failed airdrops" button. Takes
// just the failed recipients and re-attempts them.
//
// IMPORTANT timing window: this endpoint is most useful while the
// ephemeral wallet still holds the un-airdropped tokens — that means
// BEFORE the user clicks Transfer Assets a second time (which would
// sweep everything to the destination). The frontend wires the retry
// button to fire before the partial-failure transfer is re-run, and
// the docs in the UI warn that retrying after sweep won't work.
//
// If retry is called after the tokens have been swept, executeAirdrop
// fails with insufficient-balance for every recipient. The response
// makes that condition obvious so the frontend can show a "tokens
// have moved to your destination wallet — distribute manually from
// there" message.
// ---------------------------------------------------------------------------
async function runAirdropHandler(req, res) {
  if (isDemoMode()) {
    return demoChainService.handleRetryAirdrop(req, res, {
      airdropProgress: {
        begin: airdropProgressBegin,
        step: airdropProgressStep,
        end: airdropProgressEnd,
      },
    });
  }
  let walletPublicKey = null;
  let claimedLaunchOp = false;
  try {
    const {
      tempWalletSecretKey,
      tokenMint,
      tokenDecimals,
      isToken2022 = false,
      recipients,
    } = req.body;

    if (!tempWalletSecretKey && !req.body.walletPublicKey) {
      return res.status(400).json({
        success: false,
        error: 'walletPublicKey or tempWalletSecretKey required',
      });
    }
    if (!tokenMint || !Number.isFinite(tokenDecimals)) {
      return res.status(400).json({
        success: false,
        error: 'tokenMint and tokenDecimals required',
      });
    }
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'recipients must be a non-empty array',
      });
    }

    if (req.body.walletPublicKey
        && rejectIfSecretPinLocked(res, 'running an airdrop with a saved launch wallet')) {
      return;
    }
    const { secretKeyArr, walletPublicKey: resolvedWalletPublicKey } =
      resolveSigner({ tempWalletSecretKey, walletPublicKey: req.body.walletPublicKey });
    walletPublicKey = resolvedWalletPublicKey;

    // Per-wallet launch-op mutex: the airdrop moves real tokens and can run
    // for minutes (no recipient cap). Claiming the same mutex the other
    // launch ops use means a journal resume or a transfer click can't start
    // sweeping or locking out from under a running airdrop — and vice
    // versa: this rejects if a create/resume/transfer is mid-flight.
    if (rejectOrClaimLaunchOp(res, walletPublicKey, 'run-airdrop')) {
      return;
    }
    claimedLaunchOp = true;

    // Concurrency guard. Same reasoning as in /api/transfer-assets: a
    // second concurrent airdrop run could double-pay recipients whose
    // first-pass tx already landed. The retry path is especially
    // vulnerable because the user is more likely to click the retry
    // button impatiently than the main Transfer button.
    if (airdropInFlight(walletPublicKey)) {
      console.warn(
        `Rejecting concurrent airdrop retry for wallet ${walletPublicKey} `
        + `— another airdrop is already in flight.`,
      );
      return res.status(409).json({
        success: false,
        error: 'Another airdrop is already running for this launch wallet. '
          + 'Wait for it to complete before retrying.',
      });
    }
    markAirdropInFlight(walletPublicKey);
    airdropProgressBegin(walletPublicKey, recipients.length);

    // Same per-recipient idempotency as the transfer-assets airdrop step:
    // drop any wallets the journal already records as delivered, so a
    // retry can never double-pay (e.g. a stale retry click after a
    // successful re-transfer already covered the failed rows).
    const priorAirdrop = launchJournal.activeForWallet(walletPublicKey)?.airdrop || null;
    const priorDelivered = Array.isArray(priorAirdrop?.transferred)
      ? priorAirdrop.transferred
      : [];
    const deliveredWallets = new Set(priorDelivered.map((t) => t.wallet));
    const pendingRecipients = recipients.filter((r) => !deliveredWallets.has(r.wallet));
    if (pendingRecipients.length < recipients.length) {
      console.log(
        `Airdrop retry-safety: ${recipients.length - pendingRecipients.length} `
        + `recipient(s) already delivered per journal — skipping them.`,
      );
    }

    console.log(`Retrying airdrop to ${pendingRecipients.length} recipient(s)`);
    let airdropResult;
    if (pendingRecipients.length === 0) {
      clearAirdropInFlight(walletPublicKey);
      airdropProgressEnd(walletPublicKey);
      airdropResult = { transferred: [], failed: [] };
    } else {
      try {
        airdropResult = await executeAirdrop({
          tempWalletSecretKey: secretKeyArr,
          tokenMint,
          tokenDecimals,
          isToken2022,
          recipients: pendingRecipients,
          onProgress: (s) => airdropProgressStep(walletPublicKey, s),
        });
      } finally {
        clearAirdropInFlight(walletPublicKey);
        airdropProgressEnd(walletPublicKey);
      }
    }
    console.log(
      `Retry summary: ${airdropResult.transferred.length} delivered, `
      + `${airdropResult.failed.length} still failed`,
    );

    // Merge the retry outcome into the journal's persistent airdrop record:
    // newly-delivered wallets join transferred; the failed list is rebuilt
    // from this attempt's failures plus any prior failures NOT retried in
    // this call (the frontend usually retries the full failed set, but a
    // partial retry shouldn't erase the record of the rows it skipped).
    const retriedWallets = new Set(pendingRecipients.map((r) => r.wallet));
    const newlyDeliveredWallets = new Set(airdropResult.transferred.map((t) => t.wallet));
    const priorFailed = Array.isArray(priorAirdrop?.failed) ? priorAirdrop.failed : [];
    const mergedAirdrop = {
      transferred: [...priorDelivered, ...airdropResult.transferred],
      failed: [
        ...priorFailed.filter(
          (f) => !retriedWallets.has(f.wallet) && !newlyDeliveredWallets.has(f.wallet),
        ),
        ...airdropResult.failed,
      ],
    };

    // Record a retry event in the journal so the launch history shows
    // the recovery attempt, and persist the merged per-recipient record.
    // We don't change the launch's overall status here.
    launchJournal.upsertForWallet(
      walletPublicKey,
      { airdrop: mergedAirdrop },
      {
        stage: 'airdrop_retry',
        retried: pendingRecipients.length,
        delivered: airdropResult.transferred.length,
        stillFailed: airdropResult.failed.length,
      },
    );

    res.json({
      success: true,
      // The merged record, not just this attempt's slice — the frontend
      // replaces lastAirdropResult wholesale with this.
      airdrop: mergedAirdrop,
    });
  } catch (error) {
    console.error('Airdrop retry failed:', error);
    sendErrorResponse(res, error);
  } finally {
    // Release the launch-op mutex no matter how the handler exited. Only
    // when WE claimed it — a 409 from rejectOrClaimLaunchOp means another
    // op holds it and clearing here would release someone else's claim.
    if (claimedLaunchOp && walletPublicKey) {
      clearLaunchOpInFlight(walletPublicKey);
    }
  }
}

// First-pass airdrop (step 6a of the transfer flow) and the retry button
// share this handler — both are "send to every recipient not yet marked
// delivered in the journal". The two routes exist so the frontend code
// reads honestly at each call site.
app.post('/api/run-airdrop', runAirdropHandler);
app.post('/api/retry-airdrop', runAirdropHandler);

// ---------------------------------------------------------------------------
// Recovery cache for temporary wallets.
//
// /api/launch-journals returns non-secret per-launch journals. These are
// separate from pending wallets: journals explain what happened on-chain,
// while pending wallets provide the secret material needed for manual
// recovery.
//
// /api/pending-wallets returns any wallet keys that were generated for a
// launch but never confirmed-cleaned-up — typically because the app
// crashed or the user closed it before reaching Step 6. The frontend
// shows these at the top of the page so the user can copy the secret
// key out and recover any funds manually.
//
// /api/pending-wallets/dismiss is the manual "Discard" action. It
// removes a cache entry without doing any on-chain verification — it's
// the user's explicit acknowledgement that they don't need recovery.
// ---------------------------------------------------------------------------

app.get('/api/launch-journals', (req, res) => {
  try {
    const includeCompleted = req.query.includeCompleted === '1';
    const includeArchived = req.query.includeArchived === '1';
    const journals = launchJournal.list({ includeCompleted, includeArchived });
    res.json({ success: true, journals });
  } catch (error) {
    console.error('Error listing launch journals:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/launch-journals/resume', async (req, res) => {
  // In demo mode the journals panel still lists real, disk-backed launches.
  // Resuming one would send real transactions — exactly what the demo banner
  // promises won't happen. Refuse with a clear message rather than either
  // sending real transactions or faking a success on real launch data.
  if (isDemoMode()) {
    return res.status(409).json({
      success: false,
      error: 'Demo mode is active — disable demo mode (top banner) to resume a real launch.',
    });
  }
  let walletPublicKey = null;
  let priorResultsForFailure = [];
  try {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ success: false, error: 'id required' });
    }

    const journal = launchJournal.get(id);
    if (!journal) {
      return res.status(404).json({ success: false, error: 'launch journal not found' });
    }
    if (journal.status === 'completed' || journal.status === 'archived') {
      return res.status(400).json({
        success: false,
        error: `cannot resume ${journal.status} launch journal`,
      });
    }

    walletPublicKey = journal.walletPublicKey;
    if (walletPublicKey
        && rejectIfSecretPinLocked(res, 'resuming a launch journal with a saved wallet')) {
      return;
    }
    const wallet = pendingWallets.get(walletPublicKey);
    if (!wallet || !Array.isArray(wallet.secretKey)) {
      return res.status(409).json({
        success: false,
        error:
          'matching recoverable wallet secret is unavailable. Import or sweep the launch wallet manually from the pending-wallet entry.',
      });
    }

    const poolPlan = journal.poolPlan || {};
    const token = journal.token || {};
    const tokenMint = poolPlan.tokenMint || token.mint;
    const tokenDecimals = poolPlan.tokenDecimals || token.decimals || 9;
    const tokenTotalSupply = poolPlan.tokenTotalSupply || token.totalSupply;
    const {
      targetMarketCapUsd,
      allocations,
    } = poolPlan;
    const lockPositions = poolPlan.lockPositions !== false;

    if (!tokenMint || !tokenTotalSupply || !targetMarketCapUsd || !Array.isArray(allocations)) {
      return res.status(400).json({
        success: false,
        error: 'launch journal is missing the token or pool plan needed to resume',
      });
    }

    if (await rejectIfTokenIncompleteForLiquidity(res, {
      tokenMint,
      tokenTotalSupply,
      tokenDecimals,
    })) return;

    const priorResults = priorResultsFromJournal(journal);
    priorResultsForFailure = priorResults;
    if (hasCompletedLpResults(journal)) {
      launchJournal.upsertForWallet(
        walletPublicKey,
        {
          status: 'active',
          stage: journal.stage,
          error: null,
          errorDetails: null,
          lp: { partialResults: null },
        },
        {
          stage: 'lp_recovered_for_transfer',
          poolCount: priorResults.length,
          source: 'launch_journal',
        },
      );
      return res.json({ success: true, recovered: true, results: priorResults });
    }

    const phase1Recovery = materializePhase1RecoveryResults(
      journal,
      priorResults,
      allocations,
    );
    let effectivePriorResults = mergePriorResults(priorResults, phase1Recovery.recoveredResults);
    priorResultsForFailure = effectivePriorResults;
    if (phase1Recovery.blockedEvents.length > 0) {
      const pools = phase1Recovery.blockedEvents.map((event) => event.poolId).filter(Boolean).join(', ');
      const message =
        'This journal recorded ambiguous partial pool state that Trebuchet cannot safely ' +
        'resume automatically without risking duplicate or skipped LP work. ' +
        `Recover or sweep the launch wallet manually${pools ? `; recorded pool(s): ${pools}` : ''}.`;
      const errorDetails = {
        code: 'UNSAFE_PARTIAL_POOL_STATE',
        route: 'launch-journals/resume',
        failedPhase: 'main_positions',
        priorResultCount: effectivePriorResults.length,
        unsafePoolEvents: phase1Recovery.blockedEvents,
        source: 'launch_journal',
      };
      launchJournal.upsertForWallet(
        walletPublicKey,
        {
          status: 'failed',
          stage: 'lp_main_positions_failed',
          error: message,
          errorDetails,
          lp: {
            priorResults: effectivePriorResults,
            failedPhase: 'main_positions',
          },
        },
        {
          stage: 'lp_resume_blocked_unsafe_partial',
          error: message,
          errorDetails,
          failedPhase: 'main_positions',
          priorResultCount: effectivePriorResults.length,
          unsafePoolEventCount: phase1Recovery.blockedEvents.length,
          source: 'launch_journal',
        },
      );
      return res.status(409).json({
        success: false,
        code: 'UNSAFE_PARTIAL_POOL_STATE',
        manualRecoveryRequired: true,
        failedPhase: 'main_positions',
        partialResults: effectivePriorResults,
        error: message,
        errorDetails,
        unsafePoolEvents: phase1Recovery.blockedEvents,
      });
    }
    if (phase1Recovery.recoveredResults.length > 0) {
      launchJournal.upsertForWallet(
        walletPublicKey,
        {
          lp: {
            partialResults: effectivePriorResults,
            priorResults: effectivePriorResults,
          },
        },
        {
          stage: 'lp_phase1_recovery_prepared',
          recoveredAllocationCount: phase1Recovery.recoveredResults.length,
          priorResultCount: effectivePriorResults.length,
          source: 'launch_journal',
        },
      );
    }

    launchJournal.upsertForWallet(
      walletPublicKey,
      {
        status: 'active',
        stage: 'lp_resume_started',
        error: null,
        errorDetails: null,
        poolPlan: {
          tokenMint,
          tokenDecimals,
          tokenTotalSupply,
          targetMarketCapUsd,
          allocations,
          lockPositions,
        },
        lp: phase1Recovery.recoveredResults.length > 0
          ? { priorResults: effectivePriorResults, partialResults: effectivePriorResults }
          : { priorResults: effectivePriorResults },
      },
      {
        stage: 'lp_resume_started',
        tokenMint,
        priorResultCount: effectivePriorResults.length,
        allocationCount: allocations.length,
        phase1RecoveryCount: phase1Recovery.recoveredResults.length,
        source: 'launch_journal',
      },
    );

    // Journal-resume needs its own progress tracker init too. Even though
    // the recovery panel triggered this (not the active create-lp UI),
    // the frontend phase progress tree is rebuilt on resume and will
    // poll for events the same way.
    lpProgressBegin(walletPublicKey);

    const result = await createPoolsAndPositions({
      tempWalletSecretKey: wallet.secretKey,
      tokenMint,
      tokenDecimals,
      tokenTotalSupply,
      targetMarketCapUsd,
      allocations,
      lockPositions,
      priorResults: effectivePriorResults,
      onProgress: (event) => {
        recordLpJournalProgress(walletPublicKey, event);
        try { lpProgressEvent(walletPublicKey, event); }
        catch (_) { /* same — progress is best-effort */ }
      },
    });

    launchJournal.upsertForWallet(
      walletPublicKey,
      {
        status: 'active',
        stage: 'lp_created',
        error: null,
        errorDetails: null,
        lp: {
          results: result.results || [],
          partialResults: null,
          failedPhase: null,
          failedAllocationIndex: null,
          bootstrapFailures: null,
          lockFailures: null,
          transferFailures: null,
        },
      },
      { stage: 'lp_created', poolCount: result.results?.length || 0 },
    );

    res.json({ success: true, ...result });
  } catch (error) {
    const partialResults = Array.isArray(error.partialResults)
      ? error.partialResults
      : priorResultsForFailure;
    const message = launchJournal.errorMessage(error);
    const errorDetails = launchFailureDetails(error, {
      route: 'launch-journals/resume',
      failedPhase: error.failedPhase || 'resume',
      failedAllocationIndex: error.failedAllocationIndex ?? null,
      partialResultCount: partialResults.length,
      source: 'launch_journal',
    });
    console.error('Error resuming launch journal:', error);
    if (walletPublicKey) {
      launchJournal.upsertForWallet(
        walletPublicKey,
        {
          status: 'failed',
          stage: `lp_${error.failedPhase || 'resume'}_failed`,
          error: message,
          errorDetails,
          lp: {
            partialResults,
            failedAllocationIndex: error.failedAllocationIndex,
            failedAllocation: error.failedAllocation,
            failedPhase: error.failedPhase,
            bootstrapFailures: error.bootstrapFailures || null,
            lockFailures: error.lockFailures || null,
            transferFailures: error.transferFailures || null,
          },
        },
        {
          stage: `lp_${error.failedPhase || 'resume'}_failed`,
          error: message,
          errorDetails,
          failedPhase: error.failedPhase,
          partialResultCount: partialResults.length,
          source: 'launch_journal',
        },
      );
    }
    res.status(error.statusCode || 500).json({
      success: false,
      ...(error.code ? { code: error.code } : {}),
      ...(error.code === 'SECRET_PIN_LOCKED' ? { secretPinLocked: true } : {}),
      error: message,
      errorDetails,
      partialResults,
      failedAllocationIndex: error.failedAllocationIndex,
      failedAllocation: error.failedAllocation,
      failedPhase: error.failedPhase,
      bootstrapFailures: error.bootstrapFailures || null,
      lockFailures: error.lockFailures || null,
      transferFailures: error.transferFailures || null,
    });
  } finally {
    // Mirror the create-lp / resume-launch cleanup pattern.
    if (walletPublicKey) {
      try { lpProgressEnd(walletPublicKey); }
      catch (_) { /* end is a best-effort cleanup */ }
    }
  }
});

app.post('/api/launch-journals/dismiss', (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ success: false, error: 'id required' });
    }
    const archived = launchJournal.archive(id);
    res.json({ success: true, archived });
  } catch (error) {
    console.error('Error dismissing launch journal:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/pending-wallets', (req, res) => {
  try {
    const secretPinLocked = secretStore.isSecretPinLocked();
    // Return metadata only. Secret material is available through the explicit
    // per-wallet reveal endpoint below, so loading the recovery panel no longer
    // decrypts and ships every pending mnemonic/private key to the renderer.
    //
    // Tolerate entries whose decryption failed (e.g. the file was copied from
    // another machine, or the OS keychain rotated): one bad entry must not break
    // the whole panel, so we surface a `decryptionFailed` flag.
    const wallets = pendingWallets.list().map((w) => {
      const hasSecretKey = Array.isArray(w.secretKey);
      const hasMnemonic = typeof w.mnemonic === 'string';
      const out = {
        publicKey: w.publicKey,
        createdAt: w.createdAt,
        hasSecretKey,
        hasMnemonic,
      };
      if (!hasSecretKey && !hasMnemonic) {
        out.decryptionFailed = true;
        if (secretPinLocked) out.secretPinLocked = true;
      }
      return out;
    });
    res.json({ success: true, wallets, secretPinLocked });
  } catch (error) {
    console.error('Error listing pending wallets:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/pending-wallets/reveal', (req, res) => {
  try {
    if (rejectIfSecretPinLocked(res, 'revealing a recovery secret')) {
      return;
    }
    const { publicKey } = req.body;
    if (!publicKey) {
      return res.status(400).json({ success: false, error: 'publicKey required' });
    }

    const wallet = pendingWallets.get(publicKey);
    if (!wallet) {
      return res.status(404).json({ success: false, error: 'pending wallet not found' });
    }

    const out = {
      publicKey: wallet.publicKey,
      createdAt: wallet.createdAt,
    };
    if (Array.isArray(wallet.secretKey)) {
      out.secretKey = wallet.secretKey;
      out.secretKeyB58 = secretKeyToBase58(wallet.secretKey);
    }
    if (typeof wallet.mnemonic === 'string') {
      out.mnemonic = wallet.mnemonic;
    }
    if (!out.secretKey && !out.mnemonic) {
      return res.status(409).json({
        success: false,
        error: 'pending wallet secret could not be decrypted',
        decryptionFailed: true,
      });
    }

    res.json({ success: true, wallet: out });
  } catch (error) {
    console.error('Error revealing pending wallet:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/pending-wallets/dismiss', (req, res) => {
  try {
    const { publicKey } = req.body;
    if (!publicKey) {
      return res.status(400).json({ success: false, error: 'publicKey required' });
    }
    pendingWallets.remove(publicKey);
    res.json({ success: true });
  } catch (error) {
    console.error('Error dismissing pending wallet:', error);
    res.status(500).json({ success: false, error: error.message });

  }
});



// Return recent launch journals for the "Recent Launches" panel.
app.get('/api/recent-launches', (_req, res) => {
  try {
    const journals = launchJournal.list({ includeCompleted: true });
    const launches = journals
      .filter(j => j.status !== 'archived')
      .map(j => ({
        id: j.id,
        walletPublicKey: j.walletPublicKey,
        stage: j.stage || 'wallet_generated',
        createdAt: j.createdAt,
        token: j.token ? {
          name: j.token.name || '',
          symbol: j.token.symbol || '',
          mint: j.token.mint || '',
        } : null,
        lp: j.lp && Array.isArray(j.lp.results)
          ? { poolCount: j.lp.results.length }
          : null,
        transfer: j.transfer ? { destination: j.transfer.destinationWallet || '' } : null,
      }));
    res.json({ success: true, launches });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// ---------------------------------------------------------------------------
// Helpers for the transfer-assets verification step.
// ---------------------------------------------------------------------------

// Derive a base58 public key from the secret-key array the frontend sends.
// We do this here (rather than asking the frontend to send the public key
// separately) because the secret key is the source of truth — pairing it
// with a stale or wrong publicKey would be a recipe for clearing the
// wrong recovery entry.
function walletPubkeyFromSecretArray(secretKeyArr) {
  return Keypair.fromSecretKey(Uint8Array.from(secretKeyArr)).publicKey.toBase58();
}

// F7/F5: single, validated entry point for turning a request into a signer.
// Replaces five hand-rolled copies of the secret-key parse (F7) and is the
// place F5 lands: prefer resolving the wallet's secret SERVER-SIDE from its
// public key, so the ephemeral secret no longer has to round-trip back
// through the renderer on every launch step.
//
// Resolution order:
//   1. walletPublicKey present and found in pendingWallets → use the stored
//      (encrypted-at-rest) secret. This is the real-launch path: the secret
//      was persisted at /api/generate-wallet and never leaves the server.
//   2. otherwise, a secret supplied inline in the request body. This is the
//      demo path: demo wallets live on an in-memory ledger and are
//      deliberately NOT written to the disk-backed recovery store, so the
//      demo client still sends its throwaway secret inline. It's also a
//      back-compat fallback for any caller that hasn't migrated.
//
// A malformed input yields a clear Error (caught by the route try/catch).
// When both a public key and an inline secret arrive, the derived public key
// must match the claimed one — a mismatch means a confused or tampered
// request, so we refuse rather than sign with the wrong key.
function resolveSigner({ tempWalletSecretKey, walletPublicKey } = {}) {
  let secretKeyArr = null;
  let source = null;

  // (1) Prefer the server-side stored secret, keyed by public key.
  if (walletPublicKey) {
    if (secretStore.isSecretPinLocked()) {
      throw secretPinLockedError('using a saved launch wallet');
    }
    const stored = pendingWallets.get(walletPublicKey);
    if (stored && Array.isArray(stored.secretKey)) {
      secretKeyArr = stored.secretKey;
      source = 'store';
    }
  }

  // (2) Fall back to an inline secret (demo / unmigrated caller).
  if (!secretKeyArr && tempWalletSecretKey != null) {
    try {
      secretKeyArr = typeof tempWalletSecretKey === 'string'
        ? JSON.parse(tempWalletSecretKey)
        : tempWalletSecretKey;
      source = 'body';
    } catch (e) {
      throw new Error('tempWalletSecretKey is not valid JSON');
    }
  }

  if (!secretKeyArr) {
    throw new Error(
      'could not resolve a signer: send walletPublicKey for a recoverable '
      + 'wallet, or tempWalletSecretKey inline',
    );
  }
  if (!Array.isArray(secretKeyArr) || secretKeyArr.length !== 64) {
    throw new Error('resolved secret key must be a 64-byte array');
  }
  let keypair;
  try {
    keypair = Keypair.fromSecretKey(Uint8Array.from(secretKeyArr));
  } catch (e) {
    throw new Error('resolved secret key is not a valid ed25519 secret key');
  }
  const derivedPubkey = keypair.publicKey.toBase58();
  if (walletPublicKey && derivedPubkey !== walletPublicKey) {
    throw new Error('walletPublicKey does not match the resolved signer');
  }
  // Surface a one-line warning if a real (store-backed) launch still sent an
  // inline secret — that means a client path hasn't been migrated off the
  // round-trip yet. Demo wallets won't be in the store, so they stay quiet.
  if (source === 'body' && tempWalletSecretKey != null && walletPublicKey
      && pendingWallets.get(walletPublicKey)) {
    console.warn(
      'resolveSigner: inline secret received for a stored wallet; '
      + 'a client path may not be migrated off the secret round-trip (F5).',
    );
  }
  return { secretKeyArr, walletPublicKey: derivedPubkey, keypair };
}

// Encode a secret-key byte array as a base58 string — the format wallet
// apps (Phantom, Solflare, Backpack) display and accept on import.
// We keep the byte-array form as the internal/storage representation
// (it's what @solana/web3.js wants for signing) but expose this form on
// API boundaries where a human might end up looking at or copying it.
function secretKeyToBase58(secretKeyArr) {
  return bs58.encode(Uint8Array.from(secretKeyArr));
}

// ---------------------------------------------------------------------------
// Misc / safety endpoints (unchanged from original)
// ---------------------------------------------------------------------------

// Identify the wallet that funded this temp wallet. Returns the funder's
// address by looking at the OLDEST transaction in the wallet's history (which,
// for our freshly-generated wallets, is necessarily the funding tx). This is
// shown to the user as a SUGGESTION for the destination wallet, not a source
// of truth — the user must always confirm the full address before transfer.
app.post('/api/find-funder', async (req, res) => {
  if (isDemoMode()) return demoChainService.handleFindFunder(req, res);
  try {
    const { publicKey } = req.body;
    const result = await findFundingWallet(publicKey);
    res.json({ success: true, result });
  } catch (error) {
    console.error('Error finding funder:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.locals.runtimeBusy = () => launchOpsInFlight.size > 0
  || airdropsInFlight.size > 0
  || [...acquireJobs.values()].some((job) => job.status === 'running');
return app;
}

// ---------------------------------------------------------------------------
// Local API lifecycle
// ---------------------------------------------------------------------------

// Bind explicitly to 127.0.0.1 rather than all interfaces. Without the
// host argument, Node binds to 0.0.0.0 and the API would be reachable
// from anything on the local network (other machines on the LAN, a
// guest device on the same wifi, etc). This is a desktop app — only
// the Electron renderer on this machine should ever reach the API.
//
// Note: this loopback bind plus the Host header allowlist above are
// the two together. The bind kills network-reachable access; the
// Host check kills the DNS-rebinding-through-the-user's-browser path
// that survives a loopback bind.
function logLocalApiStartup(port) {
  const cfg = getRpcConfig();
  const active = cfg.saved.find((r) => r.url === cfg.active);
  console.log(`[boot] PORT = ${port}`);
  console.log(`Server running on http://127.0.0.1:${port}`);
  console.log(`Active RPC: ${redactSensitiveText(active ? active.name : '(unnamed)')} — ${redactUrl(cfg.active)}`);
  console.log(`Saved RPCs: ${cfg.saved.length} (manage in the UI)`);
  console.log('\nIMPORTANT: For pool creation, use a dedicated RPC (Helius, Triton, QuickNode — free tier is plenty).');
  console.log('Free public RPC endpoints will rate-limit you out of CLMM creation.\n');

  // Probe vanity availability and warm the cache so the first
  // /api/demo/status call doesn't pay the cold-import latency. Async
  // because the module import is dynamic; logs land a few ms after
  // the startup banner above.
  vanityAvailability().then((v) => {
    if (v.available) {
      console.log(`Vanity address generation: available (${v.path})`);
    } else {
      console.log('Vanity address generation: DISABLED');
      console.log('  Reason: vanity_keygen binary not built.');
      console.log('  To enable: run `npm run build:c` (requires gcc or clang).');
      console.log('  End-user release builds include this binary; this only affects dev environments.\n');
    }
  });
}

export function createLocalApiServer({
  application = null,
  host = '127.0.0.1',
  port = Number(process.env.PORT || 3000),
  onStarted = logLocalApiStartup,
  onStopped = () => {},
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('Local API port must be an integer from 0 to 65535');
  }
  if (host !== '127.0.0.1') {
    throw new TypeError('Trebuchet Local API must bind to 127.0.0.1');
  }
  if (application && typeof application.listen !== 'function') {
    throw new TypeError('Local API application must provide listen(port, host, callback)');
  }
  if (typeof onStarted !== 'function' || typeof onStopped !== 'function') {
    throw new TypeError('Local API lifecycle hooks must be functions');
  }

  let localApplication = application;
  let httpServer = null;
  let startPromise = null;
  let stopPromise = null;
  let owner = null;
  let control = null;

  const runtime = Object.freeze({
    get application() { return localApplication; },
    get server() { return httpServer; },
    get address() {
      const bound = httpServer?.address();
      if (!bound || typeof bound === 'string') return null;
      return { host, port: bound.port, url: `http://${host}:${bound.port}` };
    },
    start() {
      if (stopPromise) return stopPromise.then(() => runtime.start());
      if (httpServer?.listening) return Promise.resolve(runtime.address);
      if (startPromise) return startPromise;
      startPromise = Promise.resolve().then(async () => {
        // Production hosts acquire ownership before constructing any routes.
        // An injected listener supports lifecycle tests without profile I/O.
        if (!application) {
          owner = acquireProfileOwner(process.env.TREBUCHET_CONFIG_DIR || __dirname);
          control = createRuntimeControl({ owner, stop: () => runtime.stop(), isBusy: () => localApplication?.locals?.runtimeBusy?.() === true });
          localApplication = createLocalApiApp({ runtimeControl: control, runtimeOwner: owner });
        }
        try {
          const address = await new Promise((resolve, reject) => {
            const candidate = localApplication.listen(port, host, () => {
              httpServer = candidate;
              resolve(runtime.address);
            });
            candidate.once('error', reject);
            httpServer = candidate;
          });
          owner?.publish(address.port);
          onStarted(address.port);
          return address;
        } catch (error) {
          if (httpServer?.listening) await new Promise((resolve) => httpServer.close(resolve));
          httpServer = null;
          owner?.release();
          owner = null;
          throw error;
        }
      }).catch((error) => {
        // Route construction can fail before the listener starts.
        owner?.release();
        owner = null;
        startPromise = null;
        throw error;
      });
      return startPromise;
    },
    async stop() {
      if (stopPromise) return stopPromise;
      if (startPromise) await startPromise;
      if (stopPromise) return stopPromise;
      if (control?.busy()) throw Object.assign(new Error('The runtime has active work. Retry after it finishes.'), { code: 'RUNTIME_BUSY' });
      const current = httpServer;
      if (!current) return;
      stopPromise = (async () => {
        await new Promise((resolve, reject) => {
          current.close((error) => error ? reject(error) : resolve());
          current.closeAllConnections?.();
        });
        httpServer = null;
        startPromise = null;
        owner?.release();
        owner = null;
        control = null;
        onStopped();
      })();
      try { await stopPromise; } finally { stopPromise = null; }
    },
  });
  return runtime;
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectRun) {
  const localApi = createLocalApiServer({ onStopped: () => process.exit(0) });
  try { await localApi.start(); } catch (error) {
    console.error(error.code || 'RUNTIME_START_FAILED', error.message);
    process.exitCode = 1;
  }
}
