// Copy only public program/config accounts. All fixture creation and spending
// run on a private validator with local test SOL and deterministic test keys.
// Run: npm run test:e2e:runtime-support:localnet [-- --nft2022 --transfer-fee-output --fresh-output]
// --native-b reverses the pool token order.
// --prefunded-output also creates a fresh output account with existing local SOL.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, PublicKey, SystemProgram, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, MINT_SIZE, getAssociatedTokenAddressSync, getAccount, getMint,
  createInitializeMint2Instruction, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, createSyncNativeInstruction,
  ExtensionType, getMintLen, getTransferFeeAmount, createInitializeTransferFeeConfigInstruction,
  createBurnCheckedInstruction, createCloseAccountInstruction } from '@solana/spl-token';
import { CLMM_PROGRAM_ID, ClmmInstrument, ClmmConfigLayout, PoolInfoLayout, PositionInfoLayout, getPdaAmmConfigId, getPdaPersonalPositionAddress } from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import { openRuntimeStore } from '../../packages/runtime/src/store.js';
import { SOLANA_GENESIS_HASHES } from '../../packages/runtime/src/solana.js';

const nativeB = process.argv.includes('--native-b');
const nft2022 = process.argv.includes('--nft2022'), transferFeeOutput = process.argv.includes('--transfer-fee-output');
const prefundedOutput = process.argv.includes('--prefunded-output'), freshOutput = prefundedOutput || process.argv.includes('--fresh-output');
const tokenProgram = transferFeeOutput ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
const mode = [nft2022 ? 'nft2022' : 'classic', ...(nativeB ? ['native-b'] : []), ...(transferFeeOutput ? ['transfer-fee'] : []), ...(prefundedOutput ? ['prefunded-output'] : freshOutput ? ['fresh-output'] : [])].join('/');
const sourceRpc = 'https://api.mainnet-beta.solana.com';
const wallet = Keypair.fromSeed(new Uint8Array(32).fill(43)), mint = Keypair.fromSeed(new Uint8Array(32).fill(nativeB ? 58 : 60)), nft = Keypair.fromSeed(new Uint8Array(32).fill(63));
const configKey = getPdaAmmConfigId(CLMM_PROGRAM_ID, 0).publicKey, metadata = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-validator-support-')), accounts = path.join(profile, 'accounts'); fs.mkdirSync(accounts);
const logFile = path.join(profile, 'validator.log'), log = fs.openSync(logFile, 'a', 0o600), children = [], accepted = new Map(), rpcErrors = [];
let validator, proxy, activeChild, connection, crashed = false, laggingSignature = null, duplicates = 0, rpcRequests = 0, passed = false;
const publicRead = async (method, params = []) => {
  assert.ok(['getGenesisHash', 'getMultipleAccounts'].includes(method));
  const response = await fetch(sourceRpc, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
  assert.equal(response.ok, true, `Public fixture read: ${response.status}`);
  const reply = JSON.parse(await response.text(), (key, value, context) => key === 'rentEpoch' ? BigInt(context.source) : value);
  if (reply.error) throw new Error(JSON.stringify(reply.error)); return reply.result;
};
const freePort = async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const a = net.createServer(), b = net.createServer();
    try { a.listen(0, '127.0.0.1'); await once(a, 'listening'); const port = a.address().port; b.listen(port + 1, '127.0.0.1'); await once(b, 'listening'); return port; }
    catch { /* Try another available RPC/websocket pair. */ }
    finally { await Promise.all([a, b].map((server) => new Promise((resolve) => server.close(resolve)))); }
  }
  throw new Error('Choose free local validator ports');
};
const waitFor = async (check, label, timeout = 60000) => {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { last = error; }
    if (validator?.exitCode !== null && validator?.exitCode !== undefined) throw new Error(`Validator exited during ${label}`);
    await sleep(300);
  }
  throw new Error(`Timed out during ${label}: ${last?.message || 'pending'}`);
};
const finalized = async (signature, label) => {
  let status;
  await waitFor(async () => {
    status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    return status?.confirmationStatus === 'finalized';
  }, label);
  assert.equal(status.err, null, `${label}: ${JSON.stringify(status.err)}`);
};
const stop = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close'), force = setTimeout(() => child.kill('SIGKILL'), 5000); child.kill('SIGTERM');
  try { await closed; } finally { clearTimeout(force); }
};
const sendFixture = async (instructions, signers, label) => {
  const { blockhash } = await connection.getLatestBlockhash('finalized');
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }), ...instructions] }).compileToV0Message());
  tx.sign([wallet, ...signers]);
  const signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'finalized' }); await finalized(signature, label);
  process.stdout.write(`${label}: finalized ${signature}\n`); return signature;
};
try {
  assert.equal(await publicRead('getGenesisHash'), SOLANA_GENESIS_HASHES.mainnet);
  const keys = [CLMM_PROGRAM_ID, configKey, ...(nft2022 ? [] : [metadata])];
  const snapshot = await publicRead('getMultipleAccounts', [keys.map((key) => key.toBase58()), { commitment: 'finalized', encoding: 'base64' }]);
  const hashes = {}, programs = [];
  const save = (key, account) => {
    assert.ok(account, `Read public account ${key}`);
    fs.writeFileSync(path.join(accounts, `${key}.json`), JSON.stringify({ pubkey: key, account }, (_, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value));
    const data = Buffer.from(account.data[0], 'base64'); hashes[key] = createHash('sha256').update(data).digest('hex');
    if (account.executable && account.owner === 'BPFLoaderUpgradeab1e11111111111111111111111') { assert.equal(data.readUInt32LE(0), 2); programs.push(new PublicKey(data.subarray(4, 36)).toBase58()); }
  };
  keys.forEach((key, index) => save(key.toBase58(), snapshot.value[index]));
  const programSnapshot = await publicRead('getMultipleAccounts', [programs, { commitment: 'finalized', encoding: 'base64', minContextSlot: snapshot.context.slot }]);
  programs.forEach((key, index) => save(key, programSnapshot.value[index]));
  const config = ClmmConfigLayout.decode(Buffer.from(snapshot.value[1].data[0], 'base64'));
  assert.ok(Number.isInteger(config.tickSpacing) && config.tickSpacing > 0);
  const port = await freePort(), faucet = await freePort(), url = `http://127.0.0.1:${port}`;
  validator = spawn('solana-test-validator', ['--quiet', '--ledger', path.join(profile, 'ledger'), '--bind-address', '127.0.0.1', '--rpc-port', String(port),
    '--faucet-port', String(faucet), '--mint', Keypair.fromSeed(new Uint8Array(32).fill(99)).publicKey.toBase58(), '--account-dir', accounts,
    '--warp-slot', String(programSnapshot.context.slot + 10)], { stdio: ['ignore', log, log] });
  await once(validator, 'spawn'); connection = new Connection(url, 'finalized');
  await waitFor(() => connection.getVersion(), 'validator startup');
  const genesisHash = await connection.getGenesisHash(); await finalized(await connection.requestAirdrop(wallet.publicKey, 2000000000), 'local funding');
  assert.equal(await connection.getBalance(wallet.publicKey, 'finalized'), 2000000000);
  const output = getAssociatedTokenAddressSync(mint.publicKey, wallet.publicKey, false, tokenProgram), native = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
  const mintSize = transferFeeOutput ? getMintLen([ExtensionType.TransferFeeConfig]) : MINT_SIZE;
  const rent = await connection.getMinimumBalanceForRentExemption(mintSize, 'finalized');
  await sendFixture([SystemProgram.createAccount({ fromPubkey: wallet.publicKey, newAccountPubkey: mint.publicKey, space: mintSize, lamports: rent, programId: tokenProgram }),
    ...(transferFeeOutput ? [createInitializeTransferFeeConfigInstruction(mint.publicKey, null, null, 250, 1000000n)] : []),
    createInitializeMint2Instruction(mint.publicKey, 9, wallet.publicKey, null, tokenProgram),
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, output, wallet.publicKey, mint.publicKey, tokenProgram),
    createMintToInstruction(mint.publicKey, output, wallet.publicKey, 100000000000n, [], tokenProgram),
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, native, wallet.publicKey, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: native, lamports: 100000000 }), createSyncNativeInstruction(native)], [mint], 'fixture token accounts');
  const mints = [mint.publicKey, NATIVE_MINT].sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer())).map((key) => ({ address: key.toBase58(), programId: (key.equals(NATIVE_MINT) ? TOKEN_PROGRAM_ID : tokenProgram).toBase58(), decimals: 9 }));
  const pool = await ClmmInstrument.createPoolInstructions({ connection, programId: CLMM_PROGRAM_ID, owner: wallet.publicKey, mintA: mints[0], mintB: mints[1],
    ammConfigId: configKey, initialPriceX64: new BN(2).pow(new BN(64)), extendMintAccount: [] });
  await sendFixture(pool.instructions, pool.signers, 'fixture CLMM pool');
  const poolId = pool.address.poolId.toBase58();
  const positionAddress = getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, nft.publicKey).publicKey;
  const nftProgram = nft2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const nftAccount = getAssociatedTokenAddressSync(nft.publicKey, wallet.publicKey, false, nftProgram);
  const nativeIsA = mints[0].address === NATIVE_MINT.toBase58();
  const tickLower = (nativeIsA ? 10 : -100) * config.tickSpacing, tickUpper = (nativeIsA ? 100 : -10) * config.tickSpacing;
  const initialOutput = await getAccount(connection, output, 'finalized', tokenProgram);
  if (freshOutput) {
    await sendFixture([createBurnCheckedInstruction(output, mint.publicKey, wallet.publicKey, initialOutput.amount, 9, [], tokenProgram),
      createCloseAccountInstruction(output, wallet.publicKey, wallet.publicKey, [], tokenProgram),
      ...(prefundedOutput ? [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: output, lamports: 1000000 })] : [])], [], 'fixture fresh output');
    const account = await connection.getAccountInfo(output, 'finalized');
    if (prefundedOutput) { assert.ok(account.owner.equals(SystemProgram.programId)); assert.equal(account.lamports, 1000000); }
    else assert.equal(account, null);
  }
  const tokenVault = mints[0].address === mint.publicKey.toBase58() ? pool.address.mintAVault : pool.address.mintBVault;
  const before = { wallet: await connection.getBalance(wallet.publicKey, 'finalized'), token: freshOutput ? 0n : initialOutput.amount,
    withheld: freshOutput ? 0n : getTransferFeeAmount(initialOutput)?.withheldAmount || 0n, vault: (await getAccount(connection, tokenVault, 'finalized', tokenProgram)).amount,
    native: (await getAccount(connection, native, 'finalized')).amount };
  fs.writeFileSync(path.join(profile, 'support.json'), JSON.stringify({ genesisHash, expiresAtMs: Date.now() + 600000, snapshotSlot: snapshot.context.slot, accountHashes: hashes,
    input: { scopeId: 'validator-wallet', key: 'support', walletPublicKey: wallet.publicKey.toBase58(), poolId, nftMint: nft.publicKey.toBase58(),
      depositLamports: '10000000', tickLower, tickUpper, requestId: 'validator-support', nft2022, lookupTables: [] } }));
  proxy = http.createServer(async (req, res) => {
    try {
      rpcRequests++; const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks));
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const reply = await response.json();
      if (body.method === 'getSignatureStatuses' && laggingSignature && body.params[0][0] === laggingSignature) {
        assert.ok(reply.result.value[0]); reply.result.value[0] = null; laggingSignature = null;
      }
      if (body.method === 'sendTransaction' && reply.error?.data?.err === 'AlreadyProcessed') { duplicates++; assert.ok([...accepted.values()].includes(body.params[0])); }
      if (body.method === 'sendTransaction' && reply.result) {
        if (accepted.has(reply.result)) assert.equal(accepted.get(reply.result), body.params[0]); accepted.set(reply.result, body.params[0]);
        const store = openRuntimeStore(profile);
        try {
          const job = store.collection('runtime-support-positions/v1').load()[0], operation = store.getActiveOperation(wallet.publicKey.toBase58()), signed = store.getTransactions(operation.id).at(-1);
          assert.equal(store.getWalletWorkflow(wallet.publicKey.toBase58()).id, job.id); assert.equal(job.state, 'approved');
          assert.equal(signed.wire, body.params[0]); assert.equal(signed.signature, reply.result); assert.ok(store.getOperationApprovals(operation.id).length);
          if (!crashed) { crashed = true; activeChild.kill('SIGKILL'); }
        } finally { store.close(); }
      }
      res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply));
    } catch (error) { rpcErrors.push(error); res.writeHead(500); res.end(error.message); }
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const run = () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../packages/runtime/test/fixtures/support-position-localnet-worker.mjs', import.meta.url)), profile, `http://127.0.0.1:${proxy.address().port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); activeChild = child; let out = '', err = ''; child.stdout.on('data', (chunk) => { out += chunk; }); child.stderr.on('data', (chunk) => { err += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000); child.once('close', () => clearTimeout(timer)); return { child, output: () => ({ out, err }) };
  };
  const first = run(), [code, signal] = await once(first.child, 'close'); assert.equal(code, null, first.output().err); assert.equal(signal, 'SIGKILL'); assert.equal(crashed, true);
  const signature = [...accepted.keys()].at(-1); await finalized(signature, 'accepted support'); laggingSignature = signature;
  const second = run(), [recoveredCode] = await once(second.child, 'close'); assert.equal(recoveredCode, 0, second.output().err); const result = JSON.parse(second.output().out), count = rpcRequests;
  const third = run(), [cachedCode] = await once(third.child, 'close'); assert.equal(cachedCode, 0, third.output().err); assert.deepEqual(JSON.parse(third.output().out), result); assert.equal(rpcRequests, count);
  assert.deepEqual(rpcErrors, []); assert.equal(accepted.size, 1); assert.equal(duplicates, 1); assert.equal(result.status, 'confirmed'); assert.equal(result.txId, signature);
  const position = PositionInfoLayout.decode((await connection.getAccountInfo(positionAddress, 'finalized')).data);
  assert.equal(position.poolId.toBase58(), poolId); assert.equal(position.nftMint.toBase58(), nft.publicKey.toBase58());
  assert.equal(position.liquidity.toString(), result.liquidity); assert.equal(position.tickLower, tickLower); assert.equal(position.tickUpper, tickUpper);
  const held = await getAccount(connection, nftAccount, 'finalized', nftProgram), positionMint = await getMint(connection, nft.publicKey, 'finalized', nftProgram);
  assert.equal(held.owner.toBase58(), wallet.publicKey.toBase58()); assert.equal(held.amount, 1n); assert.equal(positionMint.supply, 1n); assert.equal(positionMint.mintAuthority, null);
  assert.equal((await getAccount(connection, output, 'finalized', tokenProgram)).amount, before.token);
  assert.equal((await getAccount(connection, tokenVault, 'finalized', tokenProgram)).amount, before.vault);
  assert.equal((await getAccount(connection, native, 'finalized')).amount, before.native);
  assert.equal(before.wallet - await connection.getBalance(wallet.publicKey, 'finalized'), result.spentLamports);
  assert.equal(PoolInfoLayout.decode((await connection.getAccountInfo(pool.address.poolId, 'finalized')).data).liquidity.toString(), '0');
  process.stdout.write(JSON.stringify({ status: 'passed', mode, snapshotSlot: snapshot.context.slot, poolId, finalizedTransactions: accepted.size,
    duplicateReplies: duplicates, cachedRpcRequests: rpcRequests - count, txId: result.txId, depositedRaw: result.depositedRaw, liquidity: result.liquidity, feeLamports: result.feeLamports, rentLamports: result.rentLamports,
    returnedLamports: result.returnedLamports, spentLamports: result.spentLamports, accountHashes: hashes }) + '\n'); passed = true;
} catch (error) {
  process.stderr.write(`Support evidence retained at ${profile}\n${fs.readFileSync(logFile, 'utf8').slice(-5000)}\n`);
  if (connection) for (const signature of accepted.keys()) {
    try { process.stderr.write(JSON.stringify(await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })) + '\n'); }
    catch { /* Preserve the original failure. */ }
  }
  throw error;
} finally {
  for (const child of children) await stop(child);
  if (proxy) { proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); }
  await stop(validator); fs.closeSync(log); if (passed) fs.rmSync(profile, { recursive: true, force: true });
}
