#!/usr/bin/env node
// Measures what a Meteora DAMM v2 launch really costs, and proves the flow works.
//
// Starts a local validator with the real DAMM v2 program cloned from mainnet,
// then runs the lean launch the app would run:
//   create Token-2022 mint + metadata -> mint supply -> create customizable pool
//   with the first deposit -> permanently lock the position
// and afterwards swaps and claims fees through the locked position.
//
// Nothing here touches mainnet funds: the validator is local, and the clone is a
// read of the program. Usage: node scripts/damm-v2-localnet-probe.mjs [--keep]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BN from 'bn.js';
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  ExtensionType, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMetadataPointerInstruction, createInitializeMintInstruction, createMintToInstruction,
  createSyncNativeInstruction, getAssociatedTokenAddressSync, getMintLen, getAccount,
} from '@solana/spl-token';
import { createInitializeInstruction, pack } from '@solana/spl-token-metadata';
import {
  ActivationType, BaseFeeMode, CP_AMM_PROGRAM_ID, CollectFeeMode, CpAmm, MAX_SQRT_PRICE, MIN_SQRT_PRICE,
  derivePositionNftAccount, getBaseFeeParams, getSqrtPriceFromPrice,
} from '@meteora-ag/cp-amm-sdk';

const RPC_PORT = 8899;
const URL = `http://127.0.0.1:${RPC_PORT}`;
const flag = (name, fallback) => { const hit = process.argv.find((a) => a.startsWith(`--${name}=`)); return hit ? hit.split('=')[1] : fallback; };
const SOL_DEPOSIT = Number(flag('deposit', 1)); // SOL put into the pool as quote liquidity
const SUPPLY = 1_000_000_000n; // whole tokens
const DECIMALS = Number(flag('decimals', 6));
const LOCK_AT_CREATE = flag('lock-at-create', 'false') === 'true';
const SOL_FIRST = flag('sol-first', 'false') === 'true'; // force a mint whose key sorts below wSOL
const SINGLE_SIDED = flag('single-sided', 'false') === 'true'; // tokens only, no SOL, price range above the start
const MCAP_SOL = Number(flag('mcap-sol', 2100)); // starting market cap, in SOL
const RANGE_X = Number(flag('range', 1000)); // top of the range = start price x this
const FEE_MODE = { both: CollectFeeMode.BothToken, quote: CollectFeeMode.OnlyB, compounding: CollectFeeMode.Compounding }[flag('fee-mode', 'both')];
const FEE_BPS = 25; // 0.25%, the app's default fee tier

const sol = (lamports) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(6);

