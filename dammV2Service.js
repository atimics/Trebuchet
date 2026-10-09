// dammV2Service.js
//
// Chain work for the lean Meteora DAMM v2 launch. Pure planning (config, price
// model, cost) lives in @trebuchet/core/damm-v2-plan.
//
// The launch is one pool holding the whole supply in a single position:
//   - single-sided: tokens only, no SOL seed. The price range starts at the
//     starting market cap and runs up from there, so buyers supply the SOL.
//   - the position is locked permanently inside the pool-creation transaction
//     (isLockLiquidity), so there is never a window with withdrawable liquidity.
//   - the new token is always side A and SOL side B, with fees collected in the
//     quote side only, so fee claims pay out in SOL.
//
// Verified against the real DAMM v2 program on a local validator
// (scripts/damm-v2-localnet-probe.mjs and test/e2e/v2-damm-localnet.mjs).

import BN from 'bn.js';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  ActivationType,
  BaseFeeMode,
  CP_AMM_PROGRAM_ID,
  CollectFeeMode,
  CpAmm,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  deriveCustomizablePoolAddress,
  derivePositionAddress,
  derivePositionNftAccount,
  getBaseFeeParams,
  getDynamicFeeParams,
  getPriceFromSqrtPrice,
} from '@meteora-ag/cp-amm-sdk';

// Fee claiming for Meteora DAMM v2 lives in @trebuchet/claimer/venues/damm
// (shared with the sealed runner). These functions re-export it so the launch
// layer's callers are unchanged.
import * as claimerDamm from '@trebuchet/claimer/venues/damm';

export const DAMM_V2_PROGRAM_ID = CP_AMM_PROGRAM_ID;
export const SOL_DECIMALS = 9;
const POOL_COMPUTE_UNITS = 500_000;

function bn(value) {
  return new BN(value.toString());
}

// Integer square root of a non-negative BigInt (Newton's method).
export function bigSqrt(value) {
  if (value < 0n) throw new RangeError('square root of a negative number');
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + value / x) >> 1n;
  }
  return x;
}

/**
 * The pool's price curve, as the exact integers the program stores.
 *
 * `price` is B (lamports) per A (raw token unit). The starting price is the
 * starting market cap over the supply; the range runs from there to
 * `rangeMultiple` times that price. Q64.64 square roots, integer math only.
 */
export function dammV2PriceRange({ supplyRaw, startingMarketCapLamports, rangeMultiple }) {
  const supply = BigInt(supplyRaw);
  const mcap = BigInt(startingMarketCapLamports);
  const multiple = BigInt(Math.round(Number(rangeMultiple)));
  if (supply <= 0n) throw new RangeError('supply must be positive');
  if (mcap <= 0n) throw new RangeError('starting market cap must be positive');
  if (multiple < 2n) throw new RangeError('range multiple must be at least 2');
  // sqrt(price) * 2^64 = sqrt(mcap * 2^128 / supply)
  const sqrtStart = bigSqrt((mcap << 128n) / supply);
  const sqrtEnd = bigSqrt(sqrtStart * sqrtStart * multiple);
  const min = BigInt(MIN_SQRT_PRICE.toString());
  const max = BigInt(MAX_SQRT_PRICE.toString());
  if (sqrtStart < min || sqrtEnd > max) throw new RangeError('price range is outside what the pool can represent');
  return { initSqrtPrice: bn(sqrtStart), sqrtMinPrice: bn(sqrtStart), sqrtMaxPrice: bn(sqrtEnd) };
}

/** Recover a compatible raw quote value from the immutable lower pool bound. */
export function dammV2MarketCapFromSqrtMin({ supplyRaw, sqrtMinPrice, rangeMultiple }) {
  const supply = BigInt(supplyRaw);
  const sqrtMin = BigInt(sqrtMinPrice.toString());
  if (supply <= 0n || sqrtMin <= 0n) throw new RangeError('pool range and supply must be positive');
  const q128 = 1n << 128n;
  const numerator = sqrtMin * sqrtMin * supply;
  const startingMarketCapLamports = (numerator + q128 - 1n) / q128;
  const recoveredRange = dammV2PriceRange({ supplyRaw, startingMarketCapLamports, rangeMultiple });
  if (!recoveredRange.sqrtMinPrice.eq(new BN(sqrtMin.toString()))) {
    throw new Error('The pool lower price bound cannot be reconstructed from its supply.');
  }
  return startingMarketCapLamports;
}

