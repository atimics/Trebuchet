import test from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { CollectFeeMode, CpAmm, derivePositionAddress } from '@meteora-ag/cp-amm-sdk';
import { dammV2PriceRange, verifyLockedPool } from '../dammV2Service.js';

const supplyRaw = 1_000_000_000n * 10n ** 9n;
const startingMarketCapLamports = 25_000_000n * 10n ** 9n;
const rangeMultiple = 1_000;

function fixture(t, { soldTokens = 0n, wrongNft = false, wrongRange = false, lessLocked = false } = {}) {
  const mint = Keypair.generate().publicKey;
  const pool = Keypair.generate().publicKey;
  const positionNft = Keypair.generate().publicKey;
  const position = derivePositionAddress(positionNft);
  const vault = Keypair.generate().publicKey;
  const range = dammV2PriceRange({ supplyRaw, startingMarketCapLamports, rangeMultiple });
  const cpAmm = new CpAmm({});
  const expectedLiquidity = cpAmm.preparePoolCreationSingleSide({
    tokenAAmount: new BN(supplyRaw.toString()),
    minSqrtPrice: range.sqrtMinPrice,
    maxSqrtPrice: range.sqrtMaxPrice,
    initSqrtPrice: range.initSqrtPrice,
    collectFeeMode: CollectFeeMode.OnlyB,
  });
  const poolState = {
    tokenAMint: mint,
    tokenBMint: NATIVE_MINT,
    tokenAVault: vault,
    sqrtMinPrice: range.sqrtMinPrice,
    sqrtMaxPrice: wrongRange ? range.sqrtMaxPrice.addn(1) : range.sqrtMaxPrice,
    collectFeeMode: CollectFeeMode.OnlyB,
  };
  const positionState = {
    pool,
    nftMint: wrongNft ? Keypair.generate().publicKey : positionNft,
    permanentLockedLiquidity: lessLocked ? expectedLiquidity.subn(1) : expectedLiquidity,
    unlockedLiquidity: { isZero: () => true },
  };
  const vaultData = Buffer.alloc(165);
  mint.toBuffer().copy(vaultData, 0);
  pool.toBuffer().copy(vaultData, 32);
  vaultData.writeBigUInt64LE(supplyRaw - soldTokens, 64);
  vaultData[108] = 1; // Initialized SPL token account.
  const connection = {
    async getAccountInfo(key) {
      if (key.equals(mint)) return { owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(82), lamports: 1, executable: false };
      if (key.equals(vault)) return { owner: TOKEN_2022_PROGRAM_ID, data: vaultData, lamports: 1, executable: false };
      return null;
    },
  };

  t.mock.method(CpAmm.prototype, 'fetchPoolState', async () => poolState);
  t.mock.method(CpAmm.prototype, 'fetchPositionState', async () => positionState);
  t.mock.method(CpAmm.prototype, 'isPermanentLockedPosition', () => true);

  return { connection, pool, position, positionNft, mint, poolState, positionState };
}

async function verify(t, options = {}) {
  const state = fixture(t, options);
  const checks = await verifyLockedPool({
    ...state,
    supplyRaw,
    startingMarketCapLamports,
    rangeMultiple,
    quoteMint: NATIVE_MINT,
  });
  return { ...state, checks };
}

test('adopts a valid locked pool after buyers have traded tokens from its vault', async (t) => {
  const { checks } = await verify(t, { soldTokens: supplyRaw / 10n });

  assert.equal(checks.positionInPool, true);
  assert.equal(checks.positionNftMatchesPlan, true);
  assert.equal(checks.poolRangeMatchesPlan, true);
  assert.equal(checks.permanentlyLocked, true);
  assert.equal(checks.nothingWithdrawable, true);
  assert.equal(checks.lockedSupply, true);
  assert.equal(checks.vaultHoldsSupply, false, 'trading reduced the live vault balance');
  assert.equal(checks.passed, true, 'the locked position proves the original supply remains committed');
});

test('rejects a position NFT that differs from the saved launch position', async (t) => {
  const { checks } = await verify(t, { wrongNft: true });

  assert.equal(checks.positionNftMatchesPlan, false);
  assert.equal(checks.passed, false);
});

test('rejects a pool whose saved price range differs from the launch plan', async (t) => {
  const { checks } = await verify(t, { wrongRange: true });

  assert.equal(checks.poolRangeMatchesPlan, false);
  assert.equal(checks.passed, false);
});

test('rejects a position that does not retain the expected permanently locked liquidity', async (t) => {
  const { checks } = await verify(t, { lessLocked: true });

  assert.equal(checks.lockedSupply, false);
  assert.equal(checks.passed, false);
});

test('requires the saved range and position NFT before verification', async () => {
  await assert.rejects(
    verifyLockedPool({ connection: {}, pool: new PublicKey(NATIVE_MINT), position: new PublicKey(NATIVE_MINT), mint: new PublicKey(NATIVE_MINT), supplyRaw }),
    /saved pool price range and position NFT/,
  );
});
