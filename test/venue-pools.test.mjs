// Orca and Meteora pool readers: account decoding and pricing, offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import { PublicKey } from '@solana/web3.js';

import {
  VENUE_PROGRAMS,
  decodeWhirlpool,
  decodeDlmmPair,
  decodeDammV2Pool,
  decodePumpSwapPool, decodePumpCurve, pumpPoolAddresses, fetchVenuePoolsByMints, clearPoolDiscoveryCache,
} from '../venuePoolService.js';
import {
  evaluatePool,
  dlmmPriceYPerX,
  poolReaderKind,
  WSOL_MINT,
  USDC_MINT,
} from '../onChainPriceService.js';

const TOKEN = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const VAULT_A = 'Vau1tA1111111111111111111111111111111111111';
const VAULT_B = 'Vau1tB1111111111111111111111111111111111111';
const TWO64 = new Decimal(2).pow(64);

function putKey(buf, offset, key) {
  Buffer.from(new PublicKey(key).toBytes()).copy(buf, offset);
}
function putU128(buf, offset, value) {
  const v = BigInt(value);
  buf.writeBigUInt64LE(v & ((1n << 64n) - 1n), offset);
  buf.writeBigUInt64LE(v >> 64n, offset + 8);
}
function sqrtX64For(priceBPerA, decA, decB) {
  return BigInt(new Decimal(priceBPerA).mul(new Decimal(10).pow(decB - decA)).sqrt().mul(TWO64).toFixed(0));
}

test('Orca Whirlpool decodes mints, vaults, sqrt price, and liquidity at IDL offsets', () => {
  const data = Buffer.alloc(653);
  putU128(data, 49, 5000n);
  putU128(data, 65, sqrtX64For(120, 9, 6));
  putKey(data, 101, WSOL_MINT);
  putKey(data, 133, VAULT_A);
  putKey(data, 181, USDC_MINT);
  putKey(data, 213, VAULT_B);
  const st = decodeWhirlpool(data);
  assert.equal(st.mintA, WSOL_MINT);
  assert.equal(st.mintB, USDC_MINT);
  assert.equal(st.vaultA, VAULT_A);
  assert.equal(st.vaultB, VAULT_B);
  assert.equal(st.liquidity, 5000n);
  assert.equal(st.kind, 'sqrt');
});

test('Meteora DLMM decodes the active bin and mints; bins price by (1 + step)^id', () => {
  const data = Buffer.alloc(904);
  data.writeInt32LE(-3000, 76);
  data.writeUInt16LE(10, 80);
  putKey(data, 88, TOKEN);
  putKey(data, 120, WSOL_MINT);
  putKey(data, 152, VAULT_A);
  putKey(data, 184, VAULT_B);
  const st = decodeDlmmPair(data);
  assert.deepEqual([st.activeId, st.binStep, st.mintA, st.mintB, st.kind], [-3000, 10, TOKEN, WSOL_MINT, 'bin']);
  // 1.001^-3000 in raw units, scaled from 6-decimal X to 9-decimal Y.
  const expected = new Decimal(1.001).pow(-3000).mul(new Decimal(10).pow(6 - 9));
  assert.equal(dlmmPriceYPerX(-3000, 10, 6, 9).toSignificantDigits(12).toString(), expected.toSignificantDigits(12).toString());
});

test('Meteora DAMM v2 decodes mints, vaults, liquidity, and sqrt price at IDL offsets', () => {
  const data = Buffer.alloc(1112);
  putKey(data, 168, TOKEN);
  putKey(data, 200, WSOL_MINT);
  putKey(data, 232, VAULT_A);
  putKey(data, 264, VAULT_B);
  putU128(data, 360, 42n);
  putU128(data, 456, 123456789n);
  const st = decodeDammV2Pool(data);
  assert.deepEqual([st.mintA, st.mintB, st.vaultA, st.vaultB, st.liquidity, st.sqrtPriceX64], [TOKEN, WSOL_MINT, VAULT_A, VAULT_B, 42n, 123456789n]);
});