export function tokenProgramFor(mintAccountOwner) {
  return mintAccountOwner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

async function mintOwnerProgram(connection, mint) {
  const info = await connection.getAccountInfo(mint, 'confirmed');
  if (!info) throw new Error(`mint ${mint.toBase58()} not found on this network`);
  return tokenProgramFor(info.owner);
}

/**
 * Build the pool-creation transaction. Nothing is sent. The creator must hold
 * `supplyRaw` of the token. Returns the transaction and the keypair of the new
 * position NFT, which also has to sign.
 */
/**
 * Translate a normalized Meteora DAMM v2 fee schedule (the pure
 * `normalizeDammFeePlan` in @trebuchet/core/damm-v2-plan) into the
 * pool-fees struct the program stores. Every model expresses its schedule
 * in bps; `dynamic` adds the volatility-dynamic surcharge on top of the
 * base fee. Pure apart from the SDK's encoder, so it can be unit-tested.
 *
 * models: fixed | ramp | marketcap | dynamic.
 */
export function buildPoolFees({ model = 'fixed', bps, ramp = {}, dynamic = {}, marketcap = {} } = {}) {
  const start = Number(bps) || 25;
  const flat = () => ({
    baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear,
    feeTimeSchedulerParam: { startingFeeBps: start, endingFeeBps: start, numberOfPeriod: 0, totalDuration: 0 },
  });
  switch (model) {
    case 'ramp':
      return {
        baseFee: getBaseFeeParams({
          baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear,
          feeTimeSchedulerParam: {
            startingFeeBps: start,
            endingFeeBps: Number(ramp.endBps) ?? start,
            numberOfPeriod: 1,
            totalDuration: Number(ramp.durationSec) || 30 * 24 * 3600,
          },
        }),
        dynamicFee: null,
      };
    case 'marketcap':
      return {
        baseFee: getBaseFeeParams({
          baseFeeMode: BaseFeeMode.FeeMarketCapSchedulerLinear,
          feeMarketCapSchedulerParam: {
            startingFeeBps: start,
            endingFeeBps: Number(marketcap.endBps) ?? start,
            numberOfPeriod: 1,
            priceMultiple: Number(marketcap.priceMultiple) || 10,
            schedulerExpirationDuration: Number(marketcap.expirationSec) || 30 * 24 * 3600,
          },
        }),
        dynamicFee: null,
      };
    case 'dynamic':
      return {
        baseFee: getBaseFeeParams(flat()),
        dynamicFee: getDynamicFeeParams(start, Number(dynamic.maxPriceChangeBps) || 500),
      };
    case 'fixed':
      return { baseFee: getBaseFeeParams(flat()), dynamicFee: null };
    default:
      throw new Error(`Unknown Meteora fee model: ${model}`);
  }
}

export async function buildLockedPoolTransaction({
  connection,
  creator,
  mint,
  supplyRaw,
  startingMarketCapLamports,
  rangeMultiple,
  feeBps,
  // Normalized fee schedule (packages/core/damm-v2-plan): fixed by default,
  // or ramp / marketcap / dynamic with their params. Defaults to a flat fee
  // at `feeBps`, so existing callers behave exactly as before.
  feePlan = { model: 'fixed', bps: feeBps },
  priorityMicroLamports = 0,
  positionNft = Keypair.generate(),
  // The pool's other side: SOL unless a launch pairs this pool with another token.
  quoteMint = NATIVE_MINT,
}) {
  const cpAmm = new CpAmm(connection);
  const tokenProgram = await mintOwnerProgram(connection, mint);
  const quoteProgram = quoteMint.equals(NATIVE_MINT) ? TOKEN_PROGRAM_ID : await mintOwnerProgram(connection, quoteMint);
  const tokenAAmount = bn(supplyRaw);
  const range = dammV2PriceRange({ supplyRaw, startingMarketCapLamports, rangeMultiple });
  const liquidityDelta = cpAmm.preparePoolCreationSingleSide({
    tokenAAmount,
    minSqrtPrice: range.sqrtMinPrice,
    maxSqrtPrice: range.sqrtMaxPrice,
    initSqrtPrice: range.initSqrtPrice,
    collectFeeMode: CollectFeeMode.OnlyB,
  });
  const created = await cpAmm.createCustomPool({
    payer: creator,
    creator,
    positionNft: positionNft.publicKey,
    tokenAMint: mint,
    tokenBMint: quoteMint,
    tokenAAmount,
    tokenBAmount: new BN(0),
    sqrtMinPrice: range.sqrtMinPrice,
    sqrtMaxPrice: range.sqrtMaxPrice,
    liquidityDelta,
    initSqrtPrice: range.initSqrtPrice,
    poolFees: {
      ...buildPoolFees(feePlan),
      compoundingFeeBps: 0,
      padding: 0,
    },
    hasAlphaVault: false,
    activationType: ActivationType.Timestamp,
    collectFeeMode: CollectFeeMode.OnlyB,
    activationPoint: null,
    tokenAProgram: tokenProgram,
    tokenBProgram: quoteProgram,
    isLockLiquidity: true,
  });
  const transaction = created.tx;
  transaction.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: POOL_COMPUTE_UNITS }),
    ...(priorityMicroLamports > 0 ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports })] : []),
  );
  transaction.feePayer = creator;
  return {
    transaction,
    pool: created.pool,
    position: created.position,
    positionNft,
    positionNftAccount: derivePositionNftAccount(positionNft.publicKey),
    tokenProgram,
    range,
    liquidityDelta,
  };
}

