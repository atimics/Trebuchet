// Public Raydium state and real programs, copied into an isolated validator.
// The local genesis gives a fresh signer the Fee Key and seeds 1,000 fee units.
// Every transaction below uses local funds. RPC access only reads public state.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount } from '@solana/spl-token';
import { create, createCollection, fetchCollectionV1, transferV1 } from '@metaplex-foundation/mpl-core';
import { generateSigner, publicKey } from '@metaplex-foundation/umi';
import { ClmmInstrument, LockClPositionLayoutV2, PoolInfoLayout, PositionInfoLayout, CLMM_LOCK_PROGRAM_ID, CLMM_LOCK_AUTH_ID, CLMM_PROGRAM_ID,
  getPdaProtocolPositionAddress, getPdaTickArrayAddress, getPdaExBitmapAccount, TickUtils } from '@raydium-io/raydium-sdk-v2';
import { createNftUmi } from '../../nftService.js';
import { feeVaultTokenAccounts, claimFeeShare, harvestFeeVault } from '../../feeVaultClient.js';

const binaryPaths = [process.env.TREBUCHET_CORE_SO, process.env.TREBUCHET_RAY_LOCK_SO, process.env.TREBUCHET_RAY_CLMM_SO];
assert.ok(binaryPaths.every(Boolean), 'Set Core, Raydium lock and CLMM binary paths');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fee-ray-local-'));
process.env.TREBUCHET_CONFIG_DIR = path.join(work, 'profile');
const program = Keypair.generate().publicKey; const upgradeAuthority = Keypair.generate(); const payer = Keypair.generate(); const alice = Keypair.generate(); const bob = Keypair.generate();
process.env.TREBUCHET_FEE_VAULT_PROGRAM_ID = program.toBase58();
const binary = fs.readFileSync('programs/fee-vault/target/deploy/trebuchet_fee_vault.so');
let end = binary.length; while (end && binary[end - 1] === 0) end--;
process.env.TREBUCHET_FEE_VAULT_PROGRAM_SHA256 = createHash('sha256').update(binary.subarray(0, end)).digest('hex');
const store = await import('../../feeNftStore.js'); const collections = await import('../../nftCollectionStore.js'); const service = await import('../../feeNftService.js');
const remote = new Connection(process.env.TREBUCHET_RAY_SNAPSHOT_RPC || 'https://api.mainnet-beta.solana.com', 'finalized');
assert.equal(await remote.getGenesisHash(), '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
await assert.rejects(() => service.prepare({ rpcUrl: remote.rpcEndpoint, network: 'devnet' }), { code: 'FEE_SECURITY_REVIEW' });
const lockAddress = new PublicKey(process.env.TREBUCHET_RAY_SNAPSHOT_LOCK || '9Ed6m2hwTHkMyPJgeqS3Mc7JuiKZXUC21HTFrh1XtesA');
const lockInfo = await remote.getAccountInfo(lockAddress); assert.ok(lockInfo.owner.equals(CLMM_LOCK_PROGRAM_ID));
const lock = LockClPositionLayoutV2.decode(lockInfo.data);
const initial = await remote.getMultipleAccountsInfo([lock.positionId, lock.poolId]);
assert.ok(initial[0].owner.equals(CLMM_PROGRAM_ID) && initial[1].owner.equals(CLMM_PROGRAM_ID));
const position = PositionInfoLayout.decode(initial[0].data); const pool = PoolInfoLayout.decode(initial[1].data);
const nativeAta = getAssociatedTokenAddressSync(lock.lockNftMint, payer.publicKey);
const bitmap = getPdaExBitmapAccount(CLMM_PROGRAM_ID, lock.poolId).publicKey;
const sdkFields = { programId: CLMM_LOCK_PROGRAM_ID, auth: CLMM_LOCK_AUTH_ID, clmmProgram: CLMM_PROGRAM_ID, lockPositionId: lockAddress, lockOwner: payer.publicKey,
  lockNftMint: lock.lockNftMint, lockNftAccount: nativeAta, positionNftAccount: lock.nftAccount, positionId: lock.positionId, poolId: lock.poolId,
  protocolPosition: getPdaProtocolPositionAddress(CLMM_PROGRAM_ID, lock.poolId, position.tickLower, position.tickUpper).publicKey,
  tickArrayLower: getPdaTickArrayAddress(CLMM_PROGRAM_ID, lock.poolId, TickUtils.getTickArrayStartIndexByTick(position.tickLower, pool.tickSpacing)).publicKey,
  tickArrayUpper: getPdaTickArrayAddress(CLMM_PROGRAM_ID, lock.poolId, TickUtils.getTickArrayStartIndexByTick(position.tickUpper, pool.tickSpacing)).publicKey,
  vaultA: pool.vaultA, vaultB: pool.vaultB, userVaultA: getAssociatedTokenAddressSync(pool.mintA, payer.publicKey), userVaultB: getAssociatedTokenAddressSync(pool.mintB, payer.publicKey),
  mintA: pool.mintA, mintB: pool.mintB, rewardAccounts: [], exTickArrayBitmap: await remote.getAccountInfo(bitmap) ? bitmap : undefined };
const sdkIx = ClmmInstrument.harvestLockPositionInstructionV2(sdkFields);
const keys = [...new Set([...sdkIx.keys.map((k) => k.pubkey.toBase58()), lock.lockNftMint.toBase58(), position.nftMint.toBase58()])].map((k) => new PublicKey(k));
const infos = await remote.getMultipleAccountsInfo(keys);
const port = 25000 + Math.floor(Math.random() * 2000); const rpc = `http://127.0.0.1:${port}`;
const args = ['--reset', '--quiet', '--ledger', path.join(work, 'ledger'), '--rpc-port', String(port), '--faucet-port', String(port + 2), '--gossip-port', String(port + 3),
  '--upgradeable-program', program.toBase58(), 'programs/fee-vault/target/deploy/trebuchet_fee_vault.so', upgradeAuthority.publicKey.toBase58(),
  '--bpf-program', 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d', binaryPaths[0],
  '--bpf-program', CLMM_LOCK_PROGRAM_ID.toBase58(), binaryPaths[1], '--bpf-program', CLMM_PROGRAM_ID.toBase58(), binaryPaths[2]];
function genesisAccount(key, info) {
  const filename = path.join(work, `${key}.json`);
  fs.writeFileSync(filename, JSON.stringify({ pubkey: String(key), account: { ...info, data: [Buffer.from(info.data).toString('base64'), 'base64'], owner: String(info.owner), rentEpoch: 0 } }));
  args.push('--account', String(key), filename);
}
for (let i = 0; i < keys.length; i++) {
  const info = infos[i]; if (!info || info.executable) continue;
  if (keys[i].equals(lock.positionId)) {
    // Seed a bounded amount so the native harvest always exercises payment.
    info.data.writeBigUInt64LE(1_000n, PositionInfoLayout.offsetOf('tokenFeesOwedA'));
    info.data.writeBigUInt64LE(1_000n, PositionInfoLayout.offsetOf('tokenFeesOwedB'));
  }
  genesisAccount(keys[i], info);
}
const nativeData = Buffer.alloc(165); lock.lockNftMint.toBuffer().copy(nativeData); payer.publicKey.toBuffer().copy(nativeData, 32); nativeData.writeBigUInt64LE(1n, 64); nativeData[108] = 1;
genesisAccount(nativeAta, { lamports: 2_039_280, data: nativeData, owner: TOKEN_PROGRAM_ID, executable: false });
const validator = spawn('solana-test-validator', args, { stdio: ['ignore', 'ignore', 'pipe'] }); let logs = ''; validator.stderr.on('data', (s) => { logs += s; });
const c = new Connection(rpc, 'confirmed');
try {
  for (let i = 0; ; i++) { try { await c.getVersion(); break; } catch { assert.ok(i < 60, logs); await new Promise((r) => setTimeout(r, 500)); } }
  for (const wallet of [payer, alice, bob]) await c.confirmTransaction(await c.requestAirdrop(wallet.publicKey, 30 * LAMPORTS_PER_SOL), 'confirmed');
  const deployment = await c.getAccountInfo(program); const programData = new PublicKey(deployment.data.subarray(4, 36));
  await sendAndConfirmTransaction(c, new Transaction().add(new TransactionInstruction({ programId: deployment.owner, keys: [{ pubkey: programData, isWritable: true, isSigner: false }, { pubkey: upgradeAuthority.publicKey, isWritable: false, isSigner: true }], data: Buffer.from([4, 0, 0, 0]) })), [payer, upgradeAuthority]);
  const umi = createNftUmi({ rpcUrl: rpc, payerSecretKey: payer.secretKey }); const collection = generateSigner(umi);
  const minted = await createCollection(umi, { collection, name: 'Ray fees', uri: 'https://example.com/ray' }).sendAndConfirm(umi);
  const assets = [];
  for (let i = 0; i < 2; i++) { const asset = generateSigner(umi); await create(umi, { asset, collection: await fetchCollectionV1(umi, collection.publicKey), name: `Ray #${i}`, uri: 'https://example.com/ray' }).sendAndConfirm(umi); assets.push(asset.publicKey); }
  const nft = collections.create({ name: 'Ray fees', symbol: 'RAY', description: '', creators: [], royaltyBps: 0 });
  collections.update(nft.id, (r) => { r.collectionKey = { address: String(collection.publicKey) }; r.collectionSignature = String(minted.signature); r.items = assets.map((a, index) => ({ index, key: { address: String(a) }, name: `Ray #${index}`, mintSignature: 'local-confirmed' })); });
  const record = await service.prepare({ rpcUrl: rpc, network: 'mainnet', walletPublicKey: payer.publicKey.toBase58(), collectionId: nft.id, venue: 'raydium', nativeNftMint: lock.lockNftMint.toBase58(), recipients: [alice.publicKey.toBase58(), bob.publicKey.toBase58()] });
  service.startRun(record.id, { rpcUrl: rpc, walletPublicKey: payer.publicKey.toBase58(), secretKey: [...payer.secretKey], approvedDigest: record.plan.digest, confirmNativeNftMint: record.plan.source.nativeNftMint, maxSpendLamports: 100_000_000 });
  for (let i = 0; service.jobStatus(record.id).status === 'running'; i++) { assert.ok(i < 180); await new Promise((r) => setTimeout(r, 500)); }
  assert.equal(service.jobStatus(record.id).status, 'complete', JSON.stringify(service.jobStatus(record.id)));
  await service.transact(record.id, { rpcUrl: rpc, walletPublicKey: payer.publicKey.toBase58(), secretKey: [...payer.secretKey], action: 'harvest', maxSpendLamports: 10_000_000 });
  const view = await service.snapshot(store.get(record.id), rpc);
  assert.ok(view.onChain.shares[0].claimable.every((n) => BigInt(n) > 0n));
  assert.deepEqual(view.onChain.shares[0].claimable, view.onChain.shares[1].claimable);
  const claim = (owner, index) => service.transact(record.id, { rpcUrl: rpc, walletPublicKey: owner.publicKey.toBase58(), secretKey: [...owner.secretKey], action: 'claim', index, maxSpendLamports: 10_000_000 });
  await claim(alice, 0); await claim(alice, 0); await claim(bob, 1);
  for (let n = 0; n < 2; n++) assert.equal((await getAccount(c, getAssociatedTokenAddressSync(new PublicKey(record.plan.source.mints[n]), alice.publicKey, false, new PublicKey(record.plan.source.tokenPrograms[n])), 'confirmed', new PublicKey(record.plan.source.tokenPrograms[n]))).amount, BigInt(view.onChain.shares[0].claimable[n]));
  const aliceUmi = createNftUmi({ rpcUrl: rpc, payerSecretKey: alice.secretKey });
  await transferV1(aliceUmi, { asset: assets[0], collection: collection.publicKey, newOwner: publicKey(bob.publicKey.toBase58()) }).sendAndConfirm(aliceUmi);
  await assert.rejects(() => claim(alice, 0)); await claim(bob, 0);
  const wrong = claimFeeShare({ programId: program, vault: record.vault, collection: collection.publicKey, source: record.plan.source, owner: bob.publicKey, asset: assets[0], index: 0 });
  wrong.keys[5].pubkey = getAssociatedTokenAddressSync(new PublicKey(record.plan.source.mints[0]), alice.publicKey, false, new PublicKey(record.plan.source.tokenPrograms[0]));
  await assert.rejects(() => sendAndConfirmTransaction(c, new Transaction().add(wrong), [bob]));
  const outputs = feeVaultTokenAccounts(record.vault, record.plan.source);
  const redirected = ClmmInstrument.harvestLockPositionInstructionV2({ ...sdkFields, lockOwner: new PublicKey(record.vault), lockNftAccount: getAssociatedTokenAddressSync(lock.lockNftMint, new PublicKey(record.vault), true), userVaultA: outputs[0], userVaultB: outputs[1] });
  const bad = harvestFeeVault({ programId: program, vault: record.vault, source: record.plan.source, instruction: redirected }); bad.keys[4 + 13].pubkey = sdkFields.userVaultA;
  await assert.rejects(() => sendAndConfirmTransaction(c, new Transaction().add(bad), [payer]));
  const evidence = { scope: 'isolated local validator with public Raydium state', seededFeeUnits: 1000, lock: lockAddress.toBase58(), wrapperHash: process.env.TREBUCHET_FEE_VAULT_PROGRAM_SHA256, programHashes: binaryPaths.map((p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex')), passed: ['native harvest CPI', 'equal payouts', 'repeat claims', 'ownership transfer', 'claim redirection refused', 'harvest redirection refused', 'actual mainnet genesis backing gate'] };
  if (process.env.TREBUCHET_FEE_RAY_EVIDENCE) fs.writeFileSync(process.env.TREBUCHET_FEE_RAY_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
  console.log('PASS: Raydium native harvest, payouts, transfer rights and payment redirection checks');
} finally {
  validator.kill('SIGTERM'); await new Promise((r) => { validator.once('exit', r); setTimeout(r, 3000); }); fs.rmSync(work, { recursive: true, force: true });
}
process.exit(0);