function venuePool({ venue, programId, state, decA = 6, decB = 9 }) {
  return {
    id: `${venue}-pool`,
    programId,
    venue,
    mintA: { address: TOKEN, decimals: decA },
    mintB: { address: WSOL_MINT, decimals: decB },
    state: { mintA: TOKEN, mintB: WSOL_MINT, ...state },
  };
}

test('an Orca pool prices the token in SOL and counts only the SOL side as depth', async () => {
  const pool = venuePool({
    venue: 'orca-whirlpool',
    programId: VENUE_PROGRAMS.ORCA_WHIRLPOOL,
    state: { kind: 'sqrt', sqrtPriceX64: sqrtX64For(0.001, 6, 9), liquidity: 10n, reserveA: 5_000_000_000n, reserveB: 2_000_000_000n },
  });
  assert.equal(poolReaderKind(pool), 'venue');
  const c = await evaluatePool(pool, { mint: TOKEN, solUsd: new Decimal(100) });
  assert.equal(c.kind, 'orca-whirlpool');
  assert.equal(c.anchorSymbol, 'SOL');
  assert.equal(c.priceUsd.toDecimalPlaces(6).toString(), '0.1');
  // 2 SOL on the SOL side at $100, doubled.
  assert.equal(c.liquidityUsd.toString(), '400');
  assert.equal(c.inRange, true);
});

test('a Meteora pool with an empty side or no liquidity is not in range', async () => {
  const empty = venuePool({
    venue: 'meteora-damm-v2',
    programId: VENUE_PROGRAMS.METEORA_DAMM_V2,
    state: { kind: 'sqrt', sqrtPriceX64: sqrtX64For(0.001, 6, 9), liquidity: 1n, reserveA: 1_000n, reserveB: 0n },
  });
  assert.equal((await evaluatePool(empty, { mint: TOKEN, solUsd: new Decimal(100) })).inRange, false);
  const noLiquidity = venuePool({
    venue: 'meteora-damm-v2',
    programId: VENUE_PROGRAMS.METEORA_DAMM_V2,
    state: { kind: 'sqrt', sqrtPriceX64: sqrtX64For(0.001, 6, 9), liquidity: 0n, reserveA: 1_000n, reserveB: 1_000n },
  });
  assert.equal((await evaluatePool(noLiquidity, { mint: TOKEN, solUsd: new Decimal(100) })).inRange, false);
});

test('a SOL-paired venue pool is skipped when SOL has no USD price', async () => {
  const pool = venuePool({
    venue: 'meteora-dlmm',
    programId: VENUE_PROGRAMS.METEORA_DLMM,
    state: { kind: 'bin', activeId: 0, binStep: 10, reserveA: 1n, reserveB: 1n },
  });
  assert.equal(await evaluatePool(pool, { mint: TOKEN, solUsd: null }), null);
});

const PUMP_DISC = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
function pumpAccount() {
  const data = Buffer.alloc(301);
  PUMP_DISC.copy(data); putKey(data, 43, TOKEN); putKey(data, 75, WSOL_MINT);
  putKey(data, 139, VAULT_A); putKey(data, 171, VAULT_B);
  return data;
}

test('PumpSwap decodes the variable account size and prices actual reserves', async () => {
  const st = decodePumpSwapPool(pumpAccount());
  assert.deepEqual([st.mintA, st.mintB, st.vaultA, st.vaultB], [TOKEN, WSOL_MINT, VAULT_A, VAULT_B]);
  const pool = venuePool({ venue: 'pump-swap', programId: VENUE_PROGRAMS.PUMP_SWAP,
    state: { ...st, reserveA: 100_000_000_000n, reserveB: 1_000_000_000n } });
  const result = await evaluatePool(pool, { mint: TOKEN, solUsd: new Decimal(100) });
  assert.equal(result.priceUsd.toString(), '0.001');
  assert.equal(result.liquidityUsd.toString(), '200');
  assert.equal(result.inRange, true);
  assert.equal(decodePumpSwapPool(pumpAccount().subarray(0, 211)).kind, 'reserve');
  assert.throws(() => decodePumpSwapPool(Buffer.alloc(301)), /Invalid/);
  const extended = pumpAccount(); putU128(extended, 245, 1n);
  assert.throws(() => decodePumpSwapPool(extended), /virtual-reserve/);
});

