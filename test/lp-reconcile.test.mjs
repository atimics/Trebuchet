import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { CLMM_PROGRAM_ID, CLMM_LOCK_PROGRAM_ID, LockClPositionLayoutV2, PositionInfoLayout, getPdaPersonalPositionAddress, getPdaLockClPositionIdV2 } from '@raydium-io/raydium-sdk-v2';

import { unrecordedPositionsAtRange, findUnrecordedPositionAt, positionLockedOnChain } from '../lpService.js';

function positionAccount(mint) {
  const data = Buffer.alloc(PositionInfoLayout.span);
  PositionInfoLayout.encode({ ...PositionInfoLayout.decode(data), nftMint: new PublicKey(mint) }, data);
  return { owner: CLMM_PROGRAM_ID, data };
}

// unrecordedPositionsAtRange is the pure core of the resume-time on-chain
// reconciliation: given the positions the launch wallet actually holds and a
// target tick range, it returns the ones at that range that the journal does
// not already know about (by nftMint). Those are positions that landed on-chain
// but whose confirmation never made it into the journal, and must be adopted —
// not reopened — on resume.

test('returns an on-chain position at the range that is not recorded', () => {
  const onChain = [{ nftMint: 'A', tickLower: -100, tickUpper: 100 }];
  const out = unrecordedPositionsAtRange(onChain, -100, 100, new Set());
  assert.equal(out.length, 1);
  assert.equal(out[0].nftMint, 'A');
});

test('excludes a position whose nftMint is already recorded in the journal', () => {
  const onChain = [{ nftMint: 'A', tickLower: -100, tickUpper: 100 }];
  const out = unrecordedPositionsAtRange(onChain, -100, 100, new Set(['A']));
  assert.equal(out.length, 0);
});

test('excludes a position at a different tick range', () => {
  const onChain = [{ nftMint: 'A', tickLower: -100, tickUpper: 100 }];
  assert.equal(unrecordedPositionsAtRange(onChain, -120, 120, new Set()).length, 0);
  assert.equal(unrecordedPositionsAtRange(onChain, -100, 120, new Set()).length, 0);
  assert.equal(unrecordedPositionsAtRange(onChain, -120, 100, new Set()).length, 0);
});

test('tolerates an empty or missing on-chain list', () => {
  assert.equal(unrecordedPositionsAtRange([], -100, 100, new Set()).length, 0);
  assert.equal(unrecordedPositionsAtRange(undefined, -100, 100, new Set()).length, 0);
});

test('returns every unrecorded match at one range (main slices share a range)', () => {
  const onChain = [
    { nftMint: 'A', tickLower: -100, tickUpper: 100 },
    { nftMint: 'B', tickLower: -100, tickUpper: 100 },
    { nftMint: 'C', tickLower: -100, tickUpper: 100 },
  ];
  const out = unrecordedPositionsAtRange(onChain, -100, 100, new Set(['A']));
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((p) => p.nftMint), ['B', 'C']);
});

test('compares tick values numerically (string ticks still match)', () => {
  const onChain = [{ nftMint: 'A', tickLower: '-100', tickUpper: '100' }];
  assert.equal(unrecordedPositionsAtRange(onChain, -100, 100, new Set()).length, 1);
});

test('skips malformed entries (null, or missing nftMint)', () => {
  const onChain = [null, { tickLower: -100, tickUpper: 100 }, { nftMint: 'A', tickLower: -100, tickUpper: 100 }];
  const out = unrecordedPositionsAtRange(onChain, -100, 100, new Set());
  assert.equal(out.length, 1);
  assert.equal(out[0].nftMint, 'A');
});


test('liquidity position reconciliation propagates failed and incomplete reads', async () => {
  const error = new Error('RPC timed out after the position send');
  for (const read of [async () => { throw error; }, async () => null]) {
    const raydium = { clmm: { getOwnerPositionInfo: read } };
    await assert.rejects(findUnrecordedPositionAt(raydium, 'pool', -100, 100, new Set()));
  }
  assert.equal(await findUnrecordedPositionAt({ clmm: { getOwnerPositionInfo: async () => [] } }, 'pool', -100, 100, new Set()), null);
  const raydium = { clmm: { getOwnerPositionInfo: async () => [{ poolId: 'pool', nftMint: 'landed', tickLower: -100, tickUpper: 100 }] } };
  assert.equal((await findUnrecordedPositionAt(raydium, 'pool', -100, 100, new Set())).nftMint, 'landed');
});

test('liquidity lock reconciliation requires a complete finalized read', async () => {
  let calls = 0;
  const raydium = { cluster: 'mainnet', connection: {
    getAccountInfo: async () => positionAccount(PublicKey.default),
    getProgramAccounts: async (_program, options) => {
    calls++;
    assert.equal(options.commitment, 'finalized');
    if (calls === 1) throw new Error('RPC timed out after the lock send');
    if (calls === 2) return null;
    if (calls === 3) return 'partial response';
    return [];
  } } };
  await assert.rejects(positionLockedOnChain(raydium, '11111111111111111111111111111111'));
  await assert.rejects(positionLockedOnChain(raydium, '11111111111111111111111111111111'));
  await assert.rejects(positionLockedOnChain(raydium, '11111111111111111111111111111111'));
  assert.equal(await positionLockedOnChain(raydium, '11111111111111111111111111111111'), null);
});


test('position recovery refreshes SDK wallet accounts before checking the chain', async () => {
  let refreshed = false;
  const raydium = {
    account: { fetchWalletTokenAccounts: async (options) => { assert.equal(options.forceUpdate, true); refreshed = true; } },
    clmm: { getOwnerPositionInfo: async () => { assert.equal(refreshed, true); return []; } },
  };
  assert.equal(await findUnrecordedPositionAt(raydium, 'pool', -10, 10, new Set()), null);
  raydium.account.fetchWalletTokenAccounts = async () => { throw new Error('Wallet read failed'); };
  await assert.rejects(findUnrecordedPositionAt(raydium, 'pool', -10, 10, new Set()), /Wallet read failed/);
});


test('lock recovery queries the deployed program and the derived personal position account', async () => {
  const mint = new PublicKey(new Uint8Array(32).fill(11)), feeKey = new PublicKey(new Uint8Array(32).fill(12));
  const position = getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, mint).publicKey;
  const data = Buffer.alloc(LockClPositionLayoutV2.span);
  LockClPositionLayoutV2.encode({ ...LockClPositionLayoutV2.decode(data), positionId: position, lockNftMint: feeKey }, data);
  const raydium = { cluster: 'mainnet', connection: {
    getAccountInfo: async (address, commitment) => {
      assert.equal(address.toBase58(), position.toBase58());
      assert.equal(commitment, 'finalized');
      return positionAccount(mint);
    },
    getProgramAccounts: async (program, options) => {
    assert.equal(program.toBase58(), CLMM_LOCK_PROGRAM_ID.toBase58());
    assert.equal(options.filters.find((filter) => filter.memcmp).memcmp.bytes, position.toBase58());
    return [{ pubkey: getPdaLockClPositionIdV2(CLMM_LOCK_PROGRAM_ID, feeKey).publicKey, account: { owner: CLMM_LOCK_PROGRAM_ID, data } }];
  } } };
  assert.equal(await positionLockedOnChain(raydium, mint.toBase58()), feeKey.toBase58());
});
