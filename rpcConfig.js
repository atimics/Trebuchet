// rpcConfig.js
//
// Manages a small JSON config file (rpcConfig.json in the project root) that
// stores the list of saved RPC endpoints and which one is currently active.
// First run seeds the file with a public-mainnet default; from then on
// everything is managed through the in-app RPC settings UI (addSavedRpc,
// setActiveRpc, removeSavedRpc, testRpc).
//
// The file format is intentionally simple so it's easy to hand-edit:
//   {
//     "active": "https://...",
//     "saved": [
//       { "name": "Public mainnet", "url": "https://api.mainnet-beta.solana.com" },
//       { "name": "Helius",         "url": "https://mainnet.helius-rpc.com/?api-key=..." }
//     ]
//   }

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Allow the consumer (e.g. an Electron wrapper) to redirect persisted state
// to a writable location outside the package directory. Defaults to
// __dirname for backward compatibility with the standalone server use case.
const CONFIG_DIR = process.env.TREBUCHET_CONFIG_DIR || __dirname;
const CONFIG_FILE = path.join(CONFIG_DIR, 'rpcConfig.json');

// First-run defaults.  Public mainnet and devnet endpoints.
// Users should add their own dedicated endpoint (Helius / QuickNode /
// Triton / Alchemy — free tier is plenty) via the in-app RPC
// settings before attempting a real launch.
const DEFAULT_RPCS = [
  { name: 'Public mainnet', url: 'https://api.mainnet-beta.solana.com', network: 'mainnet' },
  { name: 'Public devnet',  url: 'https://api.devnet.solana.com',         network: 'devnet' },
];

// In-memory state, lazily loaded
let state = null;

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function load() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      state = JSON.parse(raw);
      // Backward compat: add network field to entries and state.
      if (!state.activeNetwork) state.activeNetwork = 'mainnet';
      for (const r of state.saved) {
        if (!r.network) r.network = 'mainnet';
      }
      // Quick sanity check
      if (!state.active || !Array.isArray(state.saved) || state.saved.length === 0) {
        throw new Error('Config file malformed; reinitializing');
      }
      return;
    }
  } catch (e) {
    console.warn('rpcConfig: failed to load existing config, will reinitialize:', e.message);
  }

  // First-run init: seed the saved-RPCs list with defaults for both
  // networks.  The user can add their own endpoints through the in-app
  // RPC settings UI (addSavedRpc) and switch the active one
  // (setActiveRpc). All changes are persisted to CONFIG_FILE and
  // survive restarts.
  state = { active: DEFAULT_RPCS[0].url, activeNetwork: 'mainnet', saved: [...DEFAULT_RPCS] };
  persist();
}

function persist() {
  try {
    // mkdirSync with recursive:true is a no-op when the directory already
    // exists, so this is safe to call on every save. Necessary on first
    // run when CONFIG_DIR is e.g. an Electron userData path that hasn't
    // been touched yet.
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(state, null, 2) + '\n');
  } catch (e) {
    console.error('rpcConfig: failed to save config:', e.message);
  }
}

function ensureLoaded() {
  if (!state) load();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the URL of the currently active RPC. This is what tokenService,
 * lpService, and walletHelpers all use when they need to talk to Solana.
 */
export function getRpcUrl() {
  ensureLoaded();
  return state.active;
}

/**
 * Get the full config (active URL + saved list) for display in the UI.
 * Returns a shallow copy so the caller can't mutate our internal state.
 */
export function getConfig() {
  ensureLoaded();
  return {
    active: state.active,
    saved: state.saved.map((r) => ({ ...r })),
  };
}

/**
 * Switch the active RPC. The URL must already be in the saved list — to add
 * a new one, use addSavedRpc with setActive=true.
 */
export function setActiveRpc(url) {
  ensureLoaded();
  const found = state.saved.find((r) => r.url === url);
  if (!found) {
    throw new Error(`RPC URL is not in the saved list. Add it first.`);
  }
  state.active = url;
  persist();
}

/**
 * Add a new RPC to the saved list. If a saved entry with the same URL already
 * exists, its name is updated (no duplicate URLs). URL must be valid.
 */
export function addSavedRpc(name, url, network) {
  ensureLoaded();
  if (!name || typeof name !== 'string') throw new Error('Name is required');
  if (!url || typeof url !== 'string') throw new Error('URL is required');
  try {
    new URL(url);
  } catch {
    throw new Error('URL is not a valid URL');
  }

  const trimmedName = name.trim();
  const trimmedUrl = url.trim();

  const rpcNetwork = network || state.activeNetwork || 'mainnet';
  const existing = state.saved.find((r) => r.url === trimmedUrl);
  if (existing) {
    existing.name = trimmedName;
    if (network) existing.network = rpcNetwork;
  } else {
    state.saved.push({ name: trimmedName, url: trimmedUrl, network: rpcNetwork });
  }
  persist();
}

/**
 * Remove an RPC from the saved list. Won't let you remove the last one (need
 * at least one saved RPC for the active selection to point to). If you remove
 * the currently-active RPC, falls back to the first remaining saved entry.
 */
export function removeSavedRpc(url) {
  ensureLoaded();
  if (state.saved.length <= 1) {
    throw new Error('Cannot remove the last saved RPC');
  }
  const wasActive = state.active === url;
  state.saved = state.saved.filter((r) => r.url !== url);
  if (wasActive) {
    state.active = state.saved[0].url;
  }
  persist();
}

/**
 * Test an RPC URL by sending a lightweight getVersion JSON-RPC call.
 * Returns { ok, version?, latencyMs?, error? } — never throws.
 */
export async function testRpc(url) {
  if (!url) return { ok: false, error: 'URL is required' };
  try {
    new URL(url);
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }

  try {
    const start = Date.now();
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getVersion',
        params: [],
      }),
    });
    const latencyMs = Date.now() - start;

    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status} ${resp.statusText}` };
    }
    const json = await resp.json();
    if (json.error) {
      return { ok: false, error: json.error.message || 'RPC error' };
    }
    return {
      ok: true,
      version: json.result?.['solana-core'] || 'unknown',
      latencyMs,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Get the active network ('mainnet' or 'devnet').
 */
export function getNetwork() {
  ensureLoaded();
  return state.activeNetwork || 'mainnet';
}

/**
 * Set the active network.  Switches the active RPC to the first saved
 * endpoint for that network.  If none exists, seeds a default.
 */
export function setNetwork(network) {
  ensureLoaded();
  if (network !== 'mainnet' && network !== 'devnet') {
    throw new Error('Network must be "mainnet" or "devnet"');
  }
  state.activeNetwork = network;
  // Find first saved endpoint for this network
  const netRpcs = state.saved.filter(r => r.network === network);
  if (netRpcs.length > 0) {
    state.active = netRpcs[0].url;
  } else {
    // Seed a default for this network
    const def = DEFAULT_RPCS.find(r => r.network === network);
    if (def) {
      state.saved.push({ ...def });
      state.active = def.url;
    }
  }
  persist();
}

// Eagerly load on module import so getRpcUrl() can be called synchronously
// before any other API is invoked.
load();
