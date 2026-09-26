// vanityCaStore.js
//
// Persists pre-ground Vanity CA mint keypairs so a good candidate survives an
// app restart. Secret keys use the same secretStore wrapper as pending launch
// wallets: OS-keychain-backed encryption in the desktop build, with the same
// explicit plaintext fallback in web/dev mode.
//
// Two key types:
//   seed   — a standard 64-byte Solana keypair (seed || public key).
//   scalar — a 32-byte Ed25519 scalar from a split-key grind (a + k). Wallet
//            apps cannot import it; Trebuchet signs the create-mint
//            transaction with it directly (packages/core/src/split-key.js).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as secretStore from './secretStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function configDir() {
  return process.env.TREBUCHET_CONFIG_DIR || __dirname;
}

function storeFile() {
  return path.join(configDir(), 'vanityCAs.json');
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function decodeEntry(raw) {
  const out = {
    publicKey: raw.publicKey,
    createdAt: raw.createdAt,
    rarity: raw.rarity || 'Common',
    epochs: optionalNumber(raw.epochs),
    attempts: optionalNumber(raw.attempts),
    expectedAttempts: optionalNumber(raw.expectedAttempts),
    target: typeof raw.target === 'string' ? raw.target : null,
    prefix: typeof raw.prefix === 'string' ? raw.prefix : null,
    suffix: typeof raw.suffix === 'string' ? raw.suffix : null,
    mode: typeof raw.mode === 'string' ? raw.mode : null,
    caseInsensitive: raw.caseInsensitive === true,
    addressLength: Number.isInteger(raw.addressLength) ? raw.addressLength : null,
    keyType: raw.keyType === 'scalar' ? 'scalar' : 'seed',
  };

  let secret;
  if (typeof raw.secretKeyEnc === 'string') {
    const json = secretStore.decryptString(raw.secretKeyEnc);
    if (json) {
      try { secret = JSON.parse(json); }
      catch { /* corrupted entry: leave the secret undefined */ }
    }
  } else if (Array.isArray(raw.secretKey)) {
    secret = raw.secretKey;
  }
  if (Array.isArray(secret)) {
    if (out.keyType === 'scalar') out.scalar = secret;
    else out.secretKey = secret;
  }

  return out;
}

function encodeEntry(entry) {
  const out = {
    publicKey: entry.publicKey,
    createdAt: entry.createdAt,
    rarity: entry.rarity || 'Common',
    epochs: entry.epochs ?? null,
    attempts: entry.attempts ?? null,
    expectedAttempts: entry.expectedAttempts ?? null,
    target: entry.target || null,
    prefix: entry.prefix || null,
    suffix: entry.suffix || null,
    mode: entry.mode || null,
    caseInsensitive: entry.caseInsensitive === true,
    addressLength: Number.isInteger(entry.addressLength) ? entry.addressLength : null,
    keyType: entry.keyType === 'scalar' ? 'scalar' : 'seed',
  };
  const secret = entry.keyType === 'scalar' ? entry.scalar : entry.secretKey;
  if (Array.isArray(secret)) {
    out.secretKeyEnc = secretStore.encryptString(JSON.stringify(secret));
  }
  return out;
}

function readRaw() {
  try {
    if (!fs.existsSync(storeFile())) return [];
    const parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('vanityCaStore: failed to read, treating as empty:', e.message);
    return [];
  }
}

function persist(list) {
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(storeFile(), JSON.stringify(list.map(encodeEntry), null, 2) + '\n');
  } catch (e) {
    console.error('vanityCaStore: failed to save:', e.message);
  }
}

function load() {
  const raw = readRaw();
  const decodedAll = raw.map(decodeEntry);
  const decoded = decodedAll
    .filter((entry) => typeof entry.publicKey === 'string' && entry.publicKey.length > 0);

  const hasLegacyPlaintext = raw.some((entry) => Array.isArray(entry.secretKey));
  const hasReencryptableTokens = raw.some((entry) =>
    secretStore.shouldReencryptToken(entry.secretKeyEnc));
  const hasReencryptFailure = raw.some((entry, idx) =>
    secretStore.shouldReencryptToken(entry.secretKeyEnc) && !hasSecret(decodedAll[idx]));
  if (hasLegacyPlaintext || (hasReencryptableTokens && !hasReencryptFailure)) {
    persist(decoded);
  } else if (hasReencryptableTokens && hasReencryptFailure) {
    console.warn('vanityCaStore: skipped secret migration because at least one entry could not be decrypted');
  }

  return decoded;
}

function hasSecret(entry) {
  return Array.isArray(entry?.secretKey) || Array.isArray(entry?.scalar);
}

function metadata(entry) {
  return {
    publicKey: entry.publicKey,
    createdAt: entry.createdAt,
    rarity: entry.rarity || 'Common',
    epochs: entry.epochs,
    attempts: entry.attempts,
    expectedAttempts: entry.expectedAttempts,
    target: entry.target,
    prefix: entry.prefix,
    suffix: entry.suffix,
    mode: entry.mode,
    caseInsensitive: entry.caseInsensitive === true,
    addressLength: Number.isInteger(entry.addressLength) ? entry.addressLength : null,
    keyType: entry.keyType === 'scalar' ? 'scalar' : 'seed',
    hasSecretKey: hasSecret(entry),
    decryptionFailed: !hasSecret(entry),
    persisted: true,
  };
}

export function add(entry) {
  const scalarKey = entry?.keyType === 'scalar';
  const validSecret = scalarKey
    ? Array.isArray(entry.scalar) && entry.scalar.length === 32
    : Array.isArray(entry?.secretKey);
  if (!entry || typeof entry.publicKey !== 'string' || !validSecret) {
    throw new TypeError('vanityCaStore.add expects { publicKey, secretKey } or { publicKey, keyType: "scalar", scalar }');
  }
  const list = load();
  const idx = list.findIndex((item) => item.publicKey === entry.publicKey);
  const next = {
    publicKey: entry.publicKey,
    ...(scalarKey ? { keyType: 'scalar', scalar: entry.scalar } : { keyType: 'seed', secretKey: entry.secretKey }),
    createdAt: entry.createdAt || new Date().toISOString(),
    rarity: entry.rarity || 'Common',
    epochs: entry.epochs ?? null,
    attempts: entry.attempts ?? null,
    expectedAttempts: entry.expectedAttempts ?? null,
    target: entry.target || null,
    prefix: entry.prefix || null,
    suffix: entry.suffix || null,
    mode: entry.mode || null,
    caseInsensitive: entry.caseInsensitive === true,
    addressLength: Number.isInteger(entry.addressLength) ? entry.addressLength : null,
  };
  if (idx >= 0) list[idx] = { ...list[idx], ...next, createdAt: list[idx].createdAt || next.createdAt };
  else list.push(next);
  persist(list);
}

export function remove(publicKey) {
  const list = load();
  const filtered = list.filter((entry) => entry.publicKey !== publicKey);
  if (filtered.length !== list.length) persist(filtered);
}

export function removePinEncrypted() {
  const raw = readRaw();
  const filteredRaw = raw.filter((entry) => !secretStore.isSecretPinToken(entry?.secretKeyEnc));
  if (filteredRaw.length !== raw.length) {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(storeFile(), JSON.stringify(filteredRaw, null, 2) + '\n');
  }
  return raw.length - filteredRaw.length;
}

export function get(publicKey) {
  return load().find((entry) => entry.publicKey === publicKey) || null;
}

export function list() {
  return load();
}

export function listMetadata() {
  return load().map(metadata);
}
