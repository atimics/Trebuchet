// pendingWallets.js
//
// Persists the secret keys of temporary wallets that are mid-launch, so
// that if the app crashes or the user closes it before the final
// transfer step completes, they can still recover any SOL/tokens left
// in the wallet rather than losing access forever.
//
// Lifecycle:
//   1. /api/generate-wallet   → add(publicKey, secretKey, mnemonic)
//   2. ...launch proceeds...
//   3. /api/transfer-assets   → on success AND after verifying the
//                                wallet is on-chain empty, remove(pk).
//
// At-rest encryption: secret material (the secretKey byte array and the
// mnemonic) goes through secretStore before being written to disk. In
// the Electron desktop build that means OS-keychain-backed encryption;
// in `npm run web` mode it falls back to plaintext with a warning.
// On-disk format:
//   {
//     publicKey:    "...",
//     createdAt:    "ISO timestamp",
//     secretKeyEnc: "enc:base64..." | "plain:[byte,array,...]",
//     mnemonicEnc:  "enc:base64..." | "plain:word word word..."
//   }
//
// Pre-encryption legacy entries (plain `secretKey` array or `mnemonic`
// string fields) are still readable, and get migrated to the encrypted
// form on the next load.

import fs from 'fs';
import { createHash, randomUUID } from 'node:crypto';
import { RecoveryStorageError } from '@trebuchet/runtime/store';
import path from 'path';
import { fileURLToPath } from 'url';
import * as secretStore from './secretStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sourceRecords = new WeakMap();

function storageError(cause) {
  if (cause?.code === 'RECOVERY_STORAGE_UNAVAILABLE') return cause;
  return Object.assign(new RecoveryStorageError('Wallet recovery storage requires attention before continuing.', { cause }), { statusCode: 500 });
}

// Same env-var convention as rpcConfig.js. main.js sets this to
// app.getPath('userData') in the Electron build; left unset by the web
// build so writes land alongside the source.
function configDir() {
  return process.env.TREBUCHET_CONFIG_DIR || __dirname;
}

function walletFile() {
  return path.join(configDir(), 'pendingWallets.json');
}

// ---------------------------------------------------------------------------
// Encoding/decoding between in-memory and on-disk representations.
// ---------------------------------------------------------------------------

// Decrypt one disk entry into the in-memory shape used by the rest of
// the app. Tolerates legacy plaintext fields (secretKey: [...] /
// mnemonic: "...") so an upgrade doesn't lose anyone's recovery info.
function decodeEntry(raw) {
  const out = {
    publicKey: raw.publicKey,
    createdAt: raw.createdAt,
  };
  if (typeof raw.rarity === 'string' && raw.rarity.trim()) {
    out.rarity = raw.rarity.trim();
  }
  if (raw.vanity === true) out.vanity = true;

  // Secret key (byte array). Encrypted form serialises through JSON.
  if (typeof raw.secretKeyEnc === 'string') {
    const json = secretStore.decryptString(raw.secretKeyEnc);
    if (json) {
      try { out.secretKey = JSON.parse(json); }
      catch { /* corrupted entry — leave secretKey undefined */ }
    }
  } else if (Array.isArray(raw.secretKey)) {
    out.secretKey = raw.secretKey;        // legacy plaintext
  }

  // Mnemonic (string).
  if (typeof raw.mnemonicEnc === 'string') {
    const text = secretStore.decryptString(raw.mnemonicEnc);
    if (text) out.mnemonic = text;
  } else if (typeof raw.mnemonic === 'string') {
    out.mnemonic = raw.mnemonic;          // legacy plaintext
  }

  sourceRecords.set(out, raw);
  return out;
}

