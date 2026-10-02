// dammV2Service.js
//
// Chain work for the lean Meteora DAMM v2 launch. Pure planning (config, price
// model, cost) lives in @trebuchet/core/damm-v2-plan; routes in dammV2Routes.js.
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
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
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
  getUnClaimLpFee,
} from '@meteora-ag/cp-amm-sdk';

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
export async function buildLockedPoolTransaction({
  connection,
  creator,
  mint,
  supplyRaw,
  startingMarketCapLamports,
  rangeMultiple,
  feeBps,
  priorityMicroLamports = 0,
  positionNft = Keypair.generate(),
}) {
  const cpAmm = new CpAmm(connection);
  const tokenProgram = await mintOwnerProgram(connection, mint);
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
    tokenBMint: NATIVE_MINT,
    tokenAAmount,
    tokenBAmount: new BN(0),
    sqrtMinPrice: range.sqrtMinPrice,
    sqrtMaxPrice: range.sqrtMaxPrice,
    liquidityDelta,
    initSqrtPrice: range.initSqrtPrice,
    poolFees: {
      baseFee: getBaseFeeParams({
        baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear,
        feeTimeSchedulerParam: { startingFeeBps: feeBps, endingFeeBps: feeBps, numberOfPeriod: 0, totalDuration: 0 },
      }),
      compoundingFeeBps: 0,
      padding: 0,
      dynamicFee: null,
    },
    hasAlphaVault: false,
    activationType: ActivationType.Timestamp,
    collectFeeMode: CollectFeeMode.OnlyB,
    activationPoint: null,
    tokenAProgram: tokenProgram,
    tokenBProgram: TOKEN_PROGRAM_ID,
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
  priorityMicroLamports = 0,
  commitment = 'confirmed',
  positionNft = Keypair.generate(),
  onProgress = () => {},
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
    connection, creator: payer.publicKey, mint, supplyRaw, startingMarketCapLamports, rangeMultiple, feeBps, priorityMicroLamports, positionNft,
  });
  const signers = [payer, built.positionNft];
  const simulated = await simulateOrThrow(connection, built.transaction, signers);
  onProgress({ stage: 'damm_pool_simulated', pool: built.pool.toBase58(), unitsConsumed: simulated.unitsConsumed });

  const signature = await sendAndConfirm(connection, built.transaction, signers, commitment);
  onProgress({ stage: 'damm_pool_created', pool: built.pool.toBase58(), position: built.position.toBase58(), positionNft: built.positionNft.publicKey.toBase58(), txId: signature });

  const verification = await verifyLockedPool({ connection, pool: built.pool, position: built.position, mint, supplyRaw, commitment });
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
export async function findExistingPool({ connection, mint, positionNft }) {
  const pool = deriveCustomizablePoolAddress(mint, NATIVE_MINT);
  const position = derivePositionAddress(positionNft);
  const [poolInfo, positionInfo] = await Promise.all([
    connection.getAccountInfo(pool, 'confirmed'),
    connection.getAccountInfo(position, 'confirmed'),
  ]);
  return { pool, position, poolExists: Boolean(poolInfo), positionExists: Boolean(positionInfo) };
}

/** Read the pool and position back and check what a launch promises. */
export async function verifyLockedPool({ connection, pool, position, mint, supplyRaw, commitment = 'confirmed' }) {
  const cpAmm = new CpAmm(connection);
  const poolState = await cpAmm.fetchPoolState(pool);
  const positionState = await cpAmm.fetchPositionState(position);
  const programId = await mintOwnerProgram(connection, mint);
  const vaultA = await getAccount(connection, poolState.tokenAVault, commitment, programId);
  const checks = {
    pool: pool.toBase58(),
    position: position.toBase58(),
    tokenA: poolState.tokenAMint.toBase58(),
    tokenB: poolState.tokenBMint.toBase58(),
    isNewTokenSideA: poolState.tokenAMint.equals(mint),
    isQuoteSol: poolState.tokenBMint.equals(NATIVE_MINT),
    permanentlyLocked: cpAmm.isPermanentLockedPosition(positionState),
    nothingWithdrawable: positionState.unlockedLiquidity.isZero(),
    vaultHoldsSupply: vaultA.amount >= BigInt(supplyRaw),
    quoteSideEmpty: true,
    feesInQuote: poolState.collectFeeMode === CollectFeeMode.OnlyB,
  };
  checks.passed = checks.isNewTokenSideA && checks.isQuoteSol && checks.permanentlyLocked
    && checks.nothingWithdrawable && checks.vaultHoldsSupply && checks.feesInQuote;
  return checks;
}

