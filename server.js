import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import {
  createTokenWithMetaplex,
  generateTemporaryWallet,
  getWalletQRCode,
  checkWalletBalance,
  findFundingWallet,
  refreshConnection as refreshTokenServiceConnection,
} from './tokenService.js';

import {
  createPoolsAndPositions,
  estimateRequiredFunding,
  getUsdPrice,
  getTokenMetadata,
  getClmmFeeTiers,
  getMintCompatibilityWithRaydiumClmm,
  KNOWN_QUOTES,
} from './lpService.js';

import { swapSolForQuote } from './swapService.js';

import {
  checkWalletBalanceMultiToken,
  sweepNftsToDestination,
  sweepAllTokensToDestination,
  sweepSolToDestination,
} from './walletHelpers.js';

import {
  getConfig as getRpcConfig,
  setActiveRpc,
  addSavedRpc,
  removeSavedRpc,
  testRpc,
} from './rpcConfig.js';

import * as pendingWallets from './pendingWallets.js';
import {
  Keypair,
  PublicKey,
} from '@solana/web3.js';
import bs58 from 'bs58';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import {
  normalizeTokenDescription,
  normalizeLogoImageMime,
  normalizeTokenName,
  normalizeTokenSymbol,
  normalizeWholeTokenSupply,
} from './validators.js';
import { isWalletEffectivelyEmpty } from './walletRecovery.js';

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
    msg = args
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

// Monkey-patch the global console. Save the originals so we can still
// write to the real stdout/stderr (useful when running from a terminal
// in dev mode). _captureLog is wrapped in try/catch so a capture failure
// can't break the original log emission.
const _origConsoleLog = console.log.bind(console);
const _origConsoleWarn = console.warn.bind(console);
const _origConsoleError = console.error.bind(console);
console.log = (...args) => {
  try { _captureLog('info', args); } catch (_) { /* ignore */ }
  _origConsoleLog(...args);
};
console.warn = (...args) => {
  try { _captureLog('warn', args); } catch (_) { /* ignore */ }
  _origConsoleWarn(...args);
};
console.error = (...args) => {
  try { _captureLog('error', args); } catch (_) { /* ignore */ }
  _origConsoleError(...args);
};

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

const app = express();
const PORT = process.env.PORT || 3000;
const API_SESSION_TOKEN = crypto.randomBytes(32).toString('base64url');
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// Boot-time log: confirms which config values the server is actually
// using on this launch. Streams to the in-app activity log via the
// console-capture wiring above.
console.log(`[boot] AUTOSWAP_CONCURRENCY = ${AUTOSWAP_CONCURRENCY}`);
console.log(`[boot] PORT = ${PORT}`);
console.log('[boot] RPC endpoint: configured via in-app RPC settings');

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 }, // 100KB Arweave free-tier limit
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'image/png' || file.mimetype === 'image/jpeg') {
      cb(null, true);
      return;
    }
    cb(new Error('Logo must be a PNG or JPG image'));
  },
});

// ---------------------------------------------------------------------------
// Host header allowlist — DNS rebinding defense.
//
// The server binds to 127.0.0.1 (see app.listen at the bottom of this file)
// so externally-routed traffic from the LAN or internet can't reach us. But
// there's a subtler attack class that survives a loopback bind: DNS
// rebinding. The scenario:
//
//   1. The user has any browser open (Chrome, Firefox, Safari, Edge) —
//      NOT the Trebuchet Electron window, just normal web browsing.
//   2. The user visits attacker.com, or sees a malicious iframe/ad on
//      an otherwise innocent page.
//   3. attacker.com's JavaScript manipulates its own DNS so that the
//      domain resolves to 127.0.0.1 mid-session.
//   4. The attacker's JS, still thinking it's same-origin with
//      attacker.com, does fetch('http://attacker.com:<port>/api/...').
//      The TCP connection lands on our server here.
//   5. With wildcard CORS and no Host check, we'd happily serve it —
//      including /api/pending-wallets, which returns secret keys.
//
// The browser's same-origin policy can't protect us, because the
// attacker's JS thinks it really IS same-origin with attacker.com.
// What DOES protect us: the Host header. The browser sends
// `Host: attacker.com:<port>` (whatever domain the JS believes it's
// talking to), not `Host: 127.0.0.1:<port>`. The Host header is one
// of the few things the browser, not the page, controls — page JS
// cannot forge or override it.
//
// So we reject any request whose Host header doesn't claim to be
// 127.0.0.1 or localhost. Legitimate requests from the Trebuchet
// renderer (which loads from http://127.0.0.1:<port>) always have the
// right Host header. DNS-rebound requests never do.
//
// This middleware is registered first, before the body parser, so a
// rejected request never has its body read into memory.
// ---------------------------------------------------------------------------
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost']);

