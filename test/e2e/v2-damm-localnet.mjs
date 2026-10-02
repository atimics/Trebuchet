#!/usr/bin/env node
// Meteora DAMM v2 lean launch, end to end against the real program.
//
// Starts a local validator with the DAMM v2 program cloned from mainnet, then
// drives dammV2Service.js the way the launch route does: create the single-sided,
// permanently locked pool; read it back; trade through it; claim SOL fees;
// move the Fee Key to another wallet; and check every way it must refuse.
//
//   npm run test:e2e:damm:localnet
//
// Needs `solana-test-validator` on PATH and read access to mainnet-beta (to
// clone the program). Skips, with a reason, when either is missing.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BN from 'bn.js';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  ExtensionType, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMetadataPointerInstruction, createInitializeMint2Instruction, createMintToInstruction,
  createSetAuthorityInstruction, AuthorityType, getAccount, getAssociatedTokenAddressSync, getMintLen,
} from '@solana/spl-token';
import { createInitializeInstruction, pack } from '@solana/spl-token-metadata';
import { CpAmm } from '@meteora-ag/cp-amm-sdk';
import {
  DAMM_V2_PROGRAM_ID, createLockedPool, claimFees, dammV2PriceRange, listPositions, transferPositionNft, verifyLockedPool,
} from '../../dammV2Service.js';

if (spawnSync('solana-test-validator', ['--version']).error) {
  console.log('Skipped: solana-test-validator is not on PATH.');
  process.exit(0);
}

const PORT = 18899 + Math.floor(Math.random() * 500);
const url = `http://127.0.0.1:${PORT}`;
const ledger = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-damm-e2e-'));
const validator = spawn('solana-test-validator', [
  '--reset', '--quiet', '--ledger', ledger, '--rpc-port', String(PORT), '--faucet-port', String(PORT + 20),
  '--gossip-port', String(PORT + 21), '--url', 'https://api.mainnet-beta.solana.com',
  '--clone-upgradeable-program', DAMM_V2_PROGRAM_ID.toBase58(),
], { stdio: ['ignore', 'ignore', 'pipe'] });
let validatorError = '';
validator.stderr.on('data', (chunk) => { validatorError += chunk; });
const stop = () => { validator.kill('SIGTERM'); fs.rmSync(ledger, { recursive: true, force: true }); };
process.on('exit', stop);