/** Simulate before spending. Throws with the program logs on failure. */
export async function simulateOrThrow(connection, transaction, signers) {
  const probe = new Transaction().add(...transaction.instructions);
  probe.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  probe.feePayer = transaction.feePayer;
  probe.sign(...signers);
  const result = await connection.simulateTransaction(probe);
  if (result.value.err) {
    const logs = (result.value.logs || []).slice(-8).join('\n');
    throw new Error(`The pool transaction would fail: ${JSON.stringify(result.value.err)}\n${logs}`);
  }
  return { unitsConsumed: result.value.unitsConsumed || 0 };
}

async function sendAndConfirm(connection, transaction, signers, commitment) {
  const latest = await connection.getLatestBlockhash(commitment);
  transaction.recentBlockhash = latest.blockhash;
  transaction.lastValidBlockHeight = latest.lastValidBlockHeight;
  transaction.sign(...signers);
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, preflightCommitment: commitment });
  const outcome = await connection.confirmTransaction({ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, commitment);
  if (outcome.value.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(outcome.value.err)}`);
  return signature;
}

/**
 * Create the pool, with the whole supply locked in one position. Simulates
 * first, sends, then reads the pool back and checks it.
 */
export async function createLockedPool({
  connection,
  payer,
  mint,
  supplyRaw,
  startingMarketCapLamports,
  rangeMultiple,
  feeBps,
  feePlan = { model: 'fixed', bps: feeBps },
  priorityMicroLamports = 0,
  commitment = 'confirmed',
  positionNft = Keypair.generate(),
  onProgress = () => {},
  quoteMint = NATIVE_MINT,
}) {
  const ata = getAssociatedTokenAddressSync(mint, payer.publicKey, false, await mintOwnerProgram(connection, mint));
  let held;
  try {
    held = (await getAccount(connection, ata, commitment, await mintOwnerProgram(connection, mint))).amount;
  } catch {
    throw new Error('The launch wallet holds none of this token yet.');
  }
  if (held < BigInt(supplyRaw)) throw new Error('The launch wallet holds less of this token than the pool needs.');

  const built = await buildLockedPoolTransaction({
    connection, creator: payer.publicKey, mint, supplyRaw, startingMarketCapLamports, rangeMultiple, feeBps, feePlan, priorityMicroLamports, positionNft, quoteMint,
  });
  const signers = [payer, built.positionNft];
  const simulated = await simulateOrThrow(connection, built.transaction, signers);
  onProgress({ stage: 'damm_pool_simulated', pool: built.pool.toBase58(), unitsConsumed: simulated.unitsConsumed });

  const signature = await sendAndConfirm(connection, built.transaction, signers, commitment);
  onProgress({ stage: 'damm_pool_created', pool: built.pool.toBase58(), position: built.position.toBase58(), positionNft: built.positionNft.publicKey.toBase58(), txId: signature });

  const verification = await verifyLockedPool({
    connection,
    pool: built.pool,
    position: built.position,
    mint,
    supplyRaw,
    startingMarketCapLamports,
    rangeMultiple,
    positionNft: built.positionNft.publicKey,
    commitment,
    quoteMint,
  });
  onProgress({ stage: 'damm_pool_verified', ...verification });
  return {
    signature,
    pool: built.pool.toBase58(),
    position: built.position.toBase58(),
    positionNft: built.positionNft.publicKey.toBase58(),
    verification,
  };
}

/**
 * Where this token's pool and position would be, and whether they already exist.
 * A run that died after sending the pool transaction uses this to resume without
 * creating a second pool: the pool address depends only on the two mints, and the
 * position address only on the position NFT, whose key was saved before sending.
 */
export async function findExistingPool({ connection, mint, positionNft, quoteMint = NATIVE_MINT }) {
  const pool = deriveCustomizablePoolAddress(mint, quoteMint);
  const position = derivePositionAddress(positionNft);
  const [poolInfo, positionInfo] = await Promise.all([
    connection.getAccountInfo(pool, 'confirmed'),
    connection.getAccountInfo(position, 'confirmed'),
  ]);
  return { pool, position, poolExists: Boolean(poolInfo), positionExists: Boolean(positionInfo) };
}

/** Read the pool and position back and check what a launch promises. */
export async function verifyLockedPool({
  connection,
  pool,
  position,
  mint,
  supplyRaw,
  startingMarketCapLamports,
  rangeMultiple,
  positionNft,
  commitment = 'confirmed',
  quoteMint = NATIVE_MINT,
}) {
  if (rangeMultiple == null || !positionNft) {
    throw new Error('Read the saved pool range multiple and position NFT before verifying this pool.');
  }
  const positionNftKey = positionNft instanceof PublicKey ? positionNft : new PublicKey(positionNft);
  const cpAmm = new CpAmm(connection);
  const poolState = await cpAmm.fetchPoolState(pool);
  const positionState = await cpAmm.fetchPositionState(position);
  const programId = await mintOwnerProgram(connection, mint);
  const vaultA = await getAccount(connection, poolState.tokenAVault, commitment, programId);
  const recoveredFromPool = startingMarketCapLamports == null;
  const effectiveMarketCap = recoveredFromPool
    ? dammV2MarketCapFromSqrtMin({ supplyRaw, sqrtMinPrice: poolState.sqrtMinPrice, rangeMultiple })
    : BigInt(startingMarketCapLamports);
  const range = dammV2PriceRange({ supplyRaw, startingMarketCapLamports: effectiveMarketCap, rangeMultiple });
  const expectedLiquidity = cpAmm.preparePoolCreationSingleSide({
    tokenAAmount: bn(supplyRaw),
    minSqrtPrice: range.sqrtMinPrice,
    maxSqrtPrice: range.sqrtMaxPrice,
    initSqrtPrice: range.initSqrtPrice,
    collectFeeMode: CollectFeeMode.OnlyB,
  });
  const positionNftMatchesPlan = positionState.nftMint.equals(positionNftKey)
    && derivePositionAddress(positionNftKey).equals(position);
  const poolRangeMatchesPlan = poolState.sqrtMinPrice.eq(range.sqrtMinPrice)
    && poolState.sqrtMaxPrice.eq(range.sqrtMaxPrice);
  const lockedSupply = positionState.permanentLockedLiquidity.gte(expectedLiquidity);
  const checks = {
    pool: pool.toBase58(),
    position: position.toBase58(),
    recoveredStartingMarketCapLamports: recoveredFromPool ? effectiveMarketCap.toString() : null,
    tokenA: poolState.tokenAMint.toBase58(),
    tokenB: poolState.tokenBMint.toBase58(),
    isNewTokenSideA: poolState.tokenAMint.equals(mint),
    isQuoteSol: poolState.tokenBMint.equals(NATIVE_MINT),
    isExpectedQuote: poolState.tokenBMint.equals(quoteMint),
    positionInPool: positionState.pool.equals(pool),
    positionNftMatchesPlan,
    poolRangeMatchesPlan,
    permanentlyLocked: cpAmm.isPermanentLockedPosition(positionState),
    nothingWithdrawable: positionState.unlockedLiquidity.isZero(),
    lockedSupply,
    vaultHoldsSupply: vaultA.amount >= BigInt(supplyRaw),
    quoteSideEmpty: true,
    feesInQuote: poolState.collectFeeMode === CollectFeeMode.OnlyB,
  };
  checks.passed = checks.positionInPool && checks.positionNftMatchesPlan && checks.poolRangeMatchesPlan
    && checks.isNewTokenSideA && checks.isExpectedQuote && checks.permanentlyLocked
    && checks.nothingWithdrawable && checks.lockedSupply && checks.feesInQuote;
  return checks;
}

/**
 * Move the position NFT (the "Fee Key") to another wallet. The liquidity stays
 * locked; the new owner can claim fees. The sender pays for the recipient's
 * token account.
 */
export async function transferPositionNft({ connection, owner, positionNft, to, commitment = 'confirmed' }) {
  return claimerDamm.transferPositionNft({ connection, owner, positionNft, to, commitment });
}

/** Claim accrued fees from a locked position. Fees are SOL (quote side only). */
export async function claimFees({ connection, owner, position, commitment = 'confirmed', receiver = null }) {
  return claimerDamm.claimFees({ connection, owner, position, commitment, receiver });
}

/** Positions owned by a wallet in this program, with unclaimed fees. */
export async function listPositions({ connection, owner }) {
  return claimerDamm.listPositions({ connection, owner });
}

// The pool's base fee: its first field is the cliff fee numerator, a u64 over 1e9.
function baseFeeRate(poolFees) {
  const data = poolFees?.baseFee?.baseFeeInfo?.data;
  if (!Array.isArray(data) && !(data instanceof Uint8Array)) return null;
  const bytes = Buffer.from(Array.from(data).slice(0, 8));
  if (bytes.length < 8) return null;
  const numerator = Number(bytes.readBigUInt64LE(0));
  return Number.isFinite(numerator) ? numerator / 1e9 : null;
}

/**
 * A Meteora DAMM v2 pool as a market row, read from the chain: which side the token is on, both
 * reserves (the vault balances), the price in quote per token, and the base fee. Null when the
 * account is not a pool holding this token.
 */
export async function readPoolMarket({ connection, pool, mint }) {
  const poolKey = new PublicKey(pool);
  const mintKey = new PublicKey(mint);
  const state = await new CpAmm(connection).fetchPoolState(poolKey);
  const tokenIsA = state.tokenAMint.equals(mintKey);
  if (!tokenIsA && !state.tokenBMint.equals(mintKey)) return null;
  const vaults = await connection.getMultipleParsedAccounts([state.tokenAVault, state.tokenBVault], { commitment: 'confirmed' });
  const amount = (account) => account?.data?.parsed?.info?.tokenAmount || null;
  const [a, b] = vaults.value.map(amount);
  if (!a || !b) return null;
  const bPerA = Number(getPriceFromSqrtPrice(state.sqrtPrice, a.decimals, b.decimals).toString());
  const quoteMint = (tokenIsA ? state.tokenBMint : state.tokenAMint).toBase58();
  return {
    poolId: poolKey.toBase58(),
    venue: 'meteora-damm-v2',
    quoteMint,
    tokenReserve: Number((tokenIsA ? a : b).uiAmountString),
    quoteReserve: Number((tokenIsA ? b : a).uiAmountString),
    quotePerToken: bPerA > 0 ? (tokenIsA ? bPerA : 1 / bPerA) : null,
    feeRate: baseFeeRate(state.poolFees),
  };
}
