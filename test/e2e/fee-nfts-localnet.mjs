// Real Core assets, DAMM positions, vault custody, fees and ownership transfers.
// Required: compiled fee vault, a Core .so and a DAMM v2 .so. All funds are local.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { create, createCollection, fetchCollectionV1, transferV1 } from '@metaplex-foundation/mpl-core';
import { generateSigner, publicKey } from '@metaplex-foundation/umi';
import { CpAmm, CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import { createNftUmi } from '../../nftService.js';
import { createLockedPool } from '../../dammV2Service.js';
import { claimFeeShare, feeVaultTokenAccounts, decodeFeeVault, initializeFeeVault, registerFeeShare } from '../../feeVaultClient.js';

const core = process.env.TREBUCHET_CORE_SO;
const damm = process.env.TREBUCHET_DAMM_SO;
assert.ok(core && damm, 'Set TREBUCHET_CORE_SO and TREBUCHET_DAMM_SO to local program binaries');
const program = Keypair.generate().publicKey;
process.env.TREBUCHET_FEE_VAULT_PROGRAM_ID = program.toBase58();
process.env.TREBUCHET_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fee-nft-profile-'));
const store = await import('../../feeNftStore.js');
const collections = await import('../../nftCollectionStore.js');
const service = await import('../../feeNftService.js');
const port = 22000 + Math.floor(Math.random() * 2000);
const rpc = `http://127.0.0.1:${port}`;
const ledger = fs.mkdtempSync(path.join(os.tmpdir(), 'fee-nft-ledger-'));
const validator = spawn('solana-test-validator', ['--reset', '--quiet', '--ledger', ledger, '--rpc-port', String(port), '--faucet-port', String(port + 2), '--gossip-port', String(port + 3),
  '--bpf-program', program.toBase58(), 'programs/fee-vault/target/deploy/trebuchet_fee_vault.so',
  '--bpf-program', 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d', core,
  '--bpf-program', CP_AMM_PROGRAM_ID.toBase58(), damm], { stdio: ['ignore', 'ignore', 'pipe'] });
let validatorError = ''; validator.stderr.on('data', (c) => { validatorError += c; });
const connection = new Connection(rpc, 'confirmed');
try {
  for (let i = 0; ; i++) { try { await connection.getVersion(); break; } catch { if (i > 60) throw new Error(validatorError); await new Promise((r) => setTimeout(r, 500)); } }
  const payer = Keypair.generate(); const alice = Keypair.generate(); const bob = Keypair.generate(); const buyer = Keypair.generate();
  for (const wallet of [payer, alice, bob, buyer]) await connection.confirmTransaction(await connection.requestAirdrop(wallet.publicKey, 30 * LAMPORTS_PER_SOL), 'confirmed');
  const token = await createMint(connection, payer, payer.publicKey, null, 6);
  const tokenAccount = await getOrCreateAssociatedTokenAccount(connection, payer, token, payer.publicKey);
  await mintTo(connection, payer, token, tokenAccount.address, payer, 1_000_000_000_000_000n);
  const launched = await createLockedPool({ connection, payer, mint: token, supplyRaw: 1_000_000_000_000_000n, startingMarketCapLamports: 2100n * 1_000_000_000n, rangeMultiple: 1000, feeBps: 25 });
  const umi = createNftUmi({ rpcUrl: rpc, payerSecretKey: payer.secretKey });
  const collection = generateSigner(umi);
  const minted = await createCollection(umi, { collection, name: 'Brand fees', uri: 'https://example.com/brand.json' }).sendAndConfirm(umi);
  const assets = [];
  for (let i = 0; i < 2; i++) {
    const asset = generateSigner(umi);
    await create(umi, { asset, collection: await fetchCollectionV1(umi, collection.publicKey), name: `Brand #${i + 1}`, uri: `https://example.com/${i}.json` }).sendAndConfirm(umi);
    assets.push(asset.publicKey);
  }
  const nftRecord = collections.create({ name: 'Brand fees', symbol: 'BRAND', description: '', creators: [], royaltyBps: 0 });
  collections.update(nftRecord.id, (r) => {
    r.collectionKey = { address: String(collection.publicKey) }; r.collectionSignature = String(minted.signature);
    r.items = assets.map((address, index) => ({ index, key: { address: String(address) }, name: `Brand #${index + 1}`, mintSignature: 'local-confirmed' }));
  });
  const record = await service.prepare({ rpcUrl: rpc, network: 'devnet', walletPublicKey: payer.publicKey.toBase58(), collectionId: nftRecord.id, venue: 'meteora', nativeNftMint: launched.positionNft, recipients: [alice.publicKey.toBase58(), bob.publicKey.toBase58()] });
  service.startRun(record.id, { rpcUrl: rpc, walletPublicKey: payer.publicKey.toBase58(), secretKey: [...payer.secretKey], approvedDigest: record.plan.digest, confirmNativeNftMint: launched.positionNft, maxSpendLamports: 100_000_000 });
  for (let i = 0; service.jobStatus(record.id).status === 'running'; i++) { assert.ok(i < 180, 'Setup completes'); await new Promise((r) => setTimeout(r, 500)); }
  assert.equal(service.jobStatus(record.id).status, 'complete', JSON.stringify(service.jobStatus(record.id)));
  let view = await service.snapshot(store.get(record.id), rpc);
  assert.ok(view.onChain.active);
  assert.equal(view.onChain.shares[0].owner, alice.publicKey.toBase58());
  assert.equal(view.onChain.shares[1].owner, bob.publicKey.toBase58());
  const receivedNft = await getAccount(connection, (await connection.getTokenAccountsByOwner(new PublicKey(record.vault), { mint: new PublicKey(launched.positionNft) })).value[0].pubkey, 'confirmed', new PublicKey(record.plan.source.nativeTokenProgram));
  assert.equal(receivedNft.amount, 1n);
  console.log('PASS: branded NFTs sent, locked position held by vault, shares fixed');

  const cp = new CpAmm(connection); const pool = await cp.fetchPoolState(new PublicKey(launched.pool));
  const buy = async () => sendAndConfirmTransaction(connection, await cp.swap({ payer: buyer.publicKey, pool: new PublicKey(launched.pool), inputTokenMint: NATIVE_MINT, outputTokenMint: token, amountIn: new BN(1_000_000_000), minimumAmountOut: new BN(0), tokenAMint: pool.tokenAMint, tokenBMint: pool.tokenBMint, tokenAVault: pool.tokenAVault, tokenBVault: pool.tokenBVault, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null }), [buyer]);
  await buy();
  await service.transact(record.id, { rpcUrl: rpc, walletPublicKey: payer.publicKey.toBase58(), secretKey: [...payer.secretKey], action: 'harvest', maxSpendLamports: 10_000_000 });
  view = await service.snapshot(store.get(record.id), rpc);
  assert.ok(BigInt(view.onChain.received[1]) > 0n);
  assert.equal(view.onChain.shares[0].claimable[1], view.onChain.shares[1].claimable[1]);
  const aliceBefore = BigInt(view.onChain.shares[0].claimable[1]);
  const claim = (owner, index) => service.transact(record.id, { rpcUrl: rpc, walletPublicKey: owner.publicKey.toBase58(), secretKey: [...owner.secretKey], action: 'claim', index, maxSpendLamports: 10_000_000 });
  await claim(alice, 0); await claim(alice, 0);
  const aliceQuote = await getOrCreateAssociatedTokenAccount(connection, alice, NATIVE_MINT, alice.publicKey);
  assert.equal((await getAccount(connection, aliceQuote.address)).amount, aliceBefore);
  console.log('PASS: actual trading fees collected through vault CPI; equal claims; repeat claim pays zero');

  const aliceUmi = createNftUmi({ rpcUrl: rpc, payerSecretKey: alice.secretKey });
  await transferV1(aliceUmi, { asset: assets[0], collection: collection.publicKey, newOwner: publicKey(buyer.publicKey.toBase58()) }).sendAndConfirm(aliceUmi);
  await assert.rejects(() => claim(alice, 0));
  await buy();
  await service.transact(record.id, { rpcUrl: rpc, walletPublicKey: payer.publicKey.toBase58(), secretKey: [...payer.secretKey], action: 'harvest', maxSpendLamports: 10_000_000 });
  await claim(buyer, 0); await claim(bob, 1);
  const quoteAccounts = feeVaultTokenAccounts(record.vault, record.plan.source);
  const remaining = (await getAccount(connection, quoteAccounts[1])).amount;
  const state = decodeFeeVault((await connection.getAccountInfo(new PublicKey(record.vault))).data);
  assert.ok(remaining < 2n);
  assert.ok(BigInt(state.paid[1]) > 0n);
  console.log('PASS: transfer moves fee rights; previous owner refused; lifetime balances conserve funds');

  await assert.rejects(() => sendAndConfirmTransaction(connection, new Transaction().add(registerFeeShare({ programId: program, creator: payer.publicKey, vault: record.vault, asset: assets[0], index: 0, weight: 2 })), [payer]));
  await assert.rejects(() => sendAndConfirmTransaction(connection, new Transaction().add(claimFeeShare({ programId: program, vault: record.vault, source: record.plan.source, owner: payer.publicKey, asset: assets[0], index: 0 })), [payer]));
  console.log('PASS: shares stay fixed after activation; creator gets holder rights through NFT ownership');
  // Resume completed setup: original transaction receipts prevent duplicate sends.
  const signatures = Object.values(store.get(record.id).operations).filter((o) => o.scope === 'setup').map((o) => o.signature);
  service.startRun(record.id, { rpcUrl: rpc, walletPublicKey: payer.publicKey.toBase58(), secretKey: [...payer.secretKey], approvedDigest: record.plan.digest, confirmNativeNftMint: launched.positionNft, maxSpendLamports: 100_000_000 });
  for (let i = 0; service.jobStatus(record.id).status === 'running'; i++) { assert.ok(i < 30); await new Promise((r) => setTimeout(r, 500)); }
  assert.equal(service.jobStatus(record.id).status, 'complete', JSON.stringify(service.jobStatus(record.id)));
  assert.deepEqual(Object.values(store.get(record.id).operations).filter((o) => o.scope === 'setup').map((o) => o.signature), signatures);
  console.log('PASS: completed setup resumes with the same receipts');
} finally {
  validator.kill('SIGTERM');
  await new Promise((resolve) => { validator.once('exit', resolve); setTimeout(resolve, 3000); });
  fs.rmSync(ledger, { recursive: true, force: true }); fs.rmSync(process.env.TREBUCHET_CONFIG_DIR, { recursive: true, force: true });
}
