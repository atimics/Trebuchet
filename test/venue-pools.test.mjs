// Orca and Meteora pool readers: account decoding and pricing, offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import { PublicKey } from '@solana/web3.js';

import {
  VENUE_PROGRAMS,
  decodeWhirlpool,
  decodePumpSwapPool,
  fetchVenuePoolsByMints,
  clearPoolDiscoveryCache,
  decodeDlmmPair,
  decodeDammV2Pool,
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

function pumpData() {
  const data = Buffer.alloc(287);
  Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]).copy(data);
  putKey(data, 43, TOKEN); putKey(data, 75, WSOL_MINT);
  putKey(data, 139, VAULT_A); putKey(data, 171, VAULT_B);
  return data;
}

test('PumpSwap prices standard pools from vault reserves in either direction', async () => {
  const state = { ...decodePumpSwapPool(pumpData()), reserveA: 1000000000n, reserveB: 2000000000n };
  const pool = { id: TOKEN, programId: VENUE_PROGRAMS.PUMP_SWAP, venue: 'pumpswap',
    mintA: { address: TOKEN, decimals: 6 }, mintB: { address: WSOL_MINT, decimals: 9 }, state };
  const result = await evaluatePool(pool, { mint: TOKEN, solUsd: new Decimal(100) });
  assert.equal(result.priceUsd.toString(), '0.2'); assert.equal(result.liquidityUsd.toString(), '400');
  assert.equal(result.inRange, true);
  const reverse = await evaluatePool({ ...pool, mintA: pool.mintB, mintB: pool.mintA,
    state: { ...state, reserveA: state.reserveB, reserveB: state.reserveA } }, { mint: TOKEN, solUsd: new Decimal(100) });
  assert.equal(reverse.priceUsd.toString(), '0.2');
  assert.equal(decodePumpSwapPool(Buffer.alloc(287)), null);
  const boost = pumpData(); boost[245] = 1;
  assert.equal(decodePumpSwapPool(boost), null, 'virtual reserve pools need their own curve');
});

test('cached discovery reads current pool state and current fee balances', async () => {
  clearPoolDiscoveryCache();
  const data = pumpData(); let scans = 0;
  const mint = (decimals) => { const b = Buffer.alloc(82); b[44] = decimals; return b; };
  const vault = (amount) => { const b = Buffer.alloc(165); b.writeBigUInt64LE(amount, 64); return b; };
  const poolKey = new PublicKey('11111111111111111111111111111111');
  const accountData = new Map([[poolKey.toBase58(), data], [TOKEN, mint(6)], [WSOL_MINT, mint(9)],
    [VAULT_A, vault(1000000000n)], [VAULT_B, vault(2000000000n)]]);
  const connection = { rpcEndpoint: 'pump-fixture',
    getProgramAccounts: async (program, opts) => {
      scans++;
      return program.toBase58() === VENUE_PROGRAMS.PUMP_SWAP && opts.filters[1].memcmp.bytes === TOKEN
        ? [{ pubkey: poolKey, account: { data: Buffer.from(data) } }] : [];
    },
    getMultipleAccountsInfo: async (keys) => keys.map((key) => ({ data: accountData.get(key.toBase58()) })),
  };
  const first = await fetchVenuePoolsByMints(connection, TOKEN, WSOL_MINT);
  assert.equal(first[0].state.reserveB, 2000000000n);
  data.writeBigUInt64LE(100000000n, 271);
  const second = await fetchVenuePoolsByMints(connection, TOKEN, WSOL_MINT);
  assert.equal(second[0].state.reserveB, 1900000000n);
  assert.equal(scans, 8, 'current state reuses discovered pool addresses');
});