test('Pump curve prices virtual reserves and counts real funds, then retires after migration', async () => {
  const data = Buffer.alloc(151); Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]).copy(data);
  data.writeBigUInt64LE(100_000_000_000n, 8); data.writeBigUInt64LE(10_000_000_000n, 16);
  data.writeBigUInt64LE(5_000_000_000n, 24); data.writeBigUInt64LE(1_000_000_000n, 32);
  const pool = venuePool({ venue: 'pump-curve', programId: VENUE_PROGRAMS.PUMP_CURVE, state: decodePumpCurve(data, TOKEN) });
  const result = await evaluatePool(pool, { mint: TOKEN, solUsd: new Decimal(100) });
  assert.equal(result.priceUsd.toString(), '0.01'); assert.equal(result.liquidityUsd.toString(), '200');
  assert.equal(result.inRange, true);
  data[48] = 1; pool.state = decodePumpCurve(data, TOKEN);
  assert.equal((await evaluatePool(pool, { mint: TOKEN, solUsd: new Decimal(100) })).inRange, false);
  putKey(data, 83, USDC_MINT);
  assert.equal(decodePumpCurve(data, TOKEN).mintB, USDC_MINT);
});

test('the migrated SI276 pool can be found by its canonical address', () => {
  assert.equal(pumpPoolAddresses('HMYd9tosnUXuNHmq7pXmoePRVBLBBjA3JBfydq6upump', WSOL_MINT)[0].id,
    '12jc1DzJpzbCDaKuM4brAKh9jcFry2TLG1FfGsL4ftCG');
});

test('price reads reuse discovery while fresh pool state changes the displayed price', async () => {
  clearPoolDiscoveryCache();
  const id = new PublicKey(USDC_MINT); let scans = 0;
  const data = Buffer.alloc(653); putKey(data, 101, TOKEN); putKey(data, 181, WSOL_MINT);
  putKey(data, 133, VAULT_A); putKey(data, 213, VAULT_B); putU128(data, 49, 1n);
  putU128(data, 65, sqrtX64For(0.001, 6, 9));
  const mintA = Buffer.alloc(82); mintA[44] = 6; const mintB = Buffer.alloc(82); mintB[44] = 9;
  const vaultA = Buffer.alloc(165); vaultA.writeBigUInt64LE(1_000_000_000n, 64);
  const vaultB = Buffer.alloc(165); vaultB.writeBigUInt64LE(1_000_000_000n, 64);
  const accounts = new Map([[USDC_MINT, { data, owner: new PublicKey(VENUE_PROGRAMS.ORCA_WHIRLPOOL) }],
    [TOKEN, { data: mintA }], [WSOL_MINT, { data: mintB }], [VAULT_A, { data: vaultA }], [VAULT_B, { data: vaultB }]]);
  const connection = { rpcEndpoint: 'fresh-price-test',
    getProgramAccounts: async (program, opts) => { scans++; return program.toBase58() === VENUE_PROGRAMS.ORCA_WHIRLPOOL
      && opts.filters[1].memcmp.bytes === TOKEN ? [{ pubkey: id, account: accounts.get(USDC_MINT) }] : []; },
    getMultipleAccountsInfo: async (keys) => keys.map((key) => accounts.get(key.toBase58()) || null) };
  const first = (await fetchVenuePoolsByMints(connection, TOKEN, WSOL_MINT))[0];
  const count = scans; putU128(data, 65, sqrtX64For(0.002, 6, 9));
  const second = (await fetchVenuePoolsByMints(connection, TOKEN, WSOL_MINT))[0];
  assert.equal(scans, count); assert.notEqual(first.state.sqrtPriceX64, second.state.sqrtPriceX64);
  const options = { mint: TOKEN, solUsd: new Decimal(100) };
  assert.equal((await evaluatePool(first, options)).priceUsd.toDecimalPlaces(6).toString(), '0.1');
  assert.equal((await evaluatePool(second, options)).priceUsd.toDecimalPlaces(6).toString(), '0.2');
  accounts.get(USDC_MINT).owner = new PublicKey(VENUE_PROGRAMS.PUMP_SWAP);
  assert.equal((await fetchVenuePoolsByMints(connection, TOKEN, WSOL_MINT)).length, 0);
});
