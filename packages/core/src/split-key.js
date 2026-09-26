// Split-key vanity grinding for Ed25519 (Solana) mint addresses.
//
// The customer keeps a secret scalar `a` and shares only its point A = a·G.
// A grinder searches offsets k until A + k·G encodes to the wanted address.
// The offset alone is useless: recovering the mint's secret needs `a`. The
// customer combines s = a + k (mod L), whose public key is exactly A + k·G.
// So a grinding service never sees the key it finds.
//
// s is a raw Ed25519 scalar, not the 32-byte seed wallets expect, so wallet
// apps cannot import it. That is fine for a token mint: its key signs once,
// in the create-mint transaction, which Trebuchet builds itself and signs
// with signWithScalar(). Validators only check that the signature is valid
// Ed25519 for the address; they cannot tell how the scalar was made.

import { ed25519 } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils';

const Point = ed25519.ExtendedPoint;
const L = ed25519.CURVE.n;
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const NONCE_DOMAIN = utf8ToBytes('trebuchet-split-key-nonce-v1');

function mod(value) {
  const r = value % L;
  return r >= 0n ? r : r + L;
}

function bytesToNumberLE(bytes) {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]);
  return value;
}

function numberToBytesLE(value, length) {
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = 0; i < length; i++) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function toBytes(value, length, label) {
  const bytes = value instanceof Uint8Array ? value : Uint8Array.from(value || []);
  if (bytes.length !== length) throw new Error(`${label} must be ${length} bytes`);
  return bytes;
}

export function base58Encode(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = B58_ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

// A customer point must be a proper curve point in the prime-order subgroup,
// or offsets could be ground against a point with no usable secret.
function customerPoint(publicPoint) {
  const point = Point.fromHex(toBytes(publicPoint, 32, 'publicPoint'));
  if (point.equals(Point.ZERO) || point.isSmallOrder() || !point.isTorsionFree()) {
    throw new Error('publicPoint is not a valid Ed25519 public key');
  }
  return point;
}

function offsetScalar(offset) {
  return mod(bytesToNumberLE(toBytes(offset, 32, 'offset')));
}

/**
 * Create the customer's half. `secretScalar` never leaves the customer;
 * `publicPoint` is what a grinder receives.
 */
export function createSplitSecret() {
  let a = 0n;
  // 64 random bytes reduced mod L: uniform, no modulo bias.
  while (a === 0n) a = mod(bytesToNumberLE(randomBytes(64)));
  return {
    secretScalar: numberToBytesLE(a, 32),
    publicPoint: Point.BASE.multiply(a).toRawBytes(),
  };
}

/**
 * The address an offset produces, computed from public data only. A
 * customer (or anyone) can check a grinder's result without the secret.
 */
export function splitResultAddress(publicPoint, offset) {
  const k = offsetScalar(offset);
  const A = customerPoint(publicPoint);
  const P = k === 0n ? A : A.add(Point.BASE.multiply(k));
  return base58Encode(P.toRawBytes());
}

/**
 * Combine the customer's secret with a grinder's offset into the mint's
 * secret scalar. Refuses unless the secret matches the point and the result
 * equals A + k·G.
 */
export function combineSplitKey({ secretScalar, publicPoint, offset }) {
  const a = mod(bytesToNumberLE(toBytes(secretScalar, 32, 'secretScalar')));
  const A = customerPoint(publicPoint);
  if (a === 0n || !Point.BASE.multiply(a).equals(A)) {
    throw new Error('secretScalar does not match publicPoint');
  }
  const k = offsetScalar(offset);
  const s = mod(a + k);
  if (s === 0n) throw new Error('offset cancels the secret');
  const P = Point.BASE.multiply(s);
  const expected = k === 0n ? A : A.add(Point.BASE.multiply(k));
  if (!P.equals(expected)) throw new Error('combined key does not match the offset');
  const publicKey = P.toRawBytes();
  return { scalar: numberToBytesLE(s, 32), publicKey, address: base58Encode(publicKey) };
}

export function scalarPublicKey(scalar) {
  const s = mod(bytesToNumberLE(toBytes(scalar, 32, 'scalar')));
  if (s === 0n) throw new Error('scalar must be nonzero');
  return Point.BASE.multiply(s).toRawBytes();
}

/**
 * Standard Ed25519 signature (R || S) from a raw scalar. The nonce is
 * deterministic, as in RFC 8032, derived from a domain-separated hash of the
 * scalar and the message, so no randomness can leak the key.
 */
export function signWithScalar(scalar, message) {
  const scalarBytes = toBytes(scalar, 32, 'scalar');
  const s = mod(bytesToNumberLE(scalarBytes));
  if (s === 0n) throw new Error('scalar must be nonzero');
  const msg = message instanceof Uint8Array ? message : Uint8Array.from(message);
  const A = Point.BASE.multiply(s).toRawBytes();
  const prefix = sha512(concatBytes(NONCE_DOMAIN, scalarBytes)).slice(32);
  let r = mod(bytesToNumberLE(sha512(concatBytes(prefix, msg))));
  if (r === 0n) r = 1n; // probability ~2^-252; keeps multiply() in range
  const R = Point.BASE.multiply(r).toRawBytes();
  const h = mod(bytesToNumberLE(sha512(concatBytes(R, A, msg))));
  const S = mod(r + h * s);
  return concatBytes(R, numberToBytesLE(S, 32));
}

export function matchesVanityPattern(address, { prefix = '', suffix = '', caseInsensitive = false, length = null } = {}) {
  const fold = (value) => (caseInsensitive ? value.toLowerCase() : value);
  if (length && address.length !== length) return false;
  if (prefix && !fold(address).startsWith(fold(prefix))) return false;
  if (suffix && !fold(address).endsWith(fold(suffix))) return false;
  return true;
}
