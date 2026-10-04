// A private local validator verifies closing empty token accounts: real classic and Token-2022
// accounts, a real signed close, and the finalized receipt the operation checks.
// Run: npm run test:e2e:runtime-close:localnet
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
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createMint, getOrCreateAssociatedTokenAccount, mintTo,
} from '@solana/spl-token';
import { acquireProfileOwner } from '../../packages/runtime/src/owner.js';
import { openRuntimeStore } from '../../packages/runtime/src/store.js';
import { createSolanaSigner } from '../../packages/runtime/src/solana.js';
import { createTokenAccountCloseService, closableTokenAccount } from '../../packages/runtime/src/token-account-close.js';
import { createSolSweepService } from '../../packages/runtime/src/sol-sweep.js';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-validator-close-'));
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
  const funding = await connection.requestAirdrop(wallet.publicKey, 1_000_000_000);
  await waitFor(async () => (await connection.getSignatureStatuses([funding], { searchTransactionHistory: true })).value[0]?.confirmationStatus === 'finalized', 'funding');

  // Real token accounts: two empty (classic and Token-2022) and one holding tokens.
  const confirmed = { commitment: 'finalized' };
  const classicMint = await createMint(connection, wallet, wallet.publicKey, null, 6, undefined, confirmed, TOKEN_PROGRAM_ID);
  const token2022Mint = await createMint(connection, wallet, wallet.publicKey, null, 9, undefined, confirmed, TOKEN_2022_PROGRAM_ID);
  const heldMint = await createMint(connection, wallet, wallet.publicKey, null, 0, undefined, confirmed, TOKEN_PROGRAM_ID);
  const emptyClassic = await getOrCreateAssociatedTokenAccount(connection, wallet, classicMint, wallet.publicKey, false, 'finalized', confirmed, TOKEN_PROGRAM_ID);
  const emptyToken2022 = await getOrCreateAssociatedTokenAccount(connection, wallet, token2022Mint, wallet.publicKey, false, 'finalized', confirmed, TOKEN_2022_PROGRAM_ID);
  const held = await getOrCreateAssociatedTokenAccount(connection, wallet, heldMint, wallet.publicKey, false, 'finalized', confirmed, TOKEN_PROGRAM_ID);
  await mintTo(connection, wallet, heldMint, held.address, wallet, 3, [], confirmed, TOKEN_PROGRAM_ID);
  process.stdout.write('Created two empty token accounts and one holding tokens.\n');

  // The same selection the wallet runtime makes: every account the wallet could close by itself.
  const found = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    for (const { pubkey, account } of (await connection.getTokenAccountsByOwner(wallet.publicKey, { programId }, 'finalized')).value) {
      const row = closableTokenAccount(pubkey.toBase58(), account, walletPublicKey);
      if (row) found.push(row);
    }
  }
  assert.deepEqual(found.map((row) => row.address).sort(), [emptyClassic.address.toBase58(), emptyToken2022.address.toBase58()].sort());
  const rent = found.reduce((sum, row) => sum + row.lamports, 0);

  owner = acquireProfileOwner(profile);
  const store = openRuntimeStore(profile);
  const service = createTokenAccountCloseService({ owner, store, connection, network: 'localnet', expectedGenesisHash: genesisHash,
    signer: createSolanaSigner({ getSigners: async () => [wallet] }), authorize: async () => true,
    feePolicy: async ({ accountCount }) => ({ computeUnitLimit: 20_000 + 5_000 * accountCount, microLamports: 1000, feeCeilingLamports: 50_000 }), timeoutMs: 90_000 });
  const accounts = found.map((row) => row.address);
  const approval = { id: 'localnet-close', walletPublicKey, network: 'localnet', genesisHash, expiresAtMs: Date.now() + 300_000, maxSpendLamports: 1_000_000_000, close: { accounts: [...accounts].sort() } };
  const before = await connection.getBalance(wallet.publicKey, 'finalized');
  const result = await service.close({ scopeId: 'localnet-journal', walletPublicKey, accounts, approval });
  const after = await connection.getBalance(wallet.publicKey, 'finalized');
  const fee = store.getOperation(result.operationId).evidence.chain.feeLamports;
  assert.equal(result.reclaimedLamports, rent);
  assert.equal(after - before, rent - fee, 'the wallet gains the rent minus the fee');
  for (const address of accounts) assert.equal(await connection.getAccountInfo(new PublicKey(address), 'finalized'), null, `${address} is closed`);
  assert.ok(await connection.getAccountInfo(held.address, 'finalized'), 'the account holding tokens stays');
  assert.deepEqual(await service.close({ scopeId: 'localnet-journal', walletPublicKey, accounts, approval }), result, 'a finished close is not sent again');
  process.stdout.write(`Closed ${accounts.length} empty token accounts on a local validator: ${rent} lamports of rent returned, fee ${fee}.\n`);

  // The SOL sweep then drains the launch wallet to exactly zero: nothing is reserved.
  const destination = Keypair.generate().publicKey.toBase58();
  const sweep = createSolSweepService({ owner, store, connection, network: 'localnet', expectedGenesisHash: genesisHash,
    signer: createSolanaSigner({ getSigners: async () => [wallet] }), authorize: async () => true,
    feePolicy: async () => ({ reserveLamports: 0, feeCeilingLamports: 50_000, microLamports: 1000, computeUnitLimit: 20_000 }), timeoutMs: 90_000 });
  const beforeSweep = await connection.getBalance(wallet.publicKey, 'finalized');
  const swept = await sweep.sweep({ scopeId: 'localnet-journal', walletPublicKey, destinationWallet: destination,
    approval: { id: 'localnet-sweep', walletPublicKey, destinationWallet: destination, network: 'localnet', genesisHash, expiresAtMs: Date.now() + 300_000, maxSpendLamports: beforeSweep } });
  const sweepFee = store.getOperation(swept.operationId).evidence.chain.feeLamports;
  assert.equal(await connection.getBalance(wallet.publicKey, 'finalized'), 0, 'the launch wallet is drained to zero');
  assert.equal(await connection.getAccountInfo(wallet.publicKey, 'finalized'), null, 'its system account is gone');
  assert.equal(await connection.getBalance(new PublicKey(destination), 'finalized'), beforeSweep - sweepFee);
  store.close();
  process.stdout.write(`Drained the launch wallet: ${beforeSweep - sweepFee} lamports sent, fee ${sweepFee}, 0 left.\n`);
} finally {
  owner?.release();
  if (validator && validator.exitCode === null) { const closed = once(validator, 'close'); validator.kill('SIGTERM'); const force = setTimeout(() => validator.kill('SIGKILL'), 5000); await closed; clearTimeout(force); }
  fs.closeSync(log);
  fs.rmSync(profile, { recursive: true, force: true });
}