// Encrypt one in-memory entry into the on-disk shape.
function encodeEntry(decoded) {
  const prior = sourceRecords.get(decoded) || {};
  const out = { ...prior, publicKey: decoded.publicKey, createdAt: decoded.createdAt };
  if (typeof decoded.rarity === 'string' && decoded.rarity.trim()) out.rarity = decoded.rarity.trim();
  if (decoded.vanity === true) out.vanity = true;
  const encodeSecret = (field, tokenField, text) => {
    const original = prior[tokenField];
    const same = typeof original === 'string' && secretStore.decryptString(original) === text;
    if (same && !secretStore.shouldReencryptToken(original)) { delete out[field]; return; }
    const token = secretStore.encryptString(text);
    if (secretStore.decryptString(token) !== text) throw new Error('Verify the recovery ciphertext before saving it');
    if (typeof original === 'string' && /^(enc|pin):/.test(original) && token.startsWith('plain:')) {
      throw new Error('Use encrypted custody when replacing an encrypted recovery secret');
    }
    out[tokenField] = token;
    delete out[field];
  };
  if (Array.isArray(decoded.secretKey)) encodeSecret('secretKey', 'secretKeyEnc', JSON.stringify(decoded.secretKey));
  if (typeof decoded.mnemonic === 'string' && decoded.mnemonic.length > 0) encodeSecret('mnemonic', 'mnemonicEnc', decoded.mnemonic);
  return out;
}

// ---------------------------------------------------------------------------
// File I/O. Reads preserve damaged records for recovery. Writes commit atomically. A newly generated wallet is not safe to fund
// until its secret has been durably persisted and can be read back.
// ---------------------------------------------------------------------------

function readRaw() {
  try {
    let stat;
    try { stat = fs.lstatSync(walletFile()); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Use a regular file for wallet recovery');
    const parsed = JSON.parse(fs.readFileSync(walletFile(), 'utf8'));
    const identities = new Set();
    if (!Array.isArray(parsed)) throw new Error('Wallet recovery requires an array of records');
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.publicKey !== 'string' || !entry.publicKey || identities.has(entry.publicKey)) {
        throw new Error('Wallet recovery records require distinct public keys');
      }
      identities.add(entry.publicKey);
    }
    return parsed;
  } catch (error) { throw storageError(error); }
}

function syncDirectory() {
  if (process.platform === 'win32') return;
  const descriptor = fs.openSync(configDir(), 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function preserveMigrationSource() {
  const bytes = fs.readFileSync(walletFile());
  const digest = createHash('sha256').update(bytes).digest('hex');
  const backup = `${walletFile()}.migration-${digest}.bak`;
  let descriptor;
  try {
    descriptor = fs.openSync(backup, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!fs.lstatSync(backup).isFile() || fs.lstatSync(backup).isSymbolicLink() || !fs.readFileSync(backup).equals(bytes)) throw new Error('Verify the saved migration source before continuing');
    descriptor = fs.openSync(backup, 'r');
    fs.fsyncSync(descriptor);
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  syncDirectory();
}

function persistRaw(records, { migration = false } = {}) {
  let temporary;
  let descriptor;
  try {
    // Validate the current file before every replacement. Damaged bytes stay
    // available for recovery, even when the caller removes a wallet.
    readRaw();
    fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    if (migration) preserveMigrationSource();
    temporary = `${walletFile()}.${randomUUID()}.tmp`;
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(records, null, 2) + '\n');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, walletFile()); temporary = undefined;
    syncDirectory();
  } catch (error) { throw storageError(error); }
  finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (temporary) { try { fs.unlinkSync(temporary); } catch { /* retain the commit error */ } }
  }
}

function load() {
  const raw = readRaw();
  const decoded = raw.map(decodeEntry);

  // One-shot migration: re-persist encrypted in two cases:
  //   (a) Legacy plaintext fields (secretKey: [...] / mnemonic: "...")
  //       from before this module wrote *Enc fields at all.
  //   (b) "plain:" tokens written when encryption was unavailable
  //       (e.g. `npm run web` mode), now that we can actually encrypt.
  // (b) is mostly a polish thing for users who switch from web mode to
  // the desktop build, but it costs nothing to handle correctly.
  const hasLegacyPlaintext = raw.some((e) =>
    Array.isArray(e.secretKey) || typeof e.mnemonic === 'string'
  );
  const hasReencryptableTokens = raw.some((e) =>
    secretStore.shouldReencryptToken(e.secretKeyEnc) ||
    secretStore.shouldReencryptToken(e.mnemonicEnc)
  );
  const hasReencryptFailure = raw.some((e, idx) =>
    (secretStore.shouldReencryptToken(e.secretKeyEnc) && !Array.isArray(decoded[idx]?.secretKey)) ||
    (secretStore.shouldReencryptToken(e.mnemonicEnc) && typeof decoded[idx]?.mnemonic !== 'string')
  );
  if ((hasLegacyPlaintext || hasReencryptableTokens) && !hasReencryptFailure && secretStore.isEncrypting()) {
    persist(decoded, { migration: true });
  }


  return decoded;
}