async function waitForValidator(connection) {
  for (let i = 0; i < 120; i += 1) {
    try { await connection.getVersion(); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('validator did not start');
}

function startValidator() {
  const ledger = fs.mkdtempSync(path.join(os.tmpdir(), 'damm-v2-ledger-'));
  const child = spawn('solana-test-validator', [
    '--reset', '--quiet', '--ledger', ledger, '--rpc-port', String(RPC_PORT),
    '--url', 'https://api.mainnet-beta.solana.com',
    '--clone-upgradeable-program', CP_AMM_PROGRAM_ID.toBase58(),
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  return { child, ledger };
}

async function send(connection, transaction, signers) {
  return sendAndConfirmTransaction(connection, transaction, signers, { commitment: 'confirmed' });
}

async function main() {
  const { child, ledger } = startValidator();
  const cleanup = () => { child.kill('SIGTERM'); if (!process.argv.includes('--keep')) fs.rmSync(ledger, { recursive: true, force: true }); };
  process.on('exit', cleanup);
  const connection = new Connection(URL, 'confirmed');
  await waitForValidator(connection);

  const payer = Keypair.generate();
  await connection.confirmTransaction(await connection.requestAirdrop(payer.publicKey, 20 * LAMPORTS_PER_SOL), 'confirmed');
  const start = await connection.getBalance(payer.publicKey);
  const mark = async (label, since) => { const now = await connection.getBalance(payer.publicKey); console.log(`  ${label.padEnd(44)} ${sol(since - now).padStart(10)} SOL`); return now; };

  // 1. Token-2022 mint with on-mint metadata (what the app launches).
  let mint = Keypair.generate();
  if (SOL_FIRST) while (Buffer.compare(mint.publicKey.toBuffer(), NATIVE_MINT.toBuffer()) >= 0) mint = Keypair.generate();
  const metadata = { mint: mint.publicKey, name: 'Trebuchet', symbol: 'TREB', uri: 'https://example.invalid/treb.json', additionalMetadata: [], updateAuthority: payer.publicKey };
  const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  const rent = await connection.getMinimumBalanceForRentExemption(mintLen + 4 + pack(metadata).length);
  const payerAta = getAssociatedTokenAddressSync(mint.publicKey, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const supplyRaw = SUPPLY * 10n ** BigInt(DECIMALS);
  await send(connection, new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: mintLen, lamports: rent, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeMetadataPointerInstruction(mint.publicKey, null, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint.publicKey, DECIMALS, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({ programId: TOKEN_2022_PROGRAM_ID, mint: mint.publicKey, metadata: mint.publicKey, name: metadata.name, symbol: metadata.symbol, uri: metadata.uri, mintAuthority: payer.publicKey, updateAuthority: payer.publicKey }),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, payerAta, payer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(mint.publicKey, payerAta, payer.publicKey, supplyRaw, [], TOKEN_2022_PROGRAM_ID),
  ), [payer, mint]);
  console.log('Cost breakdown (payer balance change, includes tx fees):');
  const last = await mark('mint + on-mint metadata + supply', start);

  // 2. Customizable pool + first deposit (the SDK wraps the SOL side itself). Token A is the larger mint key.
  const cpAmm = new CpAmm(connection);
  const tokenIsA = flag('token-side', 'by-key') === 'a' ? true : Buffer.compare(mint.publicKey.toBuffer(), NATIVE_MINT.toBuffer()) > 0;
  const tokenAMint = tokenIsA ? mint.publicKey : NATIVE_MINT;
  const tokenBMint = tokenIsA ? NATIVE_MINT : mint.publicKey;
  const tokenAAmount = tokenIsA ? new BN(supplyRaw.toString()) : new BN(Math.round(SOL_DEPOSIT * LAMPORTS_PER_SOL));
  const tokenBAmount = SINGLE_SIDED ? new BN(0) : tokenIsA ? new BN(Math.round(SOL_DEPOSIT * LAMPORTS_PER_SOL)) : new BN(supplyRaw.toString());
  let initSqrtPrice; let liquidityDelta; let sqrtMin = MIN_SQRT_PRICE; let sqrtMax = MAX_SQRT_PRICE;
  if (SINGLE_SIDED) {
    // Price is "B per A" in whole tokens: SOL per token = market cap / supply.
    const priceSolPerToken = MCAP_SOL / Number(SUPPLY);
    initSqrtPrice = getSqrtPriceFromPrice(String(priceSolPerToken), DECIMALS, 9);
    sqrtMin = initSqrtPrice; // nothing below the start, so no SOL is needed
    sqrtMax = initSqrtPrice.muln(Math.round(Math.sqrt(RANGE_X) * 1000)).divn(1000);
    liquidityDelta = cpAmm.preparePoolCreationSingleSide({ tokenAAmount, minSqrtPrice: sqrtMin, maxSqrtPrice: sqrtMax, initSqrtPrice, collectFeeMode: FEE_MODE });
    console.log(`  single-sided: start ${MCAP_SOL} SOL market cap (${priceSolPerToken.toExponential(3)} SOL/token), range x${RANGE_X}`);
  } else {
    ({ initSqrtPrice, liquidityDelta } = cpAmm.preparePoolCreationParams({
      tokenAAmount, tokenBAmount, minSqrtPrice: MIN_SQRT_PRICE, maxSqrtPrice: MAX_SQRT_PRICE, collectFeeMode: FEE_MODE,
    }));
  }
  const positionNft = Keypair.generate();
  const created = await cpAmm.createCustomPool({
    payer: payer.publicKey, creator: payer.publicKey, positionNft: positionNft.publicKey,
    tokenAMint, tokenBMint, tokenAAmount, tokenBAmount, sqrtMinPrice: sqrtMin, sqrtMaxPrice: sqrtMax,
    liquidityDelta, initSqrtPrice,
    poolFees: {
      baseFee: getBaseFeeParams({ baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear, feeTimeSchedulerParam: { startingFeeBps: FEE_BPS, endingFeeBps: FEE_BPS, numberOfPeriod: 0, totalDuration: 0 } }),
      compoundingFeeBps: 0, padding: 0, dynamicFee: null,
    },
    hasAlphaVault: false, activationType: ActivationType.Timestamp, collectFeeMode: FEE_MODE, activationPoint: null, isLockLiquidity: LOCK_AT_CREATE,
    tokenAProgram: tokenIsA ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
    tokenBProgram: tokenIsA ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
  });
  const poolTx = created.tx;
  poolTx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  await send(connection, poolTx, [payer, positionNft]);
  const afterPool = await connection.getBalance(payer.publicKey);
  console.log(`  ${'(pool creation tx, incl. the deposit)'.padEnd(44)} ${sol(last - afterPool).padStart(10)} SOL`);

  const pre = await cpAmm.fetchPositionState(created.position);
  console.log(`  token order: ${tokenIsA ? 'new token = A, wSOL = B' : 'wSOL = A, new token = B'} | collectFeeMode=${FEE_MODE} | lock-at-create=${LOCK_AT_CREATE} | permanentLocked after create: ${cpAmm.isPermanentLockedPosition(pre)}`);
  // 3. Lock the whole position permanently (fees stay claimable).
  const positionState = await cpAmm.fetchPositionState(created.position);
  const alreadyLocked = cpAmm.isPermanentLockedPosition(positionState);
  if (!alreadyLocked) {
    const lockTx = await cpAmm.permanentLockPosition({
      owner: payer.publicKey, position: created.position, positionNftAccount: derivePositionNftAccount(positionNft.publicKey),
      pool: created.pool, unlockedLiquidity: positionState.unlockedLiquidity,
    });
    await send(connection, lockTx, [payer]);
  }
  const afterLock = await connection.getBalance(payer.publicKey);

  const deposit = SINGLE_SIDED ? 0 : Math.round(SOL_DEPOSIT * LAMPORTS_PER_SOL);
  const poolCost = last - afterPool - deposit;
  const lockCost = afterPool - afterLock;
  console.log(`  ${'pool + position + vaults + tx fee'.padEnd(44)} ${sol(poolCost).padStart(10)} SOL   (the ${SOL_DEPOSIT} SOL deposit excluded)`);
  console.log(`  ${'permanent lock (tx fee only)'.padEnd(44)} ${sol(lockCost).padStart(10)} SOL`);
  console.log(`\nexact lamports -> pool+position+vaults+fee: ${poolCost}, lock: ${lockCost}, mint+metadata+supply: ${start - last}`);
  console.log(`DAMM v2 venue cost: ${sol(poolCost + lockCost)} SOL   (Raydium path in the app: pool 0.063 + Fee Keys 0.082 = 0.145 SOL)`);
  console.log(`Whole launch, excluding the deposit: ${sol(start - afterLock - deposit)} SOL`);

  // 4. Prove it trades and the locked position still earns: swap, then claim fees.
  const trader = Keypair.generate();
  await connection.confirmTransaction(await connection.requestAirdrop(trader.publicKey, (Number(flag('buy', 0.5)) + 5) * LAMPORTS_PER_SOL), 'confirmed');
  const traderTokenAta = getAssociatedTokenAddressSync(mint.publicKey, trader.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const buyIn = new BN(Math.round(Number(flag('buy', 0.5)) * LAMPORTS_PER_SOL));
  const state = await cpAmm.fetchPoolState(created.pool);
  const quote = cpAmm.getQuote({ inAmount: buyIn, inputTokenMint: NATIVE_MINT, slippage: 1, poolState: state, currentTime: Math.floor(Date.now() / 1000), currentSlot: await connection.getSlot(), inputTokenInfo: undefined, outputTokenInfo: undefined });
  const swapTx = await cpAmm.swap({
    payer: trader.publicKey, pool: created.pool, inputTokenMint: NATIVE_MINT, outputTokenMint: mint.publicKey, amountIn: buyIn, minimumAmountOut: quote.minSwapOutAmount,
    tokenAMint: state.tokenAMint, tokenBMint: state.tokenBMint, tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault,
    tokenAProgram: tokenIsA ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID, tokenBProgram: tokenIsA ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID, referralTokenAccount: null,
  });
  await send(connection, swapTx, [trader]);
  const bought = (await getAccount(connection, traderTokenAta, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount;
  console.log(`\nSwap: ${flag('buy', 0.5)} SOL bought ${(Number(bought) / 10 ** DECIMALS).toLocaleString()} TREB through the locked pool`);

  const before = await connection.getBalance(payer.publicKey);
  const tokenBefore = (await getAccount(connection, payerAta, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount;
  const tempWsol = Keypair.generate();
  const claimTx = await cpAmm.claimPositionFee({
    owner: payer.publicKey, position: created.position, pool: created.pool, positionNftAccount: derivePositionNftAccount(positionNft.publicKey),
    tokenAMint: state.tokenAMint, tokenBMint: state.tokenBMint, tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault,
    tokenAProgram: tokenIsA ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID, tokenBProgram: tokenIsA ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
    receiver: payer.publicKey, tempWSolAccount: tempWsol.publicKey,
  });
  await send(connection, claimTx, [payer, tempWsol]);
  const gained = (await connection.getBalance(payer.publicKey)) - before + 10_000; // add back the two signatures' fee
  const tokenFees = Number((await getAccount(connection, payerAta, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount - tokenBefore);
  console.log(`Claimed fees from the permanently locked position: ${(gained / LAMPORTS_PER_SOL).toFixed(6)} SOL (tx fee added back), ${tokenFees} token units`);
  const expected = Math.floor(0.5 * LAMPORTS_PER_SOL * FEE_BPS / 10_000);
  console.log(`  expected about ${(expected / LAMPORTS_PER_SOL).toFixed(6)} SOL of fee on a 0.5 SOL buy at ${FEE_BPS / 100}%`);

  // The locked position cannot be drained.
  let drained = false;
  try {
    const rm = await cpAmm.removeAllLiquidity({
      owner: payer.publicKey, position: created.position, pool: created.pool, positionNftAccount: derivePositionNftAccount(positionNft.publicKey),
      tokenAAmountThreshold: new BN(0), tokenBAmountThreshold: new BN(0), tokenAMint: state.tokenAMint, tokenBMint: state.tokenBMint,
      tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault,
      tokenAProgram: tokenIsA ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID, tokenBProgram: tokenIsA ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
      vestings: [], currentPoint: new BN(Math.floor(Date.now() / 1000)),
    });
    await send(connection, rm, [payer]);
    drained = true;
  } catch { /* expected: permanently locked */ }
  console.log(`Remove-liquidity on the locked position: ${drained ? 'SUCCEEDED (not locked!)' : 'refused (permanently locked)'}`);
  cleanup();
  process.exit(drained ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