app.use((req, res, next) => {
  const hostHeader = req.headers.host || '';
  // Host header format is "hostname" or "hostname:port". Strip the
  // port for the allowlist check — we don't care which port the
  // client believes it's talking to (the connection wouldn't have
  // reached us if it weren't on our actual port), only the hostname.
  const hostname = hostHeader.split(':')[0];
  if (!ALLOWED_HOSTS.has(hostname)) {
    console.warn(
      `Rejected request with disallowed Host header: ${hostHeader} ` +
      `${req.method} ${req.url}`,
    );
    return res
      .status(403)
      .json({ success: false, error: 'invalid Host header' });
  }
  next();
});

app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

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

app.use('/api', (req, res, next) => {
  if (req.path === '/session') return next();
  const token = req.get('x-trebuchet-session');
  if (token !== API_SESSION_TOKEN) {
    return res
      .status(403)
      .json({ success: false, error: 'invalid API session' });
  }
  next();
});

app.use(express.json({ limit: '5mb' }));

// Resolve the public/ directory's path on disk. Two cases:
//
//   - Dev / web mode: __dirname is just the source directory. The
//     join below produces a regular filesystem path.
//
//   - Packaged Electron: server.js is bundled inside resources/app.asar.
//     fs operations against asar-internal paths get redirected to
//     app.asar.unpacked when the file is in our asarUnpack allow-list,
//     but Express's static middleware uses fs.createReadStream for
//     streaming and that doesn't reliably get the redirect — files
//     served via streaming would 404 even though stat says they exist.
//     Fix: rewrite the path to point at app.asar.unpacked directly.
//     The detection finds "\app.asar" (or "/app.asar" on Unix) and
//     verifies what follows is end-of-string or another separator
//     (so we don't false-match a hypothetical "app.asarx" component).
function resolvePublicDir() {
  const marker = `${path.sep}app.asar`;
  const idx = __dirname.indexOf(marker);
  if (idx === -1) {
    return path.join(__dirname, 'public');
  }
  const after = __dirname[idx + marker.length];
  if (after !== undefined && after !== path.sep) {
    return path.join(__dirname, 'public');
  }
  const rewritten =
    __dirname.slice(0, idx) +
    `${path.sep}app.asar.unpacked` +
    __dirname.slice(idx + marker.length);
  return path.join(rewritten, 'public');
}
const publicDir = resolvePublicDir();

app.use(express.static(publicDir));

// Routes
app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Diagnostic endpoint for the splash-video 404 problem. Reports what
// server.js sees on disk: the resolved public/ path, whether it exists,
// what's inside it, and whether intro.mp4 specifically is readable.
// Useful for narrowing down whether a 404 on /intro.mp4 is "server
// can't find the file" vs "file exists but isn't being served for
// some other reason." Hit this from DevTools:
//
//   fetch('/api/_splash-debug').then(r => r.json()).then(console.log)
//
// Safe to ship — only reads its own directory, no user data exposed.
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

// ---------------------------------------------------------------------------
// Wallet endpoints
// ---------------------------------------------------------------------------

