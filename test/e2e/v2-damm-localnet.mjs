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
  DAMM_V2_PROGRAM_ID, createLockedPool, claimFees, dammV2PriceRange, findExistingPool, listPositions, transferPositionNft, verifyLockedPool,
} from '../../dammV2Service.js';
import { normalizeDammV2Config } from '@trebuchet/core/damm-v2-plan';
const store = await import('../../dammV2Store.js');
const { runLaunch } = await import('../../dammV2Launch.js');

process.env.TREBUCHET_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-damm-config-'));
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
async function makeToken(owner, supply = SUPPLY, mint = Keypair.generate()) {
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


// ---- 6. the whole launch, through the runner the route uses -------------------------------------
const TOKEN_RESULT = (mint) => ({ tokenMint: mint.toBase58(), isSafe: true, mintAuthorityRenounced: true, freezeAuthorityDisabled: true, metadataImmutable: true, metadataUri: 'https://example.invalid/t.json', imageUri: null });
const addedCoins = [];
const makeDeps = (wallet, overrides = {}) => ({
  connection,
  solUsd: 118,
  addCoin: (coin) => addedCoins.push(coin),
  getVanityCandidate: () => null,
  removeVanityCandidate: () => {},
  createToken: async (args) => {
    assert.equal(args.mintFormat, 'token-2022');
    assert.equal(args.sealedLaunch, false);
    assert.equal(args.totalSupply, '1000000000');
    return TOKEN_RESULT(await makeToken(Keypair.fromSecretKey(Uint8Array.from(args.tempWalletSecretKey)), SUPPLY,
      Keypair.fromSecretKey(Uint8Array.from(args.vanityCAKeypair))));
  },
  ...overrides,
});
const leanConfig = (extra = {}) => normalizeDammV2Config({ token: { name: 'Trebuchet', symbol: 'treb', supply: '1000000000', description: 'lean' }, ...extra });

// A full run: token, pool, Fee Key to another wallet.
{
  const wallet = await fund(Keypair.generate(), 5);
  const destination = Keypair.generate();
  const record = store.create({ config: leanConfig({ destination: destination.publicKey.toBase58() }), walletPublicKey: wallet.publicKey.toBase58() });
  const done = await runLaunch({ id: record.id, walletSecretKey: Array.from(wallet.secretKey), deps: makeDeps(wallet) });
  assert.equal(done.status, 'completed');
  assert.equal(done.steps.token.complete, true);
  assert.equal(done.steps.pool.verification.passed, true);
  assert.equal(done.steps.pool.adopted, false);
  assert.equal(done.steps.keyTransfer.to, destination.publicKey.toBase58());
  assert.equal(done.positionNftSaved, true, 'the position NFT key was saved before the pool was sent');
  assert.ok(!JSON.stringify(done).includes('positionNftEnc'));
  const stages = store.get(record.id).events.map((event) => event.stage);
  for (const stage of ['token_starting', 'damm_pool_simulated', 'damm_pool_created', 'damm_pool_verified', 'fee_key_sending', 'fee_key_sent', 'launch_complete']) {
    assert.ok(stages.includes(stage), `event ${stage} recorded (got ${stages.join(', ')})`);
  }
  const held = await listPositions({ connection, owner: destination.publicKey });
  assert.equal(held.length, 1, 'the destination holds the Fee Key');
  assert.equal(held[0].position, done.steps.pool.position);
  assert.equal(held[0].permanentlyLocked, true);
  // Starting price follows the frozen SOL price: $250,000 / $118.
  assert.ok(Math.abs(done.steps.pool.startMarketCapSol - 250_000 / 118) < 1e-9);
  assert.equal(addedCoins.length, 1, 'the finished coin is added to the Coins list once');
  assert.equal(addedCoins[0].mint, done.steps.token.mint);
  assert.equal(addedCoins[0].symbol, 'TREB');
  await assert.rejects(() => runLaunch({ id: record.id, walletSecretKey: Array.from(wallet.secretKey), deps: makeDeps(wallet) }), /already complete/);
  assert.equal(addedCoins.length, 1, 'a refused second start does not add it again');
  console.log('ok  full run: token, locked pool, Fee Key sent; a second start is refused');
}

// A run that died after the pool was sent resumes by adopting it, not by creating another.
{
  const wallet = await fund(Keypair.generate(), 5);
  const record = store.create({ config: leanConfig(), walletPublicKey: wallet.publicKey.toBase58() });
  const mint = await makeToken(wallet);
  const nft = Keypair.generate();
  store.savePositionNft(record.id, nft.secretKey);
  store.update(record.id, { solUsd: 118, steps: { token: { complete: true, mint: mint.toBase58() } } });
  const sent = await createLockedPool({ connection, payer: wallet, mint, supplyRaw: SUPPLY, startingMarketCapLamports: BigInt(Math.round((250_000 / 118) * LAMPORTS_PER_SOL)), rangeMultiple: 1000, feeBps: 25, positionNft: nft });
  store.update(record.id, { status: 'failed', error: 'the app closed after sending' });
  const found = await findExistingPool({ connection, mint, positionNft: nft.publicKey });
  assert.equal(found.pool.toBase58(), sent.pool, 'the derived pool address is the real one');
  assert.equal(found.position.toBase58(), sent.position, 'the derived position address is the real one');
  assert.equal(found.poolExists && found.positionExists, true);
  // Trading can happen while the app is closed. Recovery checks the saved
  // locked position and range after tokens have left the vault.
  const tradedPool = await cpAmm.fetchPoolState(found.pool);
  await sendAndConfirmTransaction(connection, await cpAmm.swap({
    payer: trader.publicKey, pool: found.pool, inputTokenMint: NATIVE_MINT, outputTokenMint: mint,
    amountIn: new BN(LAMPORTS_PER_SOL), minimumAmountOut: new BN(0),
    tokenAMint: tradedPool.tokenAMint, tokenBMint: tradedPool.tokenBMint,
    tokenAVault: tradedPool.tokenAVault, tokenBVault: tradedPool.tokenBVault,
    tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
  }), [trader]);
  assert.ok((await getAccount(connection, tradedPool.tokenAVault, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount < SUPPLY);
  const before = await lamports(wallet.publicKey);
  const resumed = await runLaunch({ id: record.id, walletSecretKey: Array.from(wallet.secretKey), deps: makeDeps(wallet, { createToken: async () => { throw new Error('token must not be created again'); } }) });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.steps.pool.adopted, true);
  assert.equal(resumed.steps.pool.pool, sent.pool);
  assert.equal(before - (await lamports(wallet.publicKey)), 0, 'adopting costs nothing: no second pool, no fee');
  console.log('ok  resume after a buy adopts the existing pool and spends nothing');
}

// A pool for this token that is not this launch's position is never adopted.
{
  const wallet = await fund(Keypair.generate(), 5);
  const record = store.create({ config: leanConfig(), walletPublicKey: wallet.publicKey.toBase58() });
  const mint = await makeToken(wallet);
  await createLockedPool({ connection, payer: wallet, mint, supplyRaw: SUPPLY, startingMarketCapLamports: BigInt(Math.round((250_000 / 118) * LAMPORTS_PER_SOL)), rangeMultiple: 1000, feeBps: 25 });
  store.savePositionNft(record.id, Keypair.generate().secretKey); // a different NFT
  store.update(record.id, { solUsd: 118, steps: { token: { complete: true, mint: mint.toBase58() } } });
  await assert.rejects(
    () => runLaunch({ id: record.id, walletSecretKey: Array.from(wallet.secretKey), deps: makeDeps(wallet) }),
    /not this launch's position/,
  );
  const failed = store.get(record.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Nothing was created/);
  console.log('ok  a pool that is not this launch\'s position is refused');
}

// A failed token step leaves a failed record with no pool, and a re-run starts clean.
{
  const wallet = await fund(Keypair.generate(), 5);
  const record = store.create({ config: leanConfig(), walletPublicKey: wallet.publicKey.toBase58() });
  await assert.rejects(
    () => runLaunch({ id: record.id, walletSecretKey: Array.from(wallet.secretKey), deps: makeDeps(wallet, { createToken: async () => { throw new Error('upload failed'); } }) }),
    /upload failed/,
  );
  let failed = store.get(record.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'upload failed');
  const savedMint = failed.steps.token.mint;
  assert.equal(failed.steps.token.complete, false);
  assert.equal(store.loadTokenMint(record.id).publicKey, savedMint);
  assert.equal(failed.steps.pool, null);
  const retried = await runLaunch({ id: record.id, walletSecretKey: Array.from(wallet.secretKey), deps: makeDeps(wallet) });
  assert.equal(retried.status, 'completed');
  assert.equal(retried.steps.token.mint, savedMint);
  assert.equal(retried.error, null);
  // An unverified token never reaches the pool stage.
  const unsafe = store.create({ config: leanConfig(), walletPublicKey: wallet.publicKey.toBase58() });
  await assert.rejects(
    () => runLaunch({ id: unsafe.id, walletSecretKey: Array.from(wallet.secretKey), deps: makeDeps(wallet, { createToken: async () => ({ tokenMint: Keypair.generate().publicKey.toBase58(), isSafe: false }) }) }),
    /not verified as safe/,
  );
  assert.equal(store.get(unsafe.id).steps.pool, null);
  console.log('ok  a failed token step records the failure; a re-run completes; an unsafe token never gets a pool');
}

// The wrong wallet cannot run someone else's launch, and a run cannot start twice at once.
{
  const owner = await fund(Keypair.generate(), 5);
  const record = store.create({ config: leanConfig(), walletPublicKey: owner.publicKey.toBase58() });
  await assert.rejects(() => runLaunch({ id: record.id, walletSecretKey: Array.from(Keypair.generate().secretKey), deps: makeDeps(owner) }), /different wallet/);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = runLaunch({ id: record.id, walletSecretKey: Array.from(owner.secretKey), deps: makeDeps(owner, { createToken: async (args) => { await gate; return TOKEN_RESULT(await makeToken(Keypair.fromSecretKey(Uint8Array.from(args.tempWalletSecretKey)), SUPPLY, Keypair.fromSecretKey(Uint8Array.from(args.vanityCAKeypair)))); } }) });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await assert.rejects(() => runLaunch({ id: record.id, walletSecretKey: Array.from(owner.secretKey), deps: makeDeps(owner) }), /already running/);
  release();
  assert.equal((await first).status, 'completed');
  console.log('ok  the wrong wallet is refused and a launch cannot run twice at once');
}

// ---- 7. the app's REAL token stage, not a stand-in -----------------------------------------------
// Only the Arweave upload and the connection are replaced. Everything the token stage does on chain
// (Token-2022 mint, on-mint metadata, supply, authorities) is the production code.
{
  const tokenService = await import('../../tokenService.js');
  const { createHash } = await import('node:crypto');
  const { getMint, getTokenMetadata } = await import('@solana/spl-token');
  tokenService.setConnectionFactoryForTests(() => connection);
  tokenService.setUmiFactoryForTests(() => ({}));
  tokenService.setUploaderForTests(async ({ name, symbol, mint, onProgress }) => {
    const metadata = JSON.stringify({ name, symbol, mint });
    const result = { metadataUri: 'https://example.invalid/metadata.json', imageUri: 'https://example.invalid/logo.png', metadata, metadataHash: createHash('sha256').update(metadata).digest('hex') };
    onProgress?.({ stage: 'metadata_uploaded', ...result });
    return result;
  });
  try {
    const wallet = await fund(Keypair.generate(), 8);
    // The production token stage works at finalized commitment, so the funding has to be finalized first.
    for (let i = 0; (await connection.getBalance(wallet.publicKey, 'finalized')) === 0; i += 1) {
      assert.ok(i < 120, 'the funding never finalized');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const record = store.create({ config: leanConfig(), walletPublicKey: wallet.publicKey.toBase58() });
    const done = await runLaunch({
      id: record.id,
      walletSecretKey: Array.from(wallet.secretKey),
      deps: makeDeps(wallet, { createToken: tokenService.createTokenWithMetaplex }),
    });
    assert.equal(done.status, 'completed');
    assert.equal(done.steps.token.mintAuthorityRenounced, true);
    assert.equal(done.steps.token.freezeAuthorityDisabled, true);
    assert.equal(done.steps.token.metadataImmutable, true);
    assert.equal(done.steps.pool.verification.passed, true);
    const mint = new (await import('@solana/web3.js')).PublicKey(done.steps.token.mint);
    const info = await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
    assert.equal(info.decimals, 9, 'the app\'s tokens have 9 decimals, which the pool math assumes');
    assert.equal(info.supply, SUPPLY, 'the whole supply exists');
    assert.equal(info.mintAuthority, null);
    assert.equal(info.freezeAuthority, null);
    const metadata = await getTokenMetadata(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
    assert.equal(metadata.name, 'Trebuchet');
    assert.equal(metadata.symbol, 'TREB');
    assert.equal(metadata.updateAuthority, undefined, 'the metadata is fixed');
    // The whole supply left the wallet and sits in the pool's vault.
    const poolState = await cpAmm.fetchPoolState(new (await import('@solana/web3.js')).PublicKey(done.steps.pool.pool));
    const vault = await getAccount(connection, poolState.tokenAVault, 'confirmed', TOKEN_2022_PROGRAM_ID);
    assert.equal(vault.amount, SUPPLY, 'the pool holds the entire supply');
    const walletAta = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
    assert.equal((await getAccount(connection, walletAta, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount, 0n, 'the launch wallet keeps none of it');
    console.log('ok  the real token stage + the pool: 9 decimals, authorities gone, metadata fixed, the whole supply in the locked pool');
  } finally {
    tokenService.resetConnectionFactoryForTests();
    tokenService.resetMetadataFactoriesForTests();
  }
}

console.log('\nDAMM v2 lean launch: all checks passed');
stop();
process.exit(0);