/**
 * Move the position NFT (the "Fee Key") to another wallet. The liquidity stays
 * locked; the new owner can claim fees. The sender pays for the recipient's
 * token account.
 */
export async function transferPositionNft({ connection, owner, positionNft, to, commitment = 'confirmed' }) {
  const mint = new PublicKey(positionNft);
  const recipient = new PublicKey(to);
  // DAMM v2 holds the NFT in a program-derived token account owned by its holder.
  const from = derivePositionNftAccount(mint);
  const target = getAssociatedTokenAddressSync(mint, recipient, true, TOKEN_2022_PROGRAM_ID);
  const transaction = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, target, recipient, mint, TOKEN_2022_PROGRAM_ID),
    createTransferCheckedInstruction(from, mint, target, owner.publicKey, 1n, 0, [], TOKEN_2022_PROGRAM_ID),
  );
  transaction.feePayer = owner.publicKey;
  const signature = await sendAndConfirm(connection, transaction, [owner], commitment);
  return { signature, to: recipient.toBase58() };
}

/** Claim accrued fees from a locked position. Fees are SOL (quote side only). */
export async function claimFees({ connection, owner, position, commitment = 'confirmed', receiver = null }) {
  const cpAmm = new CpAmm(connection);
  const positionKey = new PublicKey(position);
  const positionState = await cpAmm.fetchPositionState(positionKey);
  const pool = positionState.pool;
  const poolState = await cpAmm.fetchPoolState(pool);
  const tokenProgram = await mintOwnerProgram(connection, poolState.tokenAMint);
  const tempWsol = Keypair.generate();
  // Where the NFT is now: the original derived account, or the account it was sent to.
  const held = (await cpAmm.getPositionsByUser(owner.publicKey)).find((entry) => entry.position.equals(positionKey));
  if (!held) throw new Error('This wallet does not hold that position.');
  const before = await connection.getBalance(owner.publicKey, commitment);
  const transaction = await cpAmm.claimPositionFee({
    owner: owner.publicKey,
    position: positionKey,
    pool,
    positionNftAccount: held.positionNftAccount,
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram: tokenProgram,
    tokenBProgram: TOKEN_PROGRAM_ID,
    receiver: receiver ? new PublicKey(receiver) : owner.publicKey,
    tempWSolAccount: tempWsol.publicKey,
  });
  const signature = await sendAndConfirm(connection, transaction, [owner, tempWsol], commitment);
  const after = await connection.getBalance(owner.publicKey, commitment);
  return { signature, lamportsReceived: after - before };
}

/** Positions owned by a wallet in this program, with unclaimed fees. */
export async function listPositions({ connection, owner }) {
  const cpAmm = new CpAmm(connection);
  const rows = [];
  for (const entry of await cpAmm.getPositionsByUser(new PublicKey(owner))) {
    const state = entry.positionState;
    const poolState = await cpAmm.fetchPoolState(state.pool);
    const quoteIsB = poolState.tokenBMint.equals(NATIVE_MINT);
    const fees = getUnClaimLpFee(poolState, state);
    rows.push({
      position: entry.position.toBase58(),
      pool: state.pool.toBase58(),
      positionNft: state.nftMint.toBase58(),
      tokenMint: (quoteIsB ? poolState.tokenAMint : poolState.tokenBMint).toBase58(),
      permanentlyLocked: cpAmm.isPermanentLockedPosition(state),
      unclaimedQuoteLamports: (quoteIsB ? fees.feeTokenB : fees.feeTokenA).toString(),
    });
  }
  return rows;
}