app.post('/api/generate-wallet', async (req, res) => {
  try {
    console.log('Generating temporary wallet...');
    const walletInfo = await generateTemporaryWallet();
    const qrCode = await getWalletQRCode(walletInfo.publicKey);

    // Stash the key on disk so the user can recover the wallet if the
    // app crashes or is closed mid-launch. The entry is removed by
    // /api/transfer-assets once the wallet is verified on-chain empty.
    pendingWallets.add(walletInfo.publicKey, walletInfo.secretKey, walletInfo.mnemonic);

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
    res.status(500).json({ success: false, error: error.message });
  }
});

// SOL-only balance (kept for backwards compatibility / Step 1 display)
app.post('/api/check-balance', async (req, res) => {
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
  try {
    const { publicKey } = req.body;
    const balance = await checkWalletBalanceMultiToken(publicKey);
    res.json({ success: true, balance });
  } catch (error) {
    console.error('Error checking detailed balance:', error);
    res.status(500).json({ success: false, error: error.message });
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

// Lightweight RPC health check — sends a getVersion JSON-RPC call and
// reports back the version + latency. Used by the "Test" button in the UI
// before saving a new endpoint.
app.post('/api/rpc-config/test', async (req, res) => {
  const result = await testRpc(req.body.url);
  res.json({ success: true, result });
});

// ---------------------------------------------------------------------------
// Token creation
// ---------------------------------------------------------------------------

function uploadLogo(req, res, next) {
  upload.single('logo')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    if (req.file) {
      try {
        req.file.detectedMime = normalizeLogoImageMime(req.file.buffer);
      } catch (logoError) {
        return res.status(400).json({ success: false, error: logoError.message });
      }
    }
    next();
  });
}

app.post('/api/create-token', uploadLogo, async (req, res) => {
  try {
    const {
      tempWalletSecretKey,
      name,
      symbol,
      description,
      totalSupply,
      quoteMints: quoteMintsRaw,
    } = req.body;
    const normalizedName = normalizeTokenName(name);
    const normalizedSymbol = normalizeTokenSymbol(symbol);
    const normalizedDescription = normalizeTokenDescription(description);
    const normalizedTotalSupply = normalizeWholeTokenSupply(totalSupply, 9);
    console.log('Creating token:', {
      name: normalizedName,
      symbol: normalizedSymbol,
      totalSupply: normalizedTotalSupply,
    });

    // Quote mints come over as a JSON-encoded string in the FormData. Parse
    // and validate them before they influence the mintA keypair search.
    let quoteMints = [];
    try {
      const parsed = quoteMintsRaw ? JSON.parse(quoteMintsRaw) : [];
      if (Array.isArray(parsed)) {
        quoteMints = parsed
          .filter((m) => typeof m === 'string' && m.length > 0)
          .map((m) => new PublicKey(m).toBase58());
      }
    } catch {
      throw new Error('quoteMints must be a JSON array of valid mint addresses');
    }

    let logoBase64 = null;
    if (req.file) {
      const logoMime = req.file.detectedMime;
      logoBase64 = `data:${logoMime};base64,${req.file.buffer.toString('base64')}`;
    }

    const result = await createTokenWithMetaplex({
      tempWalletSecretKey: JSON.parse(tempWalletSecretKey),
      name: normalizedName,
      symbol: normalizedSymbol,
      description: normalizedDescription,
      totalSupply: normalizedTotalSupply,
      logoBase64,
      quoteMints,
    });

    res.json({
      success: true,
      name: normalizedName,
      symbol: normalizedSymbol,
      totalSupply: normalizedTotalSupply,
      ...result,
    });
  } catch (error) {
    console.error('Error creating token:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

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

// Quote-token info: when the user picks/enters a quote token in the UI,
// we look up its symbol/decimals/USD price for inline display. For known
// quote tokens (SOL/USDC/USDT) we use built-in constants. For arbitrary
// SPL mint addresses we look the metadata up via GeckoTerminal — falling
// back to a truncated address as the symbol if the token isn't indexed
// (in which case the user will need to fill in manual overrides).
app.post('/api/quote-token-info', async (req, res) => {
  try {
    const { quoteToken } = req.body;
    if (!quoteToken) throw new Error('quoteToken required');

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
      infoOut = {
        ...info,
        priceUsd: priceUsd ? priceUsd.toString() : null,
        // Known quotes are all classic SPL Token and definitionally compatible.
        compatible: true,
        isToken2022: false,
        extensions: [],
        disallowedNames: [],
      };
    } else {
      // Arbitrary mint address. tokenInfoService reads decimals + symbol
      // on-chain (always works for any real mint), then tries GeckoTerminal
      // first then Jupiter as a price fallback. priceUsd may still come
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

      // Try the Raydium CLMM compatibility check. If the mint doesn't
      // exist on-chain (or RPC is down) this will throw — in that case
      // we still return what we found from indexers, but mark compat as
      // unknown so the UI doesn't silently let the user pick a token
      // we couldn't verify.
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
        // If we read decimals from chain and indexers gave us a different
        // number, trust the chain (the chain is the source of truth).
        if (compat.decimals != null) {
          infoOut.decimals = compat.decimals;
        }
      } catch (e) {
        console.warn('Compat check failed:', e.message);
        infoOut.compatible = null; // null = "unknown", distinct from false
        infoOut.compatError = e.message;
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
    const { allocations, targetMarketCapUsd } = req.body;
    if (!Array.isArray(allocations) || allocations.length === 0) {
      throw new Error('allocations must be a non-empty array');
    }
    const estimate = await estimateRequiredFunding({
      allocations,
      targetMarketCapUsd,
    });
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

function startAcquireJob({ ownerKeypair, autoSwapPlan }) {
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
    const secretKeyArr =
      typeof tempWalletSecretKey === 'string'
        ? JSON.parse(tempWalletSecretKey)
        : tempWalletSecretKey;
    const ownerKeypair = Keypair.fromSecretKey(Uint8Array.from(secretKeyArr));

    const jobId = startAcquireJob({ ownerKeypair, autoSwapPlan });
    res.json({ jobId });
  } catch (error) {
    console.error('[acquire] error starting job:', error);
    res.status(500).json({ error: error.message });
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


// Run the full LP creation flow: createPool + main positions + bootstrap +
// lock + (optional) recipient transfers, for every allocation.
app.post('/api/create-lp', async (req, res) => {
  try {
    const {
      tempWalletSecretKey,
      tokenMint,
      tokenDecimals,
      tokenTotalSupply,
      targetMarketCapUsd,
      allocations,
      lockPositions,
    } = req.body;

    console.log('Creating LP for token:', tokenMint);
    console.log('Allocations:', JSON.stringify(allocations, null, 2));

    const result = await createPoolsAndPositions({
      tempWalletSecretKey: typeof tempWalletSecretKey === 'string'
        ? JSON.parse(tempWalletSecretKey)
        : tempWalletSecretKey,
      tokenMint,
      tokenDecimals: tokenDecimals || 9,
      tokenTotalSupply,
      targetMarketCapUsd,
      allocations,
      lockPositions: lockPositions !== false,
    });

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error creating LP:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      partialResults: error.partialResults || [],
      failedAllocationIndex: error.failedAllocationIndex,
      failedAllocation: error.failedAllocation,
      // 'pre_flight', 'main_positions', 'bootstrap', 'locks', or 'transfers' —
      // tells the frontend which phase failed so it can render the progress
      // tree correctly and decide retry semantics:
      //   - pre_flight: nothing on-chain happened, fix config and retry
      //   - main_positions: pool may have been created, current behaviour
      //     is to require a sweep; mid-Phase-1 partial recovery is a
      //     larger refactor for later
      //   - bootstrap: main positions intact, retry bootstraps only
      //   - locks: positions all open, retry the lock phase only
      //   - transfers: positions locked, un-transferred Fee Keys will
      //     sweep to user's destination (transfer failure is non-blocking)
      failedPhase: error.failedPhase,
      // When phase 2 reports multiple failed bootstraps, the orchestrator
      // attaches the full list here. Phase 1 only ever has one failure
      // (it aborts on first failure) so failedAllocationIndex is enough
      // there; phase 2 keeps going past individual failures and may have
      // several. Frontend uses this to mark every failed pool's bootstrap
      // row, not just one.
      bootstrapFailures: error.bootstrapFailures || null,
      // Phase 3 and Phase 4 failure arrays. Same shape as
      // bootstrapFailures: each entry pinpoints which allocation/slice
      // failed and why. The frontend uses these to render per-position
      // failure markers and offer targeted retry.
      lockFailures: error.lockFailures || null,
      transferFailures: error.transferFailures || null,
    });
  }
});

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
app.post('/api/resume-launch', async (req, res) => {
  try {
    const {
      tempWalletSecretKey,
      tokenMint,
      tokenDecimals,
      tokenTotalSupply,
      targetMarketCapUsd,
      allocations,
      lockPositions,
      priorResults,
    } = req.body;

    if (!Array.isArray(allocations) || allocations.length === 0) {
      throw new Error('allocations array is required');
    }
    if (!Array.isArray(priorResults)) {
      throw new Error('priorResults must be an array (use [] for a fresh launch)');
    }

    console.log(
      `Resuming launch for ${tokenMint}: ${priorResults.length}/${allocations.length} ` +
        `allocation(s) carried over from prior attempt`,
    );

    const result = await createPoolsAndPositions({
      tempWalletSecretKey: typeof tempWalletSecretKey === 'string'
        ? JSON.parse(tempWalletSecretKey)
        : tempWalletSecretKey,
      tokenMint,
      tokenDecimals: tokenDecimals || 9,
      tokenTotalSupply,
      targetMarketCapUsd,
      allocations,
      lockPositions: lockPositions !== false,
      priorResults,
    });

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error resuming launch:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      partialResults: error.partialResults || [],
      failedAllocationIndex: error.failedAllocationIndex,
      failedAllocation: error.failedAllocation,
      failedPhase: error.failedPhase,
      bootstrapFailures: error.bootstrapFailures || null,
      lockFailures: error.lockFailures || null,
      transferFailures: error.transferFailures || null,
    });
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
app.post('/api/transfer-assets', async (req, res) => {
  try {
    const {
      tempWalletSecretKey,
      destinationWallet,
      // tokenMint kept in payload for backward compat with the frontend,
      // but no longer used to decide what to transfer — the new
      // sweepAllTokensToDestination picks up every fungible token, not
      // just the launched mint. The frontend still passes it.
    } = req.body;

    console.log('Transferring assets to:', destinationWallet);

    const secretKeyArr = typeof tempWalletSecretKey === 'string'
      ? JSON.parse(tempWalletSecretKey)
      : tempWalletSecretKey;

    // 1. NFTs first. Fee Keys especially — these are the most valuable
    //    sweep items and we want them locked in before risking SOL.
    const nftSweep = await sweepNftsToDestination({
      tempWalletSecretKey: secretKeyArr,
      destinationWallet,
    });

    // 2. All fungible tokens — launched token + any auto-swapped quote
    //    tokens that weren't fully consumed by the bootstrap positions.
    const tokenSweep = await sweepAllTokensToDestination({
      tempWalletSecretKey: secretKeyArr,
      destinationWallet,
    });

    // 3. SOL last. If steps 1-2 left the wallet too low to cover this
    //    tx fee, sweepSolToDestination returns 0 silently. Wrapped in
    //    its own try/catch so a SOL-sweep RPC blip doesn't lose the
    //    successful token/NFT results from steps 1-2 — those have
    //    already landed on-chain and we want to report them even if
    //    this final step needs the user to retry.
    let solSweep = { solTransferred: 0 };
    let solSweepError = null;
    try {
      solSweep = await sweepSolToDestination({
        tempWalletSecretKey: secretKeyArr,
        destinationWallet,
      });
    } catch (e) {
      console.error('SOL sweep failed (token/NFT sweeps succeeded):', e.message);
      solSweepError = e.message;
    }

    // 4. Verify the wallet is on-chain empty before clearing the
    //    recovery cache entry. Anything still there → leave the cached
    //    key in place so the user has another shot at recovery.
    //    A balance-check failure also keeps the entry (conservative).
    try {
      const tempPubkey = walletPubkeyFromSecretArray(secretKeyArr);
      const remaining = await checkWalletBalanceMultiToken(tempPubkey);
      if (isWalletEffectivelyEmpty(remaining)) {
        pendingWallets.remove(tempPubkey);
      } else {
        console.warn(
          `Wallet ${tempPubkey} not empty after sweep; keeping recovery entry. ` +
          `SOL=${remaining.sol}, tokens=${Object.keys(remaining.tokens).length}`,
        );
      }
    } catch (e) {
      console.warn('Post-sweep verification failed; keeping recovery entry:', e.message);
    }

    // Response shape: preserve the historic top-level fields the
    // frontend already displays ({tokensTransferred, solTransferred,
    // nftSweep}), plus the new per-token detail under tokenSweep so
    // future UI iterations can show per-token results.
    const tokensTransferred = tokenSweep.transferred.length;
    const solTransferred = solSweep.solTransferred;
    res.json({
      success: true,
      tokensTransferred,
      solTransferred,
      destinationWallet,
      nftSweep,
      tokenSweep,
      solSweepError,
    });
  } catch (error) {
    console.error('Error transferring assets:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Recovery cache for temporary wallets.
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

app.get('/api/pending-wallets', (req, res) => {
  try {
    // Augment each entry with a base58 form of the secret key, since
    // that's what users actually paste into wallet apps.
    //
    // Tolerate entries whose decryption failed (e.g. the file was
    // copied from another machine, or the OS keychain rotated): one
    // bad entry must not break the whole panel, so we surface a
    // `decryptionFailed` flag instead of crashing on Uint8Array.from
    // of undefined.
    const wallets = pendingWallets.list().map((w) => {
      const out = {
        publicKey: w.publicKey,
        createdAt: w.createdAt,
      };
      if (Array.isArray(w.secretKey)) {
        out.secretKey = w.secretKey;
        out.secretKeyB58 = secretKeyToBase58(w.secretKey);
      }
      if (typeof w.mnemonic === 'string') {
        out.mnemonic = w.mnemonic;
      }
      // If neither was decryptable, the front-end shows a "decryption
      // failed" state with only a Discard button.
      if (!out.secretKey && !out.mnemonic) {
        out.decryptionFailed = true;
      }
      return out;
    });
    res.json({ success: true, wallets });
  } catch (error) {
    console.error('Error listing pending wallets:', error);
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
  try {
    const { publicKey } = req.body;
    const result = await findFundingWallet(publicKey);
    res.json({ success: true, result });
  } catch (error) {
    console.error('Error finding funder:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Start server
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
app.listen(PORT, '127.0.0.1', () => {
  const cfg = getRpcConfig();
  const active = cfg.saved.find((r) => r.url === cfg.active);
  console.log(`Server running on http://127.0.0.1:${PORT}`);
  console.log(`Active RPC: ${active ? active.name : '(unnamed)'} — ${cfg.active}`);
  console.log(`Saved RPCs: ${cfg.saved.length} (manage in the UI)`);
  console.log('\nIMPORTANT: For pool creation, use a dedicated RPC (Helius, Triton, QuickNode — free tier is plenty).');
  console.log('Free public RPC endpoints will rate-limit you out of CLMM creation.\n');
});