const connection = new Connection(url, 'confirmed');
for (let i = 0; ; i += 1) {
  try { await connection.getVersion(); break; } catch {
    if (i > 120) { console.log(`Skipped: the validator did not start (${validatorError.slice(0, 200)}).`); process.exit(0); }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
if (!(await connection.getAccountInfo(DAMM_V2_PROGRAM_ID))) {
  console.log('Skipped: could not clone the DAMM v2 program from mainnet.');
  process.exit(0);
}

const fund = async (keypair, sol) => {
  await connection.confirmTransaction(await connection.requestAirdrop(keypair.publicKey, sol * LAMPORTS_PER_SOL), 'confirmed');
  return keypair;
};
const lamports = (key) => connection.getBalance(key, 'confirmed');

// A Token-2022 mint shaped like the app's: 9 decimals, self-pointing metadata,
// supply minted, mint authority renounced.
const DECIMALS = 9;
const SUPPLY_WHOLE = 1_000_000_000n;
const SUPPLY = SUPPLY_WHOLE * 10n ** BigInt(DECIMALS);
async function makeToken(owner, supply = SUPPLY) {
  const mint = Keypair.generate();
  const metadata = { mint: mint.publicKey, name: 'Trebuchet', symbol: 'TREB', uri: 'https://example.invalid/t.json', additionalMetadata: [], updateAuthority: owner.publicKey };
  const space = getMintLen([ExtensionType.MetadataPointer]);
  const rent = await connection.getMinimumBalanceForRentExemption(space + 4 + pack(metadata).length);
  const ata = getAssociatedTokenAddressSync(mint.publicKey, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: owner.publicKey, newAccountPubkey: mint.publicKey, space, lamports: rent, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeMetadataPointerInstruction(mint.publicKey, null, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializeMint2Instruction(mint.publicKey, DECIMALS, owner.publicKey, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({ programId: TOKEN_2022_PROGRAM_ID, mint: mint.publicKey, metadata: mint.publicKey, name: metadata.name, symbol: metadata.symbol, uri: metadata.uri, mintAuthority: owner.publicKey, updateAuthority: owner.publicKey }),
    createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ata, owner.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(mint.publicKey, ata, owner.publicKey, supply, [], TOKEN_2022_PROGRAM_ID),
    createSetAuthorityInstruction(mint.publicKey, owner.publicKey, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID),
  ), [owner, mint]);
  return mint.publicKey;
}

const launcher = await fund(Keypair.generate(), 20);
const MCAP_SOL = 2100;
const FEE_BPS = 25;
const params = { startingMarketCapLamports: BigInt(MCAP_SOL) * 1_000_000_000n, rangeMultiple: 1000, feeBps: FEE_BPS };

// ---- 1. create ---------------------------------------------------------------------------------
const mint = await makeToken(launcher);
const events = [];
const before = await lamports(launcher.publicKey);
const launched = await createLockedPool({ connection, payer: launcher, mint, supplyRaw: SUPPLY, ...params, onProgress: (event) => events.push(event.stage) });
const spent = before - (await lamports(launcher.publicKey));
console.log(`created pool ${launched.pool} for ${spent} lamports (${(spent / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);
assert.deepEqual(events, ['damm_pool_simulated', 'damm_pool_created', 'damm_pool_verified']);
assert.equal(launched.verification.passed, true, JSON.stringify(launched.verification));
assert.equal(launched.verification.permanentlyLocked, true);
assert.equal(launched.verification.isNewTokenSideA, true);
assert.equal(launched.verification.isQuoteSol, true);
assert.equal(launched.verification.feesInQuote, true);
// The measured cost the plan module quotes is rent only; the fee is read from the confirmed transaction.
const poolTxFee = (await connection.getTransaction(launched.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })).meta.fee;
assert.equal(spent - poolTxFee, 24_645_361, `pool, position, NFT and vault rent matches the measured constant (fee ${poolTxFee})`);
assert.equal(poolTxFee, 10_000, 'two signatures: the launch wallet and the position NFT mint');

const cpAmm = new CpAmm(connection);
const poolState = await cpAmm.fetchPoolState(new (await import('@solana/web3.js')).PublicKey(launched.pool));
const range = dammV2PriceRange({ supplyRaw: SUPPLY, ...{ startingMarketCapLamports: params.startingMarketCapLamports, rangeMultiple: params.rangeMultiple } });
assert.equal(poolState.sqrtPrice.toString(), range.initSqrtPrice.toString(), 'the pool starts at the planned price');
assert.equal(poolState.sqrtMinPrice.toString(), range.sqrtMinPrice.toString());
assert.equal(poolState.sqrtMaxPrice.toString(), range.sqrtMaxPrice.toString());
console.log('ok  pool starts at the planned price and range, position permanently locked');

// ---- 2. it trades; fees come back as SOL -------------------------------------------------------
const trader = await fund(Keypair.generate(), 60);
const poolKey = poolState.tokenAMint && new (await import('@solana/web3.js')).PublicKey(launched.pool);
const swapIn = new BN(20 * LAMPORTS_PER_SOL);
const state = await cpAmm.fetchPoolState(poolKey);
const quote = cpAmm.getQuote({ inAmount: swapIn, inputTokenMint: NATIVE_MINT, slippage: 1, poolState: state, currentTime: Math.floor(Date.now() / 1000), currentSlot: await connection.getSlot() });
const swapTx = await cpAmm.swap({
  payer: trader.publicKey, pool: poolKey, inputTokenMint: NATIVE_MINT, outputTokenMint: mint, amountIn: swapIn, minimumAmountOut: quote.minSwapOutAmount,
  tokenAMint: state.tokenAMint, tokenBMint: state.tokenBMint, tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault,
  tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
});
await sendAndConfirmTransaction(connection, swapTx, [trader]);
const bought = (await getAccount(connection, getAssociatedTokenAddressSync(mint, trader.publicKey, false, TOKEN_2022_PROGRAM_ID), 'confirmed', TOKEN_2022_PROGRAM_ID)).amount;
const boughtWhole = Number(bought) / 10 ** DECIMALS;
const averagePrice = 20 / boughtWhole;
const startPrice = MCAP_SOL / Number(SUPPLY_WHOLE);
console.log(`bought ${boughtWhole.toLocaleString()} tokens for 20 SOL at ${(averagePrice / startPrice).toFixed(4)}x the starting price`);
assert.ok(averagePrice > startPrice && averagePrice < startPrice * 1.05, 'a 20 SOL buy moves a $250k-market-cap pool by well under 5%');

const claimed = await claimFees({ connection, owner: launcher, position: launched.position });
const expectedFee = 20 * LAMPORTS_PER_SOL * (FEE_BPS / 10_000) * 0.8; // 80% to the LP, 20% protocol share
assert.ok(Math.abs(claimed.lamportsReceived - expectedFee) / expectedFee < 0.01, `claimed ${claimed.lamportsReceived}, expected about ${expectedFee}`);
console.log(`ok  claimed ${(claimed.lamportsReceived / LAMPORTS_PER_SOL).toFixed(6)} SOL of fees (expected ${(expectedFee / LAMPORTS_PER_SOL).toFixed(6)})`);

// ---- 3. the Fee Key moves; the liquidity stays locked -------------------------------------------
const keyHolder = await fund(Keypair.generate(), 1);
const rentBefore = await lamports(launcher.publicKey);
await transferPositionNft({ connection, owner: launcher, positionNft: launched.positionNft, to: keyHolder.publicKey });
const transferCost = rentBefore - (await lamports(launcher.publicKey));
const transferFee = 5_000; // one signature
assert.equal(transferCost - transferFee, 2_074_080, 'the recipient\'s token account rent matches the measured constant');
console.log(`moved the Fee Key to ${keyHolder.publicKey.toBase58().slice(0, 8)}... for ${transferCost} lamports (recipient token account)`);
const held = await listPositions({ connection, owner: keyHolder.publicKey });
assert.equal(held.length, 1);
assert.equal(held[0].permanentlyLocked, true);
assert.equal(held[0].tokenMint, mint.toBase58());
assert.equal((await listPositions({ connection, owner: launcher.publicKey })).length, 0, 'the launcher no longer holds the position');

// the old owner cannot claim; the new owner can, after more trading
await assert.rejects(() => claimFees({ connection, owner: launcher, position: launched.position }), 'the previous owner cannot claim');
await sendAndConfirmTransaction(connection, await cpAmm.swap({
  payer: trader.publicKey, pool: poolKey, inputTokenMint: NATIVE_MINT, outputTokenMint: mint, amountIn: new BN(5 * LAMPORTS_PER_SOL), minimumAmountOut: new BN(0),
  tokenAMint: state.tokenAMint, tokenBMint: state.tokenBMint, tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault,
  tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
}), [trader]);
const newOwnerClaim = await claimFees({ connection, owner: keyHolder, position: launched.position });
// Fees on a 5 SOL buy (80% to the LP), less two things the first claim from a fresh wallet costs:
// the claim's own fee, and a Token-2022 account for the pool's other token (refundable rent).
const TOKEN_ACCOUNT_RENT = 2_074_080;
const nextFee = 5 * LAMPORTS_PER_SOL * (FEE_BPS / 10_000) * 0.8;
const claimFee = (await connection.getTransaction(newOwnerClaim.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })).meta.fee;
const netExpected = nextFee - TOKEN_ACCOUNT_RENT - claimFee;
assert.ok(Math.abs(newOwnerClaim.lamportsReceived - netExpected) / nextFee < 0.01, `claimed ${newOwnerClaim.lamportsReceived}, expected about ${netExpected}`);
console.log(`ok  the new holder claimed ${(newOwnerClaim.lamportsReceived / LAMPORTS_PER_SOL).toFixed(6)} SOL net (first claim opens a token account: ${TOKEN_ACCOUNT_RENT} lamports, refundable)`);

// ---- 4. nothing can take the liquidity back ----------------------------------------------------
const positionState = await cpAmm.fetchPositionState(new (await import('@solana/web3.js')).PublicKey(launched.position));
await assert.rejects(async () => {
  const tx = await cpAmm.removeAllLiquidity({
    owner: keyHolder.publicKey, position: positionState.pool && new (await import('@solana/web3.js')).PublicKey(launched.position), pool: poolKey,
    positionNftAccount: (await cpAmm.getPositionsByUser(keyHolder.publicKey))[0].positionNftAccount, tokenAAmountThreshold: new BN(0), tokenBAmountThreshold: new BN(0),
    tokenAMint: state.tokenAMint, tokenBMint: state.tokenBMint, tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault,
    tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, vestings: [], currentPoint: new BN(Math.floor(Date.now() / 1000)),
  });
  await sendAndConfirmTransaction(connection, tx, [keyHolder]);
}, 'removing liquidity from the permanently locked position is refused');
console.log('ok  removing liquidity is refused for the Fee Key holder too');

// ---- 5. refusals before any money moves --------------------------------------------------------
const poor = await fund(Keypair.generate(), 5);
const emptyMint = await makeToken(Keypair.generate().publicKey && launcher, 1_000n * 10n ** BigInt(DECIMALS));
await assert.rejects(
  () => createLockedPool({ connection, payer: poor, mint: emptyMint, supplyRaw: SUPPLY, ...params }),
  /holds none of this token/,
  'a wallet without the token is refused before simulation',
);
await assert.rejects(
  () => createLockedPool({ connection, payer: launcher, mint: emptyMint, supplyRaw: SUPPLY, ...params }),
  /holds less of this token/,
  'a wallet with less than the pool needs is refused',
);
assert.throws(() => dammV2PriceRange({ supplyRaw: 1n, startingMarketCapLamports: 10n ** 30n, rangeMultiple: 1000 }), /outside what the pool can represent/, 'a price beyond what the pool can store');
assert.throws(() => dammV2PriceRange({ supplyRaw: SUPPLY, startingMarketCapLamports: 10n ** 12n, rangeMultiple: 1 }), /at least 2/);
console.log('ok  refusals happen before anything is sent');

// The verification helper rejects a pool that is not what a launch promises.
const wrongMint = await makeToken(launcher);
const bad = await verifyLockedPool({ connection, pool: poolKey, position: new (await import('@solana/web3.js')).PublicKey(launched.position), mint: wrongMint, supplyRaw: SUPPLY });
assert.equal(bad.passed, false, 'a pool for another token does not verify');
console.log('ok  verification fails for a pool that is not this token\'s');

console.log('\nDAMM v2 lean launch: all checks passed');
stop();
process.exit(0);
