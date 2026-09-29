// Qualify the real Raydium router with copied public pool accounts on a private
// validator. The fixture wallet receives local test SOL. Public RPC is read-only.
// Run: npm run test:e2e:runtime-swap:localnet (requires solana-test-validator).
// Default: host-built SPL setup and cleanup. --provider-bundle keeps the full
// Trade API bundle. --funded-source also seeds an existing wrapped-SOL balance.
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
import { AddressLookupTableAccount, Connection, Keypair, PublicKey, SystemProgram, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount,
  createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, createCloseAccountInstruction } from '@solana/spl-token';
import { openRuntimeStore } from '../../packages/runtime/src/store.js';
import { reviewSwapBundle } from '../../packages/runtime/src/swap-bundle.js';
import { USDT_MINT } from '../../packages/core/src/lp-constants.js';
import { SOLANA_GENESIS_HASHES } from '../../packages/runtime/src/solana.js';
import { SWAP_PROGRAMS, readSwapInstruction } from '../../packages/runtime/src/swap-instruction.js';

const sourceRpc = 'https://api.mainnet-beta.solana.com';
const tradeApi = 'https://transaction-v1.raydium.io';
const outputMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const wallet = Keypair.fromSeed(new Uint8Array(32).fill(43)).publicKey;
const source = getAssociatedTokenAddressSync(NATIVE_MINT, wallet), destination = getAssociatedTokenAddressSync(outputMint, wallet);
const inputAmountRaw = '10000000', slippageBps = 500, feeCeilingLamports = 10000;
const providerBundle = process.argv.includes('--provider-bundle'), fundedSource = process.argv.includes('--funded-source'), viaUsdt = process.argv.includes('--via-usdt');
const existingIntermediate = process.argv.includes('--existing-intermediate'), prefundedIntermediate = process.argv.includes('--prefunded-intermediate');
assert.ok(!(existingIntermediate && prefundedIntermediate), 'Choose one intermediate-account starting state');
assert.ok(!(fundedSource || viaUsdt || existingIntermediate || prefundedIntermediate) || providerBundle, 'Use the provider bundle for the account and route cases');
const mode = providerBundle ? `api${viaUsdt ? '-via-usdt' : ''}${fundedSource ? '-funded' : ''}${existingIntermediate ? '-existing-route' : ''}${prefundedIntermediate ? '-prefunded-route' : ''}` : 'host';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-validator-swap-'));
const accountDir = path.join(profile, 'accounts'); fs.mkdirSync(accountDir);
const children = [], rpcErrors = [], accepted = new Map();
let validator, directConnection, proxy, activeChild, crashIndex = null, laggingSignature = null, duplicateReplies = 0, rpcRequests = 0;
const logFile = path.join(profile, 'validator.log'), log = fs.openSync(logFile, 'a', 0o600);
const waitFor = async (check, label, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    if (validator?.exitCode !== null && validator?.exitCode !== undefined) throw new Error(`Validator exited while waiting for ${label}`);
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError?.message || 'pending'}`);
};
const freePort = async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const a = net.createServer(), b = net.createServer();
    try {
      a.listen(0, '127.0.0.1'); await once(a, 'listening'); const port = a.address().port;
      b.listen(port + 1, '127.0.0.1'); await once(b, 'listening'); return port;
    } catch { /* Choose another free RPC and websocket pair. */ }
    finally { await Promise.all([a, b].map((s) => new Promise((resolve) => s.close(resolve)))); }
  }
  throw new Error('Choose free validator ports');
};
const stop = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close'), force = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.kill('SIGTERM'); try { await closed; } finally { clearTimeout(force); }
};
const json = async (url, options = {}) => {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Public fixture read returned HTTP ${response.status}`);
  // Solana rentEpoch can be u64::MAX. Preserve its exact JSON integer.
  return JSON.parse(await response.text(), (key, value, context) => key === 'rentEpoch' ? BigInt(context.source) : value);
};
const publicRead = async (method, params = []) => {
  assert.ok(['getGenesisHash', 'getMultipleAccounts'].includes(method));
  const reply = await json(sourceRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (reply.error) throw new Error(JSON.stringify(reply.error)); return reply.result;
};
try {
  assert.equal(await publicRead('getGenesisHash'), SOLANA_GENESIS_HASHES.mainnet);
  const fetchQuote = async (inputMint, outputMint, amount) => {
    const quoteUrl = new URL(`${tradeApi}/compute/swap-base-in`);
    for (const [name, value] of Object.entries({ inputMint, outputMint, amount, slippageBps, txVersion: 'V0' })) quoteUrl.searchParams.set(name, String(value));
    const quote = await json(quoteUrl); assert.equal(quote.success, true, JSON.stringify(quote)); return quote;
  };
  let quote;
  if (viaUsdt) {
    // Join two live quote legs to require an intermediate account. The Trade
    // API builds the full router bundle; its saved input and minimum stay fixed.
    const first = await fetchQuote(NATIVE_MINT.toBase58(), USDT_MINT, inputAmountRaw);
    const second = await fetchQuote(USDT_MINT, outputMint.toBase58(), first.data.outputAmount);
    quote = { ...first, data: { ...first.data, outputMint: outputMint.toBase58(), outputAmount: second.data.outputAmount,
      otherAmountThreshold: second.data.otherAmountThreshold, routePlan: [...first.data.routePlan, ...second.data.routePlan] } };
  } else quote = await fetchQuote(NATIVE_MINT.toBase58(), outputMint.toBase58(), inputAmountRaw);
  assert.equal(quote.data.inputAmount, inputAmountRaw); assert.equal(quote.data.inputMint, NATIVE_MINT.toBase58()); assert.equal(quote.data.outputMint, outputMint.toBase58());
  assert.ok(quote.data.routePlan.length > 0 && quote.data.routePlan.length <= 4, 'Use a bounded SOL/USDC route');
  const intermediate = [...new Set(quote.data.routePlan.flatMap((hop) => [hop.inputMint, hop.outputMint]))].filter((mint) => ![NATIVE_MINT.toBase58(), outputMint.toBase58()].includes(mint));
  const intermediateRead = intermediate.length ? await publicRead('getMultipleAccounts', [intermediate, { encoding: 'base64', commitment: 'finalized' }]) : { value: [] };
  const intermediateMints = intermediate.map((mint, index) => ({ mint, programId: intermediateRead.value[index].owner }));
  const intermediateAccounts = intermediateMints.map(({ mint, programId }) => getAssociatedTokenAddressSync(new PublicKey(mint), wallet, false, new PublicKey(programId)));
  const built = await json(`${tradeApi}/transaction/swap-base-in`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ computeUnitPriceMicroLamports: '1000', swapResponse: quote, wallet: wallet.toBase58(), txVersion: 'V0', wrapSol: true, unwrapSol: false }) });
  assert.equal(built.success, true, JSON.stringify(built));
  const providerTxs = built.data.map((row) => VersionedTransaction.deserialize(Buffer.from(row.transaction, 'base64')));
  const tableKeys = [...new Set(providerTxs.flatMap((tx) => tx.message.addressTableLookups.map((lookup) => lookup.accountKey.toBase58())))];
  const tableRead = tableKeys.length ? await publicRead('getMultipleAccounts', [tableKeys, { encoding: 'base64', commitment: 'finalized' }]) : { context: { slot: 0 }, value: [] };
  const tables = tableRead.value.map((account, i) => new AddressLookupTableAccount({ key: new PublicKey(tableKeys[i]), state: AddressLookupTableAccount.deserialize(Buffer.from(account.data[0], 'base64')) }));
  const instructions = providerTxs.flatMap((tx) => TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables }).instructions);
  const trades = instructions.filter((ix) => ix.programId.toBase58() === SWAP_PROGRAMS.raydium && ix.data[0] === 0);
  assert.equal(trades.length, 1); const trade = trades[0], decoded = readSwapInstruction(trade, { network: 'localnet' });
  assert.equal(decoded.sourceTokenAccount, source.toBase58()); assert.equal(decoded.destinationTokenAccount, destination.toBase58());
  assert.equal(decoded.inputAmountRaw, inputAmountRaw); assert.ok(BigInt(decoded.minimumOutputRaw) >= BigInt(quote.data.otherAmountThreshold));
  const makeTx = (ixs) => new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message(tables));
  const setup = [createAssociatedTokenAccountIdempotentInstruction(wallet, source, wallet, NATIVE_MINT),
    createAssociatedTokenAccountIdempotentInstruction(wallet, destination, wallet, outputMint),
    ...intermediateMints.map(({ mint, programId }, i) => createAssociatedTokenAccountIdempotentInstruction(wallet, intermediateAccounts[i], wallet, new PublicKey(mint), new PublicKey(programId))),
    SystemProgram.transfer({ fromPubkey: wallet, toPubkey: source, lamports: Number(inputAmountRaw) }), createSyncNativeInstruction(source)];
  const transactions = providerBundle ? providerTxs : [makeTx(setup), makeTx([ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }), trade]), makeTx([createCloseAccountInstruction(source, wallet, wallet)])];
  const intent = { network: 'localnet', walletPublicKey: wallet.toBase58(), sourceTokenAccount: source.toBase58(), destinationTokenAccount: destination.toBase58(),
    outputMint: outputMint.toBase58(), outputProgramId: TOKEN_PROGRAM_ID.toBase58(), inputAmountRaw, minimumOutputRaw: decoded.minimumOutputRaw, maxSlippageBps: slippageBps, intermediateMints, rentCeilingLamports: 5000000 + intermediateMints.length * 3000000 };
  const review = await reviewSwapBundle({ transactions, lookupTables: tables, intent });
  const builtins = new Set([SystemProgram.programId, ComputeBudgetProgram.programId, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')].map((key) => key.toBase58()));
  const excluded = new Set([wallet, source, destination, ...intermediateAccounts].map((key) => key.toBase58()));
  const addresses = [...new Set([...review.steps.flatMap((step) => step.accountKeys), ...tableKeys])].filter((address) => !builtins.has(address) && !excluded.has(address) && !address.startsWith('Sysvar'));
  const snapshot = await publicRead('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'finalized', minContextSlot: tableRead.context.slot }]);
  const programData = [], hashes = {};
  const saveAccount = (address, account) => {
    if (!account) return;
    fs.writeFileSync(path.join(accountDir, `${address}.json`), JSON.stringify({ pubkey: address, account }, (_, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value));
    if (account.executable && account.owner === 'BPFLoaderUpgradeab1e11111111111111111111111') {
      const data = Buffer.from(account.data[0], 'base64'); assert.equal(data.readUInt32LE(0), 2); programData.push(new PublicKey(data.subarray(4, 36)).toBase58());
    }
    hashes[address] = createHash('sha256').update(Buffer.from(account.data[0], 'base64')).digest('hex');
  };
  addresses.forEach((address, i) => saveAccount(address, snapshot.value[i]));
  const programSnapshot = programData.length ? await publicRead('getMultipleAccounts', [programData, { encoding: 'base64', commitment: 'finalized', minContextSlot: snapshot.context.slot }]) : snapshot;
  programData.forEach((address, i) => { assert.ok(programSnapshot.value[i]); saveAccount(address, programSnapshot.value[i]); });
  process.stdout.write(`Copied public route accounts at slot ${snapshot.context.slot}; ${Object.keys(hashes).length} account hashes recorded.\n`);
  const port = await freePort(), faucetPort = await freePort(), url = `http://127.0.0.1:${port}`;
  validator = spawn('solana-test-validator', ['--quiet', '--ledger', path.join(profile, 'ledger'), '--bind-address', '127.0.0.1', '--rpc-port', String(port),
    '--faucet-port', String(faucetPort), '--mint', Keypair.fromSeed(new Uint8Array(32).fill(99)).publicKey.toBase58(), '--account-dir', accountDir,
    '--warp-slot', String(programSnapshot.context.slot + 10)], { stdio: ['ignore', log, log] });
  await once(validator, 'spawn'); const connection = new Connection(url, 'finalized'); directConnection = connection;
  await waitFor(() => connection.getVersion(), 'private validator startup');
  const genesisHash = await connection.getGenesisHash(), funding = await connection.requestAirdrop(wallet, 1000000000);
  await waitFor(async () => (await connection.getSignatureStatuses([funding], { searchTransactionHistory: true })).value[0]?.confirmationStatus === 'finalized', 'local fixture funding');
  assert.equal(await connection.getBalance(wallet, 'finalized'), 1000000000);
  if (fundedSource || existingIntermediate || prefundedIntermediate) {
    const seeded = fundedSource ? [createAssociatedTokenAccountIdempotentInstruction(wallet, source, wallet, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: wallet, toPubkey: source, lamports: 1000000 }), createSyncNativeInstruction(source)] : [];
    if (existingIntermediate || prefundedIntermediate) {
      assert.ok(intermediateMints.length, 'Use a route with intermediate token accounts');
      for (const [index, { mint, programId }] of intermediateMints.entries()) seeded.push(prefundedIntermediate
        ? SystemProgram.transfer({ fromPubkey: wallet, toPubkey: intermediateAccounts[index], lamports: 100000000 })
        : createAssociatedTokenAccountIdempotentInstruction(wallet, intermediateAccounts[index], wallet, new PublicKey(mint), new PublicKey(programId)));
    }
    const seed = makeTx(seeded);
    seed.message.recentBlockhash = (await connection.getLatestBlockhash('finalized')).blockhash;
    seed.sign([Keypair.fromSeed(new Uint8Array(32).fill(43))]);
    const signature = await connection.sendRawTransaction(seed.serialize(), { preflightCommitment: 'finalized' });
    await waitFor(async () => (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]?.confirmationStatus === 'finalized', 'existing local wrapped SOL');
    if (fundedSource) assert.equal((await getAccount(connection, source, 'finalized')).amount, 1000000n);
  }
  const startingBalance = await connection.getBalance(wallet, 'finalized');
  const approval = { id: 'validator-swap', scopeId: 'validator-launch', key: 'purchase/0', walletPublicKey: wallet.toBase58(), network: 'localnet', genesisHash,
    bundleDigest: review.digest, expiresAtMs: Date.now() + 600000, maxSpendLamports: Number(inputAmountRaw) + intent.rentCeilingLamports + transactions.length * feeCeilingLamports };
  fs.writeFileSync(path.join(profile, 'swap.json'), JSON.stringify({ genesisHash, transactions: transactions.map((tx) => Buffer.from(tx.serialize()).toString('base64')),
    lookupTables: tableKeys, intent, feeCeilingLamports, approval, snapshotSlot: snapshot.context.slot, accountHashes: hashes }));
  proxy = http.createServer(async (req, res) => {
    try {
      rpcRequests++; const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks));
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const reply = await response.json();
      // Hide one known status after each crash to reproduce a lagging RPC.
      // The real validator then answers the exact-byte resend as processed.
      if (body.method === 'getSignatureStatuses' && laggingSignature && body.params[0][0] === laggingSignature) {
        assert.ok(reply.result.value[0]); reply.result.value[0] = null; laggingSignature = null;
      }
      if (body.method === 'sendTransaction' && reply.error?.data?.err === 'AlreadyProcessed') {
        duplicateReplies++; assert.ok([...accepted.values()].includes(body.params[0]));
      }
      if (body.method === 'sendTransaction' && reply.result) {
        if (accepted.has(reply.result)) assert.equal(accepted.get(reply.result), body.params[0]); accepted.set(reply.result, body.params[0]);
        const store = openRuntimeStore(profile);
        try {
          const operation = store.getActiveOperation(wallet.toBase58()), signed = store.getTransactions(operation.id).at(-1);
          assert.equal(signed.wire, body.params[0]); assert.equal(signed.signature, reply.result); assert.ok(store.getOperationApprovals(operation.id).length);
          if (operation.payload.result.index === crashIndex) { crashIndex = null; activeChild.kill('SIGKILL'); }
        } finally { store.close(); }
      }
      res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply));
    } catch (error) { rpcErrors.push(error); res.writeHead(500); res.end(error.message); }
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const run = () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../packages/runtime/test/fixtures/swap-localnet-worker.mjs', import.meta.url)), profile,
      `http://127.0.0.1:${proxy.address().port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); activeChild = child; let out = '', err = '';
    child.stdout.on('data', (chunk) => { out += chunk; }); child.stderr.on('data', (chunk) => { err += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000); child.once('close', () => clearTimeout(timer));
    return { child, output: () => ({ out, err }) };
  };
  for (const [index] of transactions.entries()) {
    crashIndex = index; const worker = run(), [code, signal] = await once(worker.child, 'close');
    assert.equal(code, null, worker.output().err); assert.equal(signal, 'SIGKILL'); assert.equal(crashIndex, null);
    const signature = [...accepted.keys()].at(-1);
    await waitFor(async () => (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]?.confirmationStatus === 'finalized', 'accepted swap finality');
    laggingSignature = signature;
    process.stdout.write(`${review.steps[index].kind}: process killed after signed transaction acceptance.\n`);
  }
  const recovered = run(), [recoveredExit] = await once(recovered.child, 'close'); assert.equal(recoveredExit, 0, recovered.output().err);
  const result = JSON.parse(recovered.output().out), requestsBefore = rpcRequests;
  const replayed = run(), [replayedExit] = await once(replayed.child, 'close'); assert.equal(replayedExit, 0, replayed.output().err);
  assert.deepEqual(JSON.parse(replayed.output().out), result); assert.equal(rpcRequests, requestsBefore); assert.deepEqual(rpcErrors, []); assert.equal(accepted.size, transactions.length); assert.equal(duplicateReplies, transactions.length);
  const output = await getAccount(connection, destination, 'finalized'); assert.equal(output.amount.toString(), result.receivedRaw);
  assert.ok(output.amount >= BigInt(intent.minimumOutputRaw)); assert.equal(await connection.getAccountInfo(source, 'finalized'), null);
  assert.equal(startingBalance - await connection.getBalance(wallet, 'finalized'), result.grossDebitLamports - result.returnedLamports);
  for (const [index, account] of intermediateAccounts.entries()) {
    if (providerBundle && !existingIntermediate) assert.equal(await connection.getAccountInfo(account, 'finalized'), null);
    else assert.equal((await getAccount(connection, account, 'finalized', new PublicKey(intermediateMints[index].programId))).amount, 0n);
  }
  for (const signature of accepted.keys()) {
    const receipt = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }); assert.equal(receipt.meta.err, null);
  }
  process.stdout.write(JSON.stringify({ status: 'passed', provider: 'raydium', mode, pools: quote.data.routePlan.map((hop) => hop.poolId), snapshotSlot: snapshot.context.slot,
    finalizedTransactions: accepted.size, duplicateReplies, receivedRaw: result.receivedRaw, feeLamports: result.feeLamports, returnedLamports: result.returnedLamports,
    accountHashes: hashes }) + '\n');
} catch (error) {
  process.stderr.write(fs.readFileSync(logFile, 'utf8').slice(-5000) + '\n');
  if (directConnection) for (const signature of accepted.keys()) {
    try {
      const receipt = await directConnection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
      process.stderr.write(JSON.stringify({ signature, receipt }) + '\n');
    } catch { /* Keep the original failure when its diagnostic read fails. */ }
  }
  throw error;
} finally {
  for (const child of children) await stop(child);
  if (proxy) { proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); }
  await stop(validator); fs.closeSync(log); fs.rmSync(profile, { recursive: true, force: true });
}
