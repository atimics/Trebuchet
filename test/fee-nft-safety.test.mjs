import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { CORE_PROGRAM_ID } from '../feeVaultClient.js';
import { checkFeeNftAccount, checkFeeMint, checkFeeBackingRelease, MAINNET_GENESIS, DEVNET_GENESIS, feeWalletChain } from '../feeNftSafety.js';
import { getAssetV1AccountDataSerializer } from '@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData.js';
import { getCollectionV1AccountDataSerializer } from '@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData.js';

const address = () => Keypair.generate().publicKey.toBase58();
const owner = address(); const collection = address();
const uint = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const wide = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
function account(collectionAccount = false, kind, external = 0) {
  const base = Buffer.from(collectionAccount
    ? getCollectionV1AccountDataSerializer().serialize({ key: 5, updateAuthority: owner, name: 'Brand', uri: 'https://example.com', numMinted: 1, currentSize: 1 })
    : getAssetV1AccountDataSerializer().serialize({ key: 1, owner, updateAuthority: { __kind: 'Collection', fields: [collection] }, name: 'Brand #1', uri: 'https://example.com/1', seq: { __option: 'None' } }));
  if (kind === undefined && !external) return { owner: CORE_PROGRAM_ID, data: base };
  const plugin = kind === undefined ? Buffer.alloc(0) : Buffer.from([kind]);
  const registry = Buffer.concat([Buffer.from([4]), uint(plugin.length), ...(plugin.length ? [Buffer.from([kind, 2]), wide(base.length + 9)] : []), uint(external)]);
  return { owner: CORE_PROGRAM_ID, data: Buffer.concat([base, Buffer.from([3]), wide(base.length + 9 + plugin.length), plugin, registry]) };
}
test('standard Core accounts match the official serializers', () => {
  assert.deepEqual(checkFeeNftAccount(account()), { owner, collection });
  assert.equal(checkFeeNftAccount(account(true), true).owner, owner);
  for (const kind of [0, 6, 9, 10, 11, 12, 13, 14]) {
    assert.equal(checkFeeNftAccount(account(false, kind)).owner, owner);
    assert.equal(checkFeeNftAccount(account(true, kind), true).owner, owner);
  }
});
test('permanent ownership powers, execution plugins, compression and unknown types fail closed', () => {
  for (const kind of [5, 7, 8, 15, 16, 17, 18, 19, 255]) {
    assert.throws(() => checkFeeNftAccount(account(false, kind)));
    assert.throws(() => checkFeeNftAccount(account(true, kind), true));
  }
  assert.throws(() => checkFeeNftAccount(account(false, undefined, 1)));
  assert.throws(() => checkFeeNftAccount({ ...account(), owner: Keypair.generate().publicKey }));
});
test('truncated headers, invalid offsets and hidden registry records are refused', () => {
  const valid = account(false, 6);
  for (let i = 0; i < valid.data.length; i++) if (i !== account().data.length) assert.throws(() => checkFeeNftAccount({ ...valid, data: valid.data.subarray(0, i) }));
  const bad = account(false, 6); const base = account().data.length;
  bad.data.writeBigUInt64LE(0xffffffffffffffffn, base + 1);
  assert.throws(() => checkFeeNftAccount(bad));
  assert.throws(() => checkFeeNftAccount({ ...valid, data: Buffer.concat([valid.data, Buffer.from([7])]) }));
});
test('freeze authority and transfer-changing fee token extensions are refused', () => {
  const mint = { freezeAuthority: null, tlvData: Buffer.alloc(0) };
  checkFeeMint(mint);
  assert.throws(() => checkFeeMint({ ...mint, freezeAuthority: owner }), /freeze authority/);
  checkFeeMint({ ...mint, tlvData: Buffer.concat([Buffer.from([18, 0, 0, 0]), Buffer.from([19, 0, 1, 0, 0])]) });
  for (const kind of [1, 6, 9, 12, 14, 16, 26, 255]) assert.throws(() => checkFeeMint({ ...mint, tlvData: Buffer.from([kind, 0, 0, 0]) }));
  for (const bytes of [[18, 0, 5, 0], [18, 0, 0], [18, 0, 0, 0, 18, 0, 0, 0], [18, 0, 0, 0, 9]]) assert.throws(() => checkFeeMint({ ...mint, tlvData: Buffer.from(bytes) }));
});
test('actual mainnet genesis requires independent review before backing', () => {
  assert.equal(MAINNET_GENESIS, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
  assert.throws(() => checkFeeBackingRelease(MAINNET_GENESIS), { code: 'FEE_SECURITY_REVIEW' });
  checkFeeBackingRelease(DEVNET_GENESIS);
  checkFeeBackingRelease('isolated-validator');
});
test('wallet proposals use full RPC genesis hashes for mainnet and devnet', () => {
  assert.equal(feeWalletChain('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'), 'solana:mainnet');
  assert.equal(feeWalletChain('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'), 'solana:devnet');
  assert.equal(feeWalletChain('isolated-validator'), 'solana:localnet');
});
test('native Meteora freeze authority is restricted to its verified pool', () => {
  const pool = Keypair.generate().publicKey;
  const mint = { freezeAuthority: pool, decimals: 0, supply: 1n, tlvData: Buffer.from([3, 0, 0, 0]) };
  checkFeeMint(mint, { venue: 'meteora', pool: pool.toBase58() });
  assert.throws(() => checkFeeMint(mint, { venue: 'meteora', pool: address() }));
  assert.throws(() => checkFeeMint(mint));
  assert.throws(() => checkFeeMint({ ...mint, supply: 2n }, { venue: 'meteora', pool: pool.toBase58() }));
});