function persist(list, options) {
  try { persistRaw(list.map(encodeEntry), options); }
  catch (error) { throw storageError(error); }
}

function verifyPersistedWallet(publicKey) {
  const raw = readRaw().find((entry) => entry?.publicKey === publicKey);
  const decoded = raw ? decodeEntry(raw) : null;
  if (!decoded || !Array.isArray(decoded.secretKey)) {
    throw storageError(new Error('Verify the saved wallet recovery secret before continuing.'));
  }
  return decoded;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Record a wallet as in-progress. secretKey is the 64-byte array form
// returned by @solana/web3.js. mnemonic is the BIP39 recovery phrase if
// available — optional because older cached entries from before
// mnemonic support won't have one, and we want them to keep working.
// Idempotent: if the same publicKey is added twice, we keep the first
// entry's createdAt timestamp.
export function add(publicKey, secretKey, mnemonic, metadata = {}) {
  const list = load();
  const existing = list.find((wallet) => wallet.publicKey === publicKey);
  const rarity = typeof metadata?.rarity === 'string' && metadata.rarity.trim()
    ? metadata.rarity.trim()
    : null;
  if (existing) {
    let changed = false;
    // Importing a valid backup for an entry whose ciphertext can no longer be
    // decrypted must repair that entry. Keeping the first healthy secret is
    // still idempotent, while a missing secret is never left unrecoverable.
    if (!Array.isArray(existing.secretKey) && Array.isArray(secretKey)) {
      existing.secretKey = secretKey;
      changed = true;
    }
    if (typeof existing.mnemonic !== 'string' && typeof mnemonic === 'string' && mnemonic.length > 0) {
      existing.mnemonic = mnemonic;
      changed = true;
    }
    if (rarity && existing.rarity !== rarity) {
      existing.rarity = rarity;
      changed = true;
    }
    if (metadata?.vanity === true && existing.vanity !== true) {
      existing.vanity = true;
      changed = true;
    }
    if (changed) persist(list);
    return verifyPersistedWallet(publicKey);
  }
  const entry = {
    publicKey,
    secretKey,
    createdAt: new Date().toISOString(),
  };
  if (mnemonic) entry.mnemonic = mnemonic;
  if (rarity) entry.rarity = rarity;
  if (metadata?.vanity === true) entry.vanity = true;
  list.push(entry);
  persist(list);
  return verifyPersistedWallet(publicKey);
}

// Drop a wallet from the recovery list. Used when the launch finishes
// cleanly (and the wallet is verified on-chain empty), or when the
// user manually dismisses an entry.
export function remove(publicKey) {
  const list = load();
  const filtered = list.filter((w) => w.publicKey !== publicKey);
  if (filtered.length !== list.length) persist(filtered);
}

export function removePinEncrypted() {
  const raw = readRaw();
  const filteredRaw = raw.filter((entry) => !(
    secretStore.isSecretPinToken(entry?.secretKeyEnc) ||
    secretStore.isSecretPinToken(entry?.mnemonicEnc)
  ));
  if (filteredRaw.length !== raw.length) {
    persistRaw(filteredRaw);
  }
  return raw.length - filteredRaw.length;
}

// Return a single pending wallet by public key, decrypted, or null if not
// found. Convenience over list().find(...) for the common "I have the pubkey,
// give me the recoverable secret" lookup (resume, and the server-side signer
// resolution that F5 moves toward — letting the client send a pubkey instead
// of round-tripping the secret key through the renderer).
export function get(publicKey) {
  return load().find((w) => w.publicKey === publicKey) || null;
}

// Return all currently-pending wallets, decrypted into the in-memory shape
// ({ publicKey, secretKey, mnemonic, createdAt }). Server routes expose only
// metadata by default; secret material is revealed per-wallet on explicit user
// action.
export function list() {
  return load();
}
