// Verified destinations: the only wallets launch assets may be sent to.
//
// Sweeps and Fee Key transfers are irreversible, and a typed address is how
// a launch lost its Fee Keys to a placeholder. So a destination must be
// proven, never typed:
//
//   - the wallet that funded the launch wallet (checked on-chain by the
//     caller with findFundingWallet), or
//   - a wallet that signed a server-issued challenge (stored here).
//
// Challenges are single-use and expire after CHALLENGE_TTL_MS. Verified
// addresses persist in TREBUCHET_CONFIG_DIR/verifiedDestinations.json.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import nacl from 'tweetnacl';
import { PublicKey } from '@solana/web3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const SCHEMA = 'trebuchet-verified-destinations/v1';

const pendingChallenges = new Map();

function storePath() {
  return path.join(process.env.TREBUCHET_CONFIG_DIR || __dirname, 'verifiedDestinations.json');
}

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    if (parsed?.schema === SCHEMA && parsed.destinations && typeof parsed.destinations === 'object') {
      return parsed;
    }
  } catch (_error) {
    // Missing or unreadable: nothing is verified.
  }
  return { schema: SCHEMA, destinations: {} };
}

function writeStore(store) {
  const file = storePath();
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function normalizeAddress(value) {
  const address = String(value || '').trim();
  try {
    return new PublicKey(address).toBase58();
  } catch {
    throw new Error('Destination must be a valid Solana address.');
  }
}

/** Issue a one-time message for `address` to sign. */
export function issueChallenge(value, now = Date.now()) {
  const address = normalizeAddress(value);
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = [
    'Trebuchet: I control this wallet and accept launch assets sent to it.',
    `Wallet: ${address}`,
    `Nonce: ${nonce}`,
    `Issued: ${new Date(now).toISOString()}`,
  ].join('\n');
  pendingChallenges.set(nonce, { address, message, expiresAt: now + CHALLENGE_TTL_MS });
  return { address, nonce, message };
}

function decodeSignature(value) {
  const text = String(value || '').trim();
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length !== nacl.sign.signatureLength) {
    throw new Error('Signature must be a base64 ed25519 signature.');
  }
  return new Uint8Array(bytes);
}

/** Verify a signed challenge and remember the address. */
export function verifyChallenge({ nonce, signature }, now = Date.now()) {
  const pending = pendingChallenges.get(String(nonce || ''));
  if (!pending) throw new Error('This signing request expired or was already used. Start again.');
  pendingChallenges.delete(String(nonce));
  if (now > pending.expiresAt) throw new Error('This signing request expired. Start again.');

  const ok = nacl.sign.detached.verify(
    new TextEncoder().encode(pending.message),
    decodeSignature(signature),
    new PublicKey(pending.address).toBytes(),
  );
  if (!ok) throw new Error('The signature does not match this wallet.');

  const store = readStore();
  store.destinations[pending.address] = {
    verifiedAt: new Date(now).toISOString(),
    message: pending.message,
    signature: String(signature).trim(),
  };
  writeStore(store);
  return { address: pending.address, verifiedAt: store.destinations[pending.address].verifiedAt };
}

export function isSignedDestination(value) {
  let address;
  try {
    address = normalizeAddress(value);
  } catch {
    return false;
  }
  return Boolean(readStore().destinations[address]);
}

export function listSignedDestinations() {
  return Object.entries(readStore().destinations).map(([address, entry]) => ({
    address,
    verifiedAt: entry.verifiedAt,
  }));
}
