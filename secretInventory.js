// Read-only inventory of every locally saved secret, for the Recovery PIN
// reset dialog and for honest wallet wording.
//
// The state of each item is computed here, on the server. Nothing returned
// from this module holds a secret, a token or ciphertext: only public keys,
// ids, states and public counters. Files are read directly and never written.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as secretStore from './secretStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function configDir() {
  return process.env.TREBUCHET_CONFIG_DIR || __dirname;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readArray(name) {
  const parsed = readJson(path.join(configDir(), name), []);
  return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry === 'object') : [];
}

const isToken = (value) => typeof value === 'string' && value.length > 0;

/**
 * State of one saved secret.
 *   readable   the secret decrypts now
 *   locked     saved under the Recovery PIN, and the PIN is locked
 *   wrong-key  a saved key exists but does not decrypt while it should
 *   missing    no saved key in the file at all
 * `plain` is a legacy plaintext array value, which is always readable.
 */
function classify({ token, plain }) {
  if (Array.isArray(plain)) return 'readable';
  if (!isToken(token)) return 'missing';
  const text = secretStore.decryptString(token);
  if (text) return 'readable';
  if (secretStore.isSecretPinToken(token) && secretStore.isSecretPinLocked()) return 'locked';
  return 'wrong-key';
}

function pinProtected(token) {
  return isToken(token) && secretStore.isSecretPinToken(token);
}

function pendingItems() {
  return readArray('pendingWallets.json')
    .filter((raw) => typeof raw.publicKey === 'string' && raw.publicKey)
    .map((raw) => {
      const keyToken = raw.secretKeyEnc;
      const hasKey = isToken(keyToken) || Array.isArray(raw.secretKey);
      const hasMnemonic = isToken(raw.mnemonicEnc) || (typeof raw.mnemonic === 'string' && raw.mnemonic.length > 0);
      const state = hasKey
        ? classify({ token: keyToken, plain: raw.secretKey })
        : classify({ token: raw.mnemonicEnc, plain: typeof raw.mnemonic === 'string' ? [] : undefined });
      return {
        store: 'pendingWallets',
        kind: 'launch wallet',
        publicKey: raw.publicKey,
        state,
        hasMnemonic,
        wouldBeLostByReset: pinProtected(raw.secretKeyEnc) || pinProtected(raw.mnemonicEnc),
      };
    });
}

function vanityItems() {
  return readArray('vanityCAs.json')
    .filter((raw) => typeof raw.publicKey === 'string' && raw.publicKey)
    .map((raw) => {
      const scalar = raw.keyType === 'scalar';
      const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
      return {
        store: 'vanityCAs',
        kind: scalar ? 'vanity scalar key' : 'vanity seed key',
        publicKey: raw.publicKey,
        state: classify({ token: raw.secretKeyEnc, plain: raw.secretKey }),
        hasMnemonic: false,
        attempts: num(raw.attempts),
        epochs: num(raw.epochs),
        wouldBeLostByReset: pinProtected(raw.secretKeyEnc),
      };
    });
}

function splitItems() {
  return readArray('splitJobs.json')
    .filter((raw) => typeof raw.id === 'string' && raw.id)
    .map((raw) => ({
      store: 'splitJobs',
      kind: 'split job',
      id: raw.id,
      state: classify({ token: raw.secretEnc }),
      hasMnemonic: false,
      attempts: Number.isFinite(raw.expectedAttempts) ? raw.expectedAttempts : null,
      wouldBeLostByReset: pinProtected(raw.secretEnc),
    }));
}

function nftItems() {
  const items = [];
  const root = path.join(configDir(), 'nftCollections');
  let ids = [];
  try { ids = fs.readdirSync(root); } catch { return items; }
  for (const id of ids.sort()) {
    const record = readJson(path.join(root, id, 'collection.json'), null);
    if (!record || typeof record !== 'object') continue;
    const keys = [];
    if (record.collectionKey) keys.push({ key: record.collectionKey, spent: !!record.collectionSignature });
    for (const item of Array.isArray(record.items) ? record.items : []) {
      if (item?.key) keys.push({ key: item.key, spent: !!item.mintSignature });
    }
    for (const { key, spent } of keys) {
      items.push({
        store: 'nftCollections',
        kind: 'nft key',
        id,
        publicKey: typeof key.address === 'string' ? key.address : null,
        state: classify({ token: key.scalarEnc }),
        hasMnemonic: false,
        attempts: Number.isFinite(key.attempts) ? key.attempts : null,
        wouldBeLostByReset: !spent && pinProtected(key.scalarEnc),
      });
    }
  }
  return items;
}

export const SECRET_STATES = ['readable', 'locked', 'wrong-key', 'missing'];

function dammItems() {
  const root = path.join(configDir(), 'dammLaunches');
  let files = [];
  try { files = fs.readdirSync(root); } catch { return []; }
  return files.filter((file) => file.endsWith('.json')).flatMap((file) => {
    const record = readJson(path.join(root, file), null);
    if (!record) return [];
    return [
      { kind: 'token mint key', token: record.tokenMintKey?.secretEnc, publicKey: record.tokenMintKey?.publicKey, spent: record.steps?.token?.complete },
      { kind: 'position key', token: record.positionNftEnc, publicKey: record.steps?.pool?.positionNft, spent: record.steps?.pool?.complete },
    ].filter(({ token }) => isToken(token)).map(({ token, kind, publicKey, spent }) => ({
      store: 'dammLaunches', kind, id: record.id, publicKey: publicKey || null,
      state: classify({ token }), hasMnemonic: false, wouldBeLostByReset: !spent && pinProtected(token),
    }));
  });
}

/** Everything saved, with a computed state for each item. Public fields only. */
export function secretInventory() {
  const stores = {
    pendingWallets: pendingItems(),
    vanityCAs: vanityItems(),
    splitJobs: splitItems(),
    nftKeys: nftItems(),
    dammKeys: dammItems(),
  };
  const all = Object.values(stores).flat();
  const totals = { total: all.length, wouldBeLostByReset: 0 };
  for (const state of SECRET_STATES) totals[state] = 0;
  for (const item of all) {
    totals[item.state] += 1;
    if (item.wouldBeLostByReset) totals.wouldBeLostByReset += 1;
  }
  const status = secretStore.secretPinStatus();
  return {
    pin: { configured: !!status.configured, unlocked: !!status.unlocked, locked: !!status.locked },
    stores,
    totals,
    wouldBeLostByReset: all.filter((item) => item.wouldBeLostByReset),
    // Reset is only allowed when no item that it would destroy can still be read.
    resetAllowed: !(status.unlocked && all.some((item) => item.wouldBeLostByReset && item.state === 'readable')),
  };
}

/** Secret state for one launch wallet, for the wallet list. */
export function walletSecretState(publicKey, inventory = null) {
  const items = (inventory || secretInventory()).stores.pendingWallets;
  return items.find((item) => item.publicKey === publicKey)?.state || null;
}
