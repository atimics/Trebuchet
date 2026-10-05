// Real Core assets, DAMM positions, vault custody, fees and ownership transfers.
// Required: compiled fee vault, a Core .so and a DAMM v2 .so. All funds are local.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createMint, createAccount, getOrCreateAssociatedTokenAccount, mintTo, getAccount, NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
import { create, createCollection, fetchCollectionV1, transferV1 } from '@metaplex-foundation/mpl-core';
import { generateSigner, publicKey } from '@metaplex-foundation/umi';
import { CpAmm, CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import { createNftUmi } from '../../nftService.js';
import { createLockedPool } from '../../dammV2Service.js';
import { claimFeeShare, feeVaultTokenAccounts, decodeFeeVault, initializeFeeVault, registerFeeShare, recoverFeeBacking, feeVaultAddress } from '../../feeVaultClient.js';

const core = process.env.TREBUCHET_CORE_SO;
const damm = process.env.TREBUCHET_DAMM_SO;
assert.ok(core && damm, 'Set TREBUCHET_CORE_SO and TREBUCHET_DAMM_SO to local program binaries');
const program = Keypair.generate().publicKey;
const upgradeAuthority = Keypair.generate();
process.env.TREBUCHET_FEE_VAULT_PROGRAM_ID = program.toBase58();
const binary = fs.readFileSync('programs/fee-vault/target/deploy/trebuchet_fee_vault.so');
let end = binary.length; while (end && binary[end - 1] === 0) end--;
process.env.TREBUCHET_FEE_VAULT_PROGRAM_SHA256 = createHash('sha256').update(binary.subarray(0, end)).digest('hex');
process.env.TREBUCHET_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fee-nft-profile-'));
const store = await import('../../feeNftStore.js');
const collections = await import('../../nftCollectionStore.js');
const service = await import('../../feeNftService.js');
const port = 22000 + Math.floor(Math.random() * 2000);
const rpc = `http://127.0.0.1:${port}`;
const ledger = fs.mkdtempSync(path.join(os.tmpdir(), 'fee-nft-ledger-'));
const validator = spawn('solana-test-validator', ['--reset', '--quiet', '--ledger', ledger, '--rpc-port', String(port), '--faucet-port', String(port + 2), '--gossip-port', String(port + 3),
  '--upgradeable-program', program.toBase58(), 'programs/fee-vault/target/deploy/trebuchet_fee_vault.so', upgradeAuthority.publicKey.toBase58(),
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
  const deployment = await connection.getAccountInfo(program);
  const programData = new PublicKey(deployment.data.subarray(4, 36));
  await assert.rejects(() => service.prepare({ rpcUrl: rpc, network: 'devnet', walletPublicKey: payer.publicKey.toBase58(), collectionId: nftRecord.id, venue: 'meteora', nativeNftMint: launched.positionNft, recipients: [alice.publicKey.toBase58(), bob.publicKey.toBase58()] }), /Finalize/);
  const finalize = new TransactionInstruction({ programId: deployment.owner, keys: [{ pubkey: programData, isWritable: true, isSigner: false }, { pubkey: upgradeAuthority.publicKey, isWritable: false, isSigner: true }], data: Buffer.from([4, 0, 0, 0]) });
  await sendAndConfirmTransaction(connection, new Transaction().add(finalize), [payer, upgradeAuthority]);
  const deploymentData = await connection.getAccountInfo(programData);
  assert.equal(deploymentData.data[12], 0, 'Vault deployment is immutable');
  const verifiedHash = process.env.TREBUCHET_FEE_VAULT_PROGRAM_SHA256;
  process.env.TREBUCHET_FEE_VAULT_PROGRAM_SHA256 = 'unreviewed';
  await assert.rejects(() => service.prepare({ rpcUrl: rpc, network: 'devnet', walletPublicKey: payer.publicKey.toBase58(), collectionId: nftRecord.id, venue: 'meteora', nativeNftMint: launched.positionNft, recipients: [alice.publicKey.toBase58(), bob.publicKey.toBase58()] }), /build hash/);
  process.env.TREBUCHET_FEE_VAULT_PROGRAM_SHA256 = verifiedHash;
  await assert.rejects(() => service.prepare({ rpcUrl: rpc, network: 'devnet', walletPublicKey: bob.publicKey.toBase58(), collectionId: nftRecord.id, venue: 'meteora', nativeNftMint: launched.positionNft, recipients: [alice.publicKey.toBase58(), bob.publicKey.toBase58()] }), /held by the signing wallet/);
  console.log('PASS: backing waits for verified immutable program deployment');
  const record = await service.prepare({ rpcUrl: rpc, network: 'devnet', walletPublicKey: payer.publicKey.toBase58(), collectionId: nftRecord.id, venue: 'meteora', nativeNftMint: launched.positionNft, recipients: [alice.publicKey.toBase58(), bob.publicKey.toBase58()] });
  // Exercise backing recovery before committing the fixed rights.
  const recoverySeed = [...Keypair.generate().publicKey.toBytes()];
  const recoveryVault = feeVaultAddress(program, payer.publicKey, recoverySeed);
  const nativeMint = new PublicKey(launched.positionNft); const nativeProgram = new PublicKey(record.plan.source.nativeTokenProgram);
  const recoveryAta = getAssociatedTokenAddressSync(nativeMint, recoveryVault, true, nativeProgram);
  const payerNftAta = getAssociatedTokenAddressSync(nativeMint, payer.publicKey, false, nativeProgram);
  const initialNft = (await connection.getTokenAccountsByOwner(payer.publicKey, { mint: nativeMint })).value.find((a) => a.account.data.readBigUInt64LE(64) === 1n).pubkey;
  await sendAndConfirmTransaction(connection, new Transaction().add(initializeFeeVault({ programId: program, creator: payer.publicKey, seed: recoverySeed, collection: collection.publicKey, source: record.plan.source, count: 2, totalWeight: 2 })), [payer]);
  await sendAndConfirmTransaction(connection, new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, recoveryAta, recoveryVault, nativeMint, nativeProgram), createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, payerNftAta, payer.publicKey, nativeMint, nativeProgram), createTransferCheckedInstruction(initialNft, nativeMint, recoveryAta, payer.publicKey, 1n, 0, [], nativeProgram)), [payer]);
  await assert.rejects(() => sendAndConfirmTransaction(connection, new Transaction().add(recoverFeeBacking({ programId: program, vault: recoveryVault, source: record.plan.source, creator: bob.publicKey })), [bob]));
  await sendAndConfirmTransaction(connection, new Transaction().add(recoverFeeBacking({ programId: program, vault: recoveryVault, source: record.plan.source, creator: payer.publicKey })), [payer]);
  assert.equal((await getAccount(connection, payerNftAta, 'confirmed', nativeProgram)).amount, 1n);
  console.log('PASS: creator can recover backing during setup; another wallet is refused');
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
  const interrupted = store.get(record.id);
  interrupted.operations['send-0'].status = 'prepared'; store.save(interrupted);
  service.startRun(record.id, { rpcUrl: rpc, walletPublicKey: payer.publicKey.toBase58(), secretKey: [...payer.secretKey], approvedDigest: record.plan.digest, confirmNativeNftMint: launched.positionNft, maxSpendLamports: 100_000_000 });
  for (let i = 0; service.jobStatus(record.id).status === 'running'; i++) { assert.ok(i < 30); await new Promise((r) => setTimeout(r, 500)); }
  assert.equal(service.jobStatus(record.id).status, 'complete', JSON.stringify(service.jobStatus(record.id)));
  assert.equal(store.get(record.id).operations['send-0'].status, 'confirmed');
  assert.equal(service.activeWallet(payer.publicKey.toBase58()), null);
  console.log('PASS: an NFT already delivered settles its saved send and releases the wallet');

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
  const alternate = await createAccount(connection, payer, token, new PublicKey(record.vault), Keypair.generate());
  const wrongSource = claimFeeShare({ programId: program, vault: record.vault, source: record.plan.source, owner: alice.publicKey, asset: assets[0], index: 0 });
  wrongSource.keys[3].pubkey = alternate;
  await assert.rejects(() => sendAndConfirmTransaction(connection, new Transaction().add(wrongSource), [alice]));
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
  await assert.rejects(() => sendAndConfirmTransaction(connection, new Transaction().add(recoverFeeBacking({ programId: program, vault: record.vault, source: record.plan.source, creator: payer.publicKey })), [payer]));
  console.log('PASS: shares stay fixed after activation; creator gets holder rights through NFT ownership');
  // Resume completed setup: original transaction receipts prevent duplicate sends.
  const signatures = Object.values(store.get(record.id).operations).filter((o) => o.scope === 'setup').map((o) => o.signature);
  service.startRun(record.id, { rpcUrl: rpc, walletPublicKey: payer.publicKey.toBase58(), secretKey: [...payer.secretKey], approvedDigest: record.plan.digest, confirmNativeNftMint: launched.positionNft, maxSpendLamports: 100_000_000 });
  for (let i = 0; service.jobStatus(record.id).status === 'running'; i++) { assert.ok(i < 30); await new Promise((r) => setTimeout(r, 500)); }
  assert.equal(service.jobStatus(record.id).status, 'complete', JSON.stringify(service.jobStatus(record.id)));
  assert.deepEqual(Object.values(store.get(record.id).operations).filter((o) => o.scope === 'setup').map((o) => o.signature), signatures);
  console.log('PASS: completed setup resumes with the same receipts');
  const proof = await service.importProof(store.publicView(store.get(record.id)), rpc);
  assert.equal(proof.id, record.id);
  await buy();
  const holderHarvest = await service.prepareHolderClaim(record.id, { rpcUrl: rpc, walletPublicKey: buyer.publicKey.toBase58(), action: 'harvest', maxSpendLamports: 10_000_000 });
  await sendAndConfirmTransaction(connection, Transaction.from(Buffer.from(holderHarvest.transaction, 'base64')), [buyer]);
  const holderProposal = await service.prepareHolderClaim(record.id, { rpcUrl: rpc, walletPublicKey: buyer.publicKey.toBase58(), index: 0, maxSpendLamports: 10_000_000 });
  const holderTx = Transaction.from(Buffer.from(holderProposal.transaction, 'base64'));
  assert.equal(holderTx.feePayer.toBase58(), buyer.publicKey.toBase58());
  assert.equal(holderTx.signatures[0].signature, null);
  await sendAndConfirmTransaction(connection, holderTx, [buyer]);
  await assert.rejects(() => service.prepareHolderClaim(record.id, { rpcUrl: rpc, walletPublicKey: alice.publicKey.toBase58(), index: 0, maxSpendLamports: 10_000_000 }));
  await assert.rejects(() => service.importProof({ plan: { ...record.plan, count: 54 } }, rpc));
  console.log('PASS: portable proof and unsigned holder claim keep signing in the holder wallet');
} finally {
  validator.kill('SIGTERM');
  await new Promise((resolve) => { validator.once('exit', resolve); setTimeout(resolve, 3000); });
  fs.rmSync(ledger, { recursive: true, force: true }); fs.rmSync(process.env.TREBUCHET_CONFIG_DIR, { recursive: true, force: true });
}
// SDK confirmation sockets can remain open after the isolated validator exits.
process.exit(0);
