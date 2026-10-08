// A private local validator verifies batched airdrop transfers: real Token-2022 and classic mints,
// recipients with and without token accounts, several recipients per signed transaction, and the
// finalized receipt each batch checks.
// Run: npm run test:e2e:runtime-airdrop-batch:localnet
// Requires solana-test-validator on PATH. All keys and funds are test fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createMint, getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, mintTo,
} from '@solana/spl-token';
import { acquireProfileOwner } from '../../packages/runtime/src/owner.js';
import { openRuntimeStore } from '../../packages/runtime/src/store.js';
import { createSolanaSigner } from '../../packages/runtime/src/solana.js';
import { createTokenTransferBatchService, TOKEN_TRANSFER_BATCH_MAX } from '../../packages/runtime/src/token-transfer-batch.js';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-validator-airdrop-batch-'));
const log = fs.openSync(path.join(profile, 'validator.log'), 'a', 0o600);
let validator, owner;
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
    const first = net.createServer(), second = net.createServer();
    try {
      first.listen(0, '127.0.0.1'); await once(first, 'listening');
      const port = first.address().port;
      second.listen(port + 1, '127.0.0.1'); await once(second, 'listening');
      return port;
    } catch { /* another pair */ } finally { await Promise.all([first, second].map((server) => new Promise((resolve) => server.close(resolve)))); }
  }
  throw new Error('Choose free local validator ports');
};
const groups = (rows, size) => Array.from({ length: Math.ceil(rows.length / size) }, (_, index) => rows.slice(index * size, (index + 1) * size));

try {
  const port = await freePort();
  // The validator's websocket is the RPC port + 1; the faucet must not take it.
  let faucetPort = await freePort();
  while (Math.abs(faucetPort - port) < 3) faucetPort = await freePort();
  validator = spawn('solana-test-validator', ['--quiet', '--ledger', path.join(profile, 'ledger'), '--bind-address', '127.0.0.1',
    '--rpc-port', String(port), '--faucet-port', String(faucetPort), '--mint', Keypair.fromSeed(new Uint8Array(32).fill(99)).publicKey.toBase58()], { stdio: ['ignore', log, log] });
  await once(validator, 'spawn');
  const connection = new Connection(`http://127.0.0.1:${port}`, { commitment: 'finalized', wsEndpoint: `ws://127.0.0.1:${port + 1}` });
  await waitFor(() => connection.getVersion(), 'validator startup');
  const genesisHash = await connection.getGenesisHash();

  const wallet = Keypair.generate(), walletPublicKey = wallet.publicKey.toBase58();
  const funding = await connection.requestAirdrop(wallet.publicKey, 2_000_000_000);
  await waitFor(async () => (await connection.getSignatureStatuses([funding], { searchTransactionHistory: true })).value[0]?.confirmationStatus === 'finalized', 'funding');

  owner = acquireProfileOwner(profile);
  const store = openRuntimeStore(profile);
  const service = createTokenTransferBatchService({ owner, store, connection, network: 'localnet', expectedGenesisHash: genesisHash,
    signer: createSolanaSigner({ getSigners: async () => [wallet] }), authorize: async () => true,
    feePolicy: async ({ recipientCount }) => ({ computeUnitLimit: Math.min(1_400_000, 40_000 * recipientCount), microLamports: 1000, feeCeilingLamports: 100_000 }), timeoutMs: 90_000 });
  const confirmed = { commitment: 'finalized' };

  for (const { label, programId, decimals, count, existing } of [
    { label: 'Token-2022', programId: TOKEN_2022_PROGRAM_ID, decimals: 9, count: 12, existing: 4 },
    { label: 'classic SPL', programId: TOKEN_PROGRAM_ID, decimals: 6, count: 7, existing: 2 },
  ]) {
    const mint = await createMint(connection, wallet, wallet.publicKey, null, decimals, undefined, confirmed, programId);
    const source = await getOrCreateAssociatedTokenAccount(connection, wallet, mint, wallet.publicKey, false, 'finalized', confirmed, programId);
    await mintTo(connection, wallet, mint, source.address, wallet, 10n ** BigInt(decimals + 6), [], confirmed, programId);
    // Some recipients already hold an account for the coin; the batch creates the rest.
    const recipients = Array.from({ length: count }, (_, index) => ({ destinationWallet: Keypair.generate().publicKey.toBase58(), amountRaw: String(1_000_000n + BigInt(index)) }));
    for (const row of recipients.slice(0, existing)) {
      await getOrCreateAssociatedTokenAccount(connection, wallet, mint, new PublicKey(row.destinationWallet), false, 'finalized', confirmed, programId);
    }

    const intent = { mint: mint.toBase58(), programId: programId.toBase58(), sourceTokenAccount: source.address.toBase58(), decimals };
    const results = [];
    for (const group of groups(recipients, TOKEN_TRANSFER_BATCH_MAX)) {
      const action = { key: `airdrop-batch/${label}/${group[0].destinationWallet}`, context: { recipients: group } };
      const approval = { id: `localnet-${action.key}`, walletPublicKey, scopeId: 'localnet-journal', action, network: 'localnet', genesisHash,
        expiresAtMs: Date.now() + 300_000, maxSpendLamports: 1_000_000_000, batch: { ...intent, recipients: group } };
      const input = { scopeId: 'localnet-journal', walletPublicKey, ...intent, recipients: group, action, approval };
      const result = await service.transferBatch(input);
      assert.deepEqual(await service.transferBatch(input), result, 'a finished batch is not sent again');
      results.push(result);
    }
    assert.equal(new Set(results.map((result) => result.txId)).size, Math.ceil(count / TOKEN_TRANSFER_BATCH_MAX), 'one transaction per group');
    for (const row of recipients) {
      const account = getAssociatedTokenAddressSync(mint, new PublicKey(row.destinationWallet), false, programId);
      const balance = await connection.getTokenAccountBalance(account, 'finalized');
      assert.equal(balance.value.amount, row.amountRaw, `${row.destinationWallet} received its exact amount`);
    }
    const evidence = results.flatMap((result) => store.getOperation(result.operationId).evidence.chain.recipients);
    assert.deepEqual(evidence.map((row) => [row.destinationWallet, row.amountRaw, row.receivedRaw]), recipients.map((row) => [row.destinationWallet, row.amountRaw, row.amountRaw]));
    const sourceLeft = (await connection.getTokenAccountBalance(source.address, 'finalized')).value.amount;
    assert.equal(BigInt(sourceLeft), 10n ** BigInt(decimals + 6) - recipients.reduce((sum, row) => sum + BigInt(row.amountRaw), 0n), 'the source is debited the exact total');
    const fees = results.reduce((sum, result) => sum + store.getOperation(result.operationId).evidence.chain.feeLamports, 0);
    const rent = results.reduce((sum, result) => sum + store.getOperation(result.operationId).evidence.chain.rentLamports, 0);
    process.stdout.write(`${label}: ${count} recipients (${count - existing} new accounts) in ${results.length} transactions, fees ${fees}, rent ${rent} lamports.\n`);
  }
  store.close();
} finally {
  owner?.release();
  if (validator && validator.exitCode === null) { const closed = once(validator, 'close'); validator.kill('SIGTERM'); const force = setTimeout(() => validator.kill('SIGKILL'), 5000); await closed; clearTimeout(force); }
  fs.closeSync(log);
  fs.rmSync(profile, { recursive: true, force: true });
}
