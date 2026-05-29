// test/helpers/mockRaydium.mjs
//
// A network-free fake of the Raydium SDK v2 surface that lpService.js drives
// during a launch. It implements exactly the methods the orchestrator and its
// phase helpers call, with deterministic return shapes matching the real SDK
// (verified against lpService.js call sites):
//
//   raydium.connection                         -> fake Connection
//   raydium.clmm.createPool(...)               -> { execute, extInfo:{ address:{ id } } }
//   raydium.clmm.getPoolInfoFromRpc(poolId)    -> { poolInfo, poolKeys }
//   raydium.clmm.getRpcClmmPoolInfo({poolId})  -> { tickCurrent, ... }
//   raydium.clmm.openPositionFromBase({...})   -> { execute, extInfo:{ nftMint } }
//   raydium.clmm.lockPosition({...})           -> { execute, extInfo }
//   raydium.api.getClmmConfigs()               -> [ ...configs ]
//   raydium.account.fetchWalletTokenAccounts() -> { tokenAccounts: [] }
//   execute({sendAndConfirm})                  -> { txId }
//
// Failure injection: pass a `fail` map keyed by operation name to a value that
// is either a count (throw on the Nth call) or `true` (throw on the first
// call). Supported keys: createPool, openPosition, lockPosition, getPoolInfo,
// getRpcClmmPoolInfo, fetchWalletTokenAccounts, getClmmConfigs.

import { PublicKey } from '@solana/web3.js';
import { makeFakeConnection } from './mockSolana.mjs';

let nftCounter = 0;
let txCounter = 0;
let poolCounter = 0;

// A handful of valid base58 pubkeys we can hand back as pool ids / nft mints.
// (PublicKey constructor validates base58, so we generate real ones.)
function freshPubkey() {
  // Deterministic-ish but unique per call.
  const bytes = new Uint8Array(32);
  let v = ++nftCounter + 1;
  for (let i = 0; i < 32 && v > 0; i++) {
    bytes[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  bytes[31] = (bytes[31] || 1); // avoid all-zero
  return new PublicKey(bytes);
}

function shouldFail(failMap, key) {
  if (!failMap || !(key in failMap)) return false;
  const spec = failMap[key];
  if (spec === true) return true;
  if (typeof spec === 'number') {
    // Decrement a hidden counter so "fail on Nth call" works.
    failMap.__counts = failMap.__counts || {};
    failMap.__counts[key] = (failMap.__counts[key] || 0) + 1;
    return failMap.__counts[key] === spec;
  }
  return false;
}

function failError(failMap, key, fallback) {
  const msgs = failMap?.messages || {};
  return new Error(msgs[key] || fallback || `injected ${key} failure`);
}

// Build an `execute` thunk that resolves to { txId } or throws if the matching
// op is flagged to fail.
function makeExecute(failMap, key) {
  return async ({ sendAndConfirm } = {}) => {
    void sendAndConfirm;
    if (shouldFail(failMap, key)) {
      throw failError(failMap, key, `injected ${key} execute failure`);
    }
    return { txId: `mock-tx-${++txCounter}` };
  };
}

export function makeMockRaydium({ fail = {}, connection } = {}) {
  const conn = connection || makeFakeConnection();

  const clmm = {
    async createPool() {
      if (shouldFail(fail, 'createPool')) throw failError(fail, 'createPool', 'createPool failed');
      const id = freshPubkey().toBase58();
      poolCounter += 1;
      return {
        execute: makeExecute(fail, 'createPool'),
        extInfo: { address: { id } },
      };
    },

    async getPoolInfoFromRpc(poolId) {
      if (shouldFail(fail, 'getPoolInfo')) throw failError(fail, 'getPoolInfo', 'getPoolInfoFromRpc failed');
      return {
        poolInfo: {
          id: poolId,
          mintA: { address: '__LAUNCHED__', decimals: 9, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
          mintB: { address: 'So11111111111111111111111111111111111111112', decimals: 9, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
          config: { tickSpacing: 60, id: 'mock-config' },
        },
        poolKeys: { id: poolId },
      };
    },

    async getRpcClmmPoolInfo() {
      if (shouldFail(fail, 'getRpcClmmPoolInfo')) throw failError(fail, 'getRpcClmmPoolInfo', 'getRpcClmmPoolInfo failed');
      return {
        tickCurrent: 0,
        sqrtPriceX64: '79228162514264337593543950336',
        liquidity: '0',
      };
    },

    async openPositionFromBase() {
      if (shouldFail(fail, 'openPosition')) throw failError(fail, 'openPosition', 'openPositionFromBase failed');
      const nftMint = freshPubkey();
      return {
        execute: makeExecute(fail, 'openPosition'),
        extInfo: { nftMint },
      };
    },

    async lockPosition() {
      if (shouldFail(fail, 'lockPosition')) throw failError(fail, 'lockPosition', 'lockPosition failed');
      const nftMint = freshPubkey();
      return {
        execute: makeExecute(fail, 'lockPosition'),
        extInfo: { nftMint },
      };
    },
  };

  const api = {
    async getClmmConfigs() {
      if (shouldFail(fail, 'getClmmConfigs')) throw failError(fail, 'getClmmConfigs', 'getClmmConfigs failed');
      return [
        { id: 'mock-config', index: 0, tickSpacing: 60, tradeFeeRate: 2500, protocolFeeRate: 120000, fundFeeRate: 40000 },
      ];
    },
  };

  const account = {
    async fetchWalletTokenAccounts() {
      if (shouldFail(fail, 'fetchWalletTokenAccounts')) {
        throw failError(fail, 'fetchWalletTokenAccounts', 'fetchWalletTokenAccounts failed');
      }
      return { tokenAccounts: [], tokenAccountRawInfos: [] };
    },
  };

  return { connection: conn, clmm, api, account, __fail: fail };
}

// Build a single `results` entry shaped exactly like what createSinglePool /
// openBootstrapPosition produce, so we can drive lockAllPositions and
// transferFeeKeys directly. nftMints are real base58 pubkeys (lockPosition /
// transferNftToRecipient wrap them in `new PublicKey(...)`).
export function makeResultEntry({
  allocationIndex = 0,
  quoteSymbol = 'SOL',
  poolId = freshPubkey().toBase58(),
  mainCount = 1,
  withBootstrap = true,
  recipients = [],
} = {}) {
  const mainPositions = [];
  for (let i = 0; i < mainCount; i++) {
    mainPositions.push({
      sliceIndex: i,
      sharePercent: 100 / mainCount,
      nftMint: freshPubkey().toBase58(),
      locked: false,
      recipient: recipients[i] || null,
      transferredTo: null,
      txIds: { open: `open-${i}`, lock: null, transfer: null },
    });
  }
  const entry = {
    allocationIndex,
    quoteSymbol,
    poolId,
    mainPositions,
    ladderPositions: [],
    bootstrap: withBootstrap
      ? { nftMint: freshPubkey().toBase58(), locked: false, txIds: { open: 'bs-open', lock: null } }
      : null,
    txIds: { createPool: `createPool-${allocationIndex}` },
  };
  return entry;
}
