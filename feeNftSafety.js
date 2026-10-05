import { PublicKey } from '@solana/web3.js';
import { CORE_PROGRAM_ID } from './feeVaultClient.js';

// Core's Borsh base, plugin header and raw registry. The SDK's high-level
// decoder drops unknown plugin types, so acceptance checks use the raw types.
export function checkFeeNftAccount(info, collection = false) {
  const fail = () => { throw new Error('Choose Core NFTs and a collection with standard ownership controls'); };
  if (!info?.owner.equals(CORE_PROGRAM_ID)) fail();
  const d = Buffer.from(info.data);
  let at = 0;
  const take = (n) => { if (!Number.isSafeInteger(n) || n < 0 || at + n > d.length) fail(); const start = at; at += n; return start; };
  const byte = () => d[take(1)];
  const uint = () => d.readUInt32LE(take(4));
  const wide = () => { const n = d.readBigUInt64LE(take(8)); if (n > BigInt(Number.MAX_SAFE_INTEGER)) fail(); return Number(n); };
  if (byte() !== (collection ? 5 : 1)) fail();
  const owner = new PublicKey(d.subarray(take(32), at)).toBase58();
  let membership;
  if (!collection) { const authority = byte(); if (authority > 2) fail(); if (authority) { membership = new PublicKey(d.subarray(take(32), at)).toBase58(); if (authority !== 2) membership = undefined; } }
  take(uint()); take(uint());
  if (collection) take(8);
  else { const seq = byte(); if (seq > 1) fail(); if (seq) take(8); }
  if (at === d.length) return { owner, collection: membership };
  if (byte() !== 3) fail();
  const registry = wide(); const pluginsStart = at;
  if (registry < pluginsStart || registry >= d.length) fail();
  at = registry;
  if (byte() !== 4) fail();
  const count = uint(); if (count > Math.floor((d.length - at) / 10)) fail();
  const seen = new Set();
  for (let n = 0; n < count; n++) {
    const kind = byte();
    if (![0, 1, 2, 3, 4, 6, 9, 10, 11, 12, 13, 14].includes(kind) || seen.has(kind)) fail();
    seen.add(kind);
    const authority = byte(); if (authority > 3) fail(); if (authority === 3) take(32);
    const offset = wide();
    if (offset < pluginsStart || offset >= registry || d[offset] !== kind) fail();
  }
  if (uint() !== 0 || at !== d.length) fail();
  return { owner, collection: membership };
}

export function checkFeeMint(mint) {
  if (mint.freezeAuthority) throw new Error('Choose fee tokens with revoked freeze authority');
  const tlv = Buffer.from(mint.tlvData);
  let at = 0; const seen = new Set();
  while (at < tlv.length) {
    if (tlv.subarray(at).every((b) => b === 0)) break;
    if (at + 4 > tlv.length) throw new Error('Invalid fee token extension');
    const kind = tlv.readUInt16LE(at); const len = tlv.readUInt16LE(at + 2);
    if (![18, 19].includes(kind) || seen.has(kind) || at + 4 + len > tlv.length) throw new Error('Choose fee tokens with standard transfers');
    seen.add(kind); at += 4 + len;
  }
}

export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export function checkFeeBackingRelease(genesis) {
  if (genesis === MAINNET_GENESIS) throw Object.assign(new Error('Mainnet fee backing opens after independent audit and venue test review'), { code: 'FEE_SECURITY_REVIEW', statusCode: 409 });
}
