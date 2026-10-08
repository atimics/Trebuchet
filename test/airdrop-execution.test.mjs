import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { acquireProfileOwner } from '../packages/runtime/src/owner.js';
import { openRuntimeStore } from '../packages/runtime/src/store.js';
import { SOLANA_GENESIS_HASHES } from '../packages/runtime/src/solana.js';
import { airdropChain, airdropContext, airdropInput, recipients, sweepWallet } from './fixtures/airdrop-chain.mjs';

const walletPublicKey = sweepWallet.publicKey.toBase58();
function fixture(t, options = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-airdrop-')), owner = acquireProfileOwner(profile), ledger = airdropChain(options.chain);
  const host = airdropContext({ owner, connection: ledger.connection, ...options });
  t.after(() => { owner.release(); fs.rmSync(profile, { recursive: true, force: true }); });
  return { profile, owner, ...ledger, ...host };
}

test('airdrop execution records the full plan and each signed payment before sending', async (t) => {
  const f = fixture(t);
  f.state.beforeSend = (transaction) => {
    const db = openRuntimeStore(f.profile);
    try {
      const operation = db.getActiveOperation(walletPublicKey), launch = db.getLaunch(operation.launchId);
      assert.equal(launch.config.action.context.purpose, 'airdrop');
      assert.equal(db.getTransactions(operation.id)[0].wire, transaction.wire);
      const approval = db.getOperationApprovals(operation.id)[0];
      assert.equal(approval.action.context.planDigest, launch.config.action.context.planDigest);
      assert.equal(approval.token.amountRaw, '2500000');
      const evidence = new DatabaseSync(path.join(f.profile, 'execution.sqlite'), { readOnly: true });
      try {
        const plans = evidence.prepare("SELECT body FROM launches WHERE json_extract(body, '$.purpose') = 'airdrop'").all();
        assert.equal(plans.length, 1);
        assert.equal(JSON.parse(plans[0].body).plan.recipients.length, 2);
        assert.equal(JSON.parse(plans[0].body).plan.totalRaw, '5000000');
      } finally { evidence.close(); }

    } finally { db.close(); }
  };
  const result = await f.runtime.execute(airdropInput);
  assert.equal(result.transferred.length, 2); assert.deepEqual(result.failed, []);
  assert.equal(f.state.sends.length, 2); assert.equal(f.state.sourceAmount, 0n);
  assert.ok(f.ledgers.every((ledger) => ledger.state.destinationAmount === 2500000n));
  const journal = f.journal.activeForWallet(walletPublicKey);
  assert.equal(journal.airdrop.transferred.length, 2);
  assert.equal(journal.events.filter((event) => event.stage === 'airdrop_recipient_done').length, 2);
  f.connection.getMultipleAccountsInfoAndContext = async () => { throw new Error('source closed'); };
  assert.deepEqual(await f.runtime.execute({ ...airdropInput, recipients: [...airdropInput.recipients].reverse() }), result);
  assert.equal(f.state.sends.length, 2);
});

test('a lost reply keeps later recipients pending until the original receipt is recovered', async (t) => {
  const f = fixture(t); f.state.afterSend = () => { throw new Error('reply lost'); };
  await assert.rejects(f.runtime.execute(airdropInput), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  assert.equal(f.state.sends.length, 1); assert.equal(f.runtime.canRecover(walletPublicKey), true);
  f.state.afterSend = null;
  const result = await f.runtime.execute(airdropInput);
  assert.equal(result.transferred.length, 2); assert.equal(f.state.sends.length, 2);
  assert.deepEqual(result.transferred.map((row) => row.txId).sort(), f.state.sends.map((tx) => tx.signature).sort());
});

test('a recipient balance from an earlier transfer keeps its own exact airdrop receipt', async (t) => {
  const f = fixture(t);
  f.ledgers[0].state.destinationExists = true; f.ledgers[0].state.destinationAmount = 5000000n; f.ledgers[0].state.destinationLamports = 2100000;
  await f.runtime.execute(airdropInput);
  assert.equal(f.ledgers[0].state.destinationAmount, 7500000n); assert.equal(f.state.sends.length, 2);
});

for (const [label, change] of Object.entries({ amount: { recipients: [{ wallet: recipients[0], tokens: '3' }] },
  recipient: { recipients: [{ wallet: Keypair.generate().publicKey.toBase58(), tokens: '2.5' }] },
  mint: { tokenMint: Keypair.generate().publicKey.toBase58() }, decimals: { tokenDecimals: 9 } })) {
  test(`the saved airdrop ${label} remains fixed across retries`, async (t) => {
    const f = fixture(t);
    f.runtime.prepare({ walletPublicKey, airdrop: airdropInput });
    await assert.rejects(f.runtime.execute({ ...airdropInput, ...change }), { code: 'EXECUTION_RECOVERY_REQUIRED' });
    assert.equal(f.state.sends.length, 0);
    assert.equal((await f.runtime.execute(airdropInput)).transferred.length, 2);
  });
}

// The plan the app sends and journals names the coin, its decimals and the recipients, and no token program.
const token2022 = TOKEN_2022_PROGRAM_ID.toBase58(), classic = TOKEN_PROGRAM_ID.toBase58();
const airdropPlans = (profile) => {
  const db = new DatabaseSync(path.join(profile, 'execution.sqlite'), { readOnly: true });
  try { return db.prepare("SELECT body FROM launches WHERE json_extract(body, '$.purpose') = 'airdrop' ORDER BY created_at, rowid").all().map((row) => JSON.parse(row.body).plan); }
  finally { db.close(); }
};

test('a Token-2022 launch airdrops with the token program saved with its coin', async (t) => {
  const f = fixture(t, { chain: { token2022: true } });
  f.journal.upsertForWallet(walletPublicKey, { token: { tokenProgram: token2022 } });
  f.connection.getAccountInfo = async () => { throw new Error('the saved program needs no chain read'); };
  assert.equal(f.runtime.prepare({ walletPublicKey }).programId, token2022);
  const result = await f.runtime.execute(airdropInput);
  assert.equal(result.transferred.length, 2); assert.equal(f.state.sends.length, 2);
  assert.deepEqual(airdropPlans(f.profile).map((plan) => plan.programId), [token2022]);
});

test('a launch without a saved token program reads it from the mint once', async (t) => {
  const f = fixture(t, { chain: { token2022: true } });
  let reads = 0; const read = f.connection.getAccountInfo;
  f.connection.getAccountInfo = async (...args) => { reads += 1; return read(...args); };
  assert.equal((await f.runtime.execute(airdropInput)).transferred.length, 2);
  const journal = f.journal.activeForWallet(walletPublicKey);
  assert.equal(journal.token.tokenProgram, token2022);
  assert.equal(journal.events.filter((event) => event.stage === 'token_program_read').length, 1);
  await f.runtime.execute(airdropInput);
  assert.equal(reads, 1); assert.equal(f.state.sends.length, 2);
});

test('a plan saved under the wrong token program is replaced before any payment', async (t) => {
  const f = fixture(t, { chain: { token2022: true } });
  assert.equal(f.runtime.prepare({ walletPublicKey }).programId, classic);
  const result = await f.runtime.execute(airdropInput);
  assert.equal(result.transferred.length, 2); assert.equal(f.state.sends.length, 2);
  assert.deepEqual(airdropPlans(f.profile).map((plan) => plan.programId), [classic, token2022]);
  const restored = f.runtime.prepare({ walletPublicKey });
  assert.equal(restored.programId, token2022); assert.equal(restored.isToken2022, true); assert.equal(restored.recipients.length, 2);
  assert.deepEqual(await f.runtime.execute(airdropInput), result);
  assert.equal(f.state.sends.length, 2);
});

test('a plan that already delivered keeps its token program', async (t) => {
  const f = fixture(t);
  f.runtime.prepare({ walletPublicKey });
  f.connection.getAccountInfo = async () => null;
  assert.equal((await f.runtime.execute({ ...airdropInput, recipients: airdropInput.recipients.slice(0, 1) })).transferred.length, 1);
  f.journal.upsertForWallet(walletPublicKey, { token: { tokenProgram: token2022 } });
  assert.equal(f.runtime.prepare({ walletPublicKey }).programId, classic);
  assert.equal((await f.runtime.execute(airdropInput)).transferred.length, 2);
  assert.deepEqual(airdropPlans(f.profile).map((plan) => plan.programId), [classic]);
});

test('a request cannot choose the token program', async (t) => {
  const f = fixture(t);
  f.runtime.prepare({ walletPublicKey, airdrop: airdropInput });
  const result = await f.runtime.execute({ ...airdropInput, isToken2022: true });
  assert.equal(result.transferred.length, 2); assert.equal(f.state.sends.length, 2);
  assert.deepEqual(airdropPlans(f.profile).map((plan) => plan.programId), [classic]);
});

test('an unreadable mint pauses the airdrop before a plan is saved', async (t) => {
  const f = fixture(t, { chain: { token2022: true } });
  f.connection.getAccountInfo = async () => { throw new Error('fetch failed'); };
  await assert.rejects(f.runtime.execute(airdropInput), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  assert.equal(f.state.sends.length, 0); assert.deepEqual(airdropPlans(f.profile), []);
});

test('a failed recipient checkpoint stops the next payment and replay restores it', async (t) => {
  let fail = true, f;
  f = fixture(t, { updateJournal: (...args) => {
    if (fail) throw Object.assign(new Error('journal commit failed'), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
    return f.journal.upsertForWallet(...args);
  } });
  f.journal.upsertForWallet(walletPublicKey, { token: { tokenProgram: classic } });
  await assert.rejects(f.runtime.execute(airdropInput), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  assert.equal(f.state.sends.length, 1); assert.equal(f.walletExecution.active(walletPublicKey), null);
  fail = false;
  const result = await f.runtime.execute(airdropInput);
  assert.equal(result.transferred.length, 2); assert.equal(f.state.sends.length, 2);
});

test('a request for one recipient keeps the full saved airdrop plan', async (t) => {
  const f = fixture(t);
  assert.equal((await f.runtime.execute({ ...airdropInput, recipients: airdropInput.recipients.slice(0, 1) })).transferred.length, 1);
  const restored = f.runtime.prepare({ walletPublicKey });
  assert.equal(restored.recipients.length, 2); assert.equal(restored.totalRaw, '5000000');
  assert.equal((await f.runtime.execute({ ...restored, tempWalletSecretKey: airdropInput.tempWalletSecretKey })).transferred.length, 2);
  assert.equal(f.state.sends.length, 2);
});

test('a direct airdrop request saves its complete plan before the first send', async (t) => {
  const f = fixture(t, { seedPlan: false });
  f.state.afterSend = () => { throw new Error('reply lost'); };
  await assert.rejects(f.runtime.execute(airdropInput), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  assert.equal(f.runtime.prepare({ walletPublicKey }).recipients.length, 2);
  assert.equal(f.state.sends.length, 1);
});

test('a mismatched recovery token preserves the pending airdrop', async (t) => {
  const f = fixture(t); f.state.status = 'confirmed';
  await assert.rejects(f.runtime.execute(airdropInput), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  const pending = f.walletExecution.active(walletPublicKey);
  await assert.rejects(f.runtime.recover({ ...airdropInput, tokenMint: Keypair.generate().publicKey.toBase58() }), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  assert.equal(f.walletExecution.active(walletPublicKey).id, pending.id); assert.equal(f.state.sends.length, 1);
});


test('airdrop process death after chain acceptance recovers each recipient with one payment', { timeout: 20_000 }, async (t) => {
  const { spawn } = await import('node:child_process'), { once } = await import('node:events');
  const { startAirdropRpc } = await import('./fixtures/airdrop-rpc.mjs');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-airdrop-process-')), ledger = airdropChain();
  let running, killed = false; const children = [];
  const rpc = await startAirdropRpc(ledger, { afterSend: (wire) => {
    const db = openRuntimeStore(profile);
    try { assert.equal(db.getTransactions(db.getActiveOperation(walletPublicKey).id)[0].wire, wire); } finally { db.close(); }
    if (!killed) { killed = true; running.kill('SIGKILL'); }
  } });
  t.after(async () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rpc.close(); fs.rmSync(profile, { recursive: true, force: true }); });
  const run = async () => {
    const child = spawn(process.execPath, [new URL('./fixtures/airdrop-execution-worker.mjs', import.meta.url).pathname, profile, rpc.url], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); running = child;
    let out = '', err = ''; child.stdout.on('data', (chunk) => { out += chunk; }); child.stderr.on('data', (chunk) => { err += chunk; });
    const [code, signal] = await once(child, 'close'); return { code, signal, out, err };
  };
  const first = await run(); assert.equal(first.signal, 'SIGKILL', first.err); assert.equal(ledger.state.sends.length, 1);
  const second = await run(); assert.equal(second.code, 0, second.err);
  const result = JSON.parse(second.out.split('RESULT:')[1]); assert.equal(result.transferred.length, 2);
  const third = await run(); assert.equal(third.code, 0, third.err);
  assert.deepEqual(JSON.parse(third.out.split('RESULT:')[1]), result);
  assert.equal(ledger.state.sends.length, 2); assert.deepEqual(rpc.errors, []);
});

for (const mode of ['durable', 'legacy']) {
test(`real ${mode} airdrop HTTP clients recover a saved payment and share wallet admission`, { timeout: 30_000 }, async (t) => {
  const { ensureRuntime } = await import('../packages/runtime/src/client.js');
  const { startAirdropRpc } = await import('./fixtures/airdrop-rpc.mjs');
  const f = fixture(t);
  if (mode === 'legacy') { await seedLegacyDelivery(f); f.state.status = 'confirmed'; }
  else f.state.afterSend = () => { throw new Error('reply lost'); };
  await assert.rejects(f.runtime.execute(airdropInput), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  f.state.afterSend = null; f.state.status = 'finalized'; f.owner.release();
  let entered, release, host;
  const enteredPromise = new Promise((resolve) => { entered = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  const rpc = await startAirdropRpc(f, { beforeStatus: async () => { entered(); await gate; } });
  fs.writeFileSync(path.join(f.profile, 'rpcConfig.json'), JSON.stringify({ active: rpc.url, activeNetwork: 'devnet', saved: [{ name: 'Local fixture', url: rpc.url, network: 'devnet' }] }));
  fs.writeFileSync(path.join(f.profile, 'userPrefs.json'), JSON.stringify({ demoMode: false }));
  t.after(async () => { release(); if (host) { try { process.kill(host.identity.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } } await rpc.close(); });
  host = await ensureRuntime(f.profile, { args: [new URL('../server.js', import.meta.url).pathname] });
  const pending = host.request('/api/run-airdrop', { method: 'POST', body: airdropInput });
  await Promise.race([enteredPromise, pending.then((result) => { throw new Error(`Airdrop ended before receipt recovery: ${JSON.stringify(result)}`); })]);
  await assert.rejects(host.request('/api/retry-airdrop', { method: 'POST', body: airdropInput }), { code: 'OP_IN_FLIGHT' });
  await assert.rejects(host.request('/api/create-token', { method: 'POST', body: { tempWalletSecretKey: airdropInput.tempWalletSecretKey, name: 'Air', symbol: 'AIR', totalSupply: '1' } }), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  release();
  const result = await pending; assert.equal(result.success, true); assert.equal(result.airdrop.transferred.length, 2);
  const again = await host.request('/api/retry-airdrop', { method: 'POST', body: airdropInput });
  assert.deepEqual(again.airdrop, result.airdrop); assert.equal(f.state.sends.length, 2);
  assert.deepEqual(rpc.errors, []);
  await host.request('/api/runtime/stop', { method: 'POST' });
});


}

async function seedLegacyDelivery(f) {
  const helpers = await import('../walletHelpers.js');
  f.connection.confirmTransaction = async () => ({ value: { err: null } });
  helpers.setConnectionFactoryForTests(() => f.connection);
  try {
    const result = await helpers.executeAirdrop({ ...airdropInput, recipients: airdropInput.recipients.slice(0, 1) });
    assert.equal(result.transferred.length, 1);
    f.journal.upsertForWallet(walletPublicKey, { airdrop: result });
    return result.transferred[0];
  } finally { helpers.setConnectionFactoryForTests(null); }
}

for (const destinationExists of [false, true]) {
test(`older airdrop journals gain verified receipts for ${destinationExists ? 'existing' : 'new'} destination accounts`, async (t) => {
  const f = fixture(t, { chain: { destinationExists } }), legacy = await seedLegacyDelivery(f);
  const result = await f.runtime.execute(airdropInput);
  assert.equal(result.transferred.length, 2); assert.equal(f.state.sends.length, 2);
  const observed = result.transferred.find((row) => row.wallet === legacy.wallet);
  assert.equal(observed.txId, legacy.txId); assert.ok(observed.verifiedReceiptId);
  const db = openRuntimeStore(f.profile);
  try {
    const op = db.getOperation(observed.verifiedReceiptId);
    assert.equal(op.kind, 'airdrop-observed-delivery'); assert.equal(op.state, 'confirmed');
    assert.equal(op.evidence.chain.wire, f.state.sends[0].wire);
    assert.equal(op.payload.originalJournalRow.txId, legacy.txId);
  } finally { db.close(); }
  f.connection.getTransaction = async () => { throw new Error('receipt provider unavailable'); };
  assert.deepEqual(await f.runtime.execute(airdropInput), result);
  assert.equal(f.state.sends.length, 2);
});

}

for (const scenario of ['signature', 'amount', 'message', 'credit', 'short credit', 'missing prior credit', 'finalization', 'network']) {
  test(`an uncertain older ${scenario} preserves the journal and stops later airdrop payments`, async (t) => {
    const f = fixture(t, { chain: { destinationExists: scenario === 'missing prior credit' } }), row = await seedLegacyDelivery(f);
    const original = f.journal.activeForWallet(walletPublicKey).airdrop;
    if (scenario === 'signature') {
      const receipt = f.state.receipts.get(row.txId); receipt.transaction.signatures[0] = '1'.repeat(64);
    } else if (scenario === 'amount') {
      f.state.receipts.get(row.txId).meta.postTokenBalances[0].uiTokenAmount.amount = '1';
    } else if (scenario === 'message') {
      const receipt = f.state.receipts.get(row.txId); receipt.transaction.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
    } else if (scenario === 'credit') {
      f.state.receipts.get(row.txId).meta.postTokenBalances[1].uiTokenAmount.amount = '9000000';
    } else if (scenario === 'short credit') {
      f.state.receipts.get(row.txId).meta.postTokenBalances[1].uiTokenAmount.amount = '2499999';
    } else if (scenario === 'missing prior credit') {
      f.state.receipts.get(row.txId).meta.preTokenBalances.splice(1, 1);
    } else if (scenario === 'finalization') f.state.status = 'confirmed';
    else f.state.genesisHash = 'changed-chain';
    await assert.rejects(f.runtime.execute(airdropInput), { code: 'EXECUTION_RECOVERY_REQUIRED' });
    assert.equal(f.walletExecution.active(walletPublicKey).kind, 'airdrop-observed-delivery');
    assert.equal(f.runtime.canRecover(walletPublicKey), true);
    assert.deepEqual(f.journal.activeForWallet(walletPublicKey).airdrop, original);
    assert.equal(f.state.sends.length, 1);
  });
}

test('Token-2022 airdrops preserve gross, net, and withheld amounts for each recipient', async (t) => {
  const f = fixture(t, { chain: { token2022: true, transferFee: true } });
  const input = { ...airdropInput, isToken2022: true };
  f.journal.upsertForWallet(walletPublicKey, { poolPlan: { airdropPlan: { tokenMint: input.tokenMint, tokenDecimals: 6, isToken2022: true, recipients: input.recipients } } });
  const result = await f.runtime.execute(input);
  assert.ok(result.transferred.every((row) => row.amountRaw === '2500000' && row.receivedRaw === '2495000' && row.transferFeeRaw === '5000'));
  assert.equal(f.state.sends.length, 2);
});


test('an older receipt remains recoverable after a failed chain read', async (t) => {
  const f = fixture(t); await seedLegacyDelivery(f); f.state.status = 'confirmed';
  await assert.rejects(f.runtime.execute(airdropInput), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  const operation = f.walletExecution.active(walletPublicKey);
  assert.equal(operation.kind, 'airdrop-observed-delivery');
  f.state.status = 'finalized';
  assert.equal((await f.runtime.execute(airdropInput)).transferred.length, 2);
  assert.equal(f.state.sends.length, 2);
  const db = openRuntimeStore(f.profile);
  try { assert.equal(db.getOperation(operation.id).state, 'confirmed'); } finally { db.close(); }
});

// The batch service itself is tested against a local validator. This drives the airdrop runtime's
// grouping, replay, and recovery through a stand-in that stores a confirmed batch as that service does.
function batchFixture(t, { loseReply = false } = {}) {
  const calls = [];
  const f = fixture(t, { batchSize: 5, wrapWalletExecution: (walletExecution, journal) => ({ ...walletExecution, transferBatchMax: 5,
    transferTokenBatch: async ({ mint, programId, decimals, sourceTokenAccount, recipients: rows, action }) => {
      calls.push(rows);
      const scopeId = journal.activeForWallet(walletPublicKey).id;
      const db = openRuntimeStore(f.profile);
      try {
        const launch = db.saveLaunch({ id: `batch-${calls.length}`, walletPublicKey, network: 'devnet', planDigest: String(calls.length).padStart(64, "0"),
          config: { scopeId, action, genesisHash: SOLANA_GENESIS_HASHES.devnet } });
        const operation = db.prepareOperation({ launchId: launch.id, kind: 'token-transfer-batch',
          payload: { mint, programId, decimals, sourceTokenAccount, recipients: rows } });
        db.setOperationState(operation.id, 'confirmed', { chain: { signature: `sig-${calls.length}`, mint, programId, decimals, sourceTokenAccount,
          recipients: rows.map((row) => ({ ...row, destinationTokenAccount: `ata-${row.destinationWallet}`, receivedRaw: row.amountRaw, transferFeeRaw: '0' })), feeLamports: 5000, rentLamports: 0 } });
        if (loseReply && calls.length === 1) throw new Error('reply lost');
        return { operationId: operation.id, txId: `sig-${calls.length}` };
      } finally { db.close(); }
    } }) });
  return { ...f, calls };
}

test('airdrop recipients go out several to a transaction and each is recorded from its receipt', async (t) => {
  const f = batchFixture(t);
  const progress = [];
  const result = await f.runtime.execute({ ...airdropInput, onProgress: (row) => progress.push(row.recipient) });
  assert.equal(f.calls.length, 1, 'both recipients share one transaction');
  assert.deepEqual(f.calls[0].map((row) => row.destinationWallet), recipients);
  assert.equal(f.state.sends.length, 0, 'no single transfers are sent');
  assert.deepEqual(result.transferred.map((row) => [row.wallet, row.amountRaw, row.txId]), recipients.map((wallet) => [wallet, '2500000', 'sig-1']));
  assert.deepEqual(progress, recipients);
  const journal = f.journal.activeForWallet(walletPublicKey);
  assert.equal(journal.events.filter((event) => event.stage === 'airdrop_recipient_done').length, 2);
  assert.deepEqual(await f.runtime.execute(airdropInput), result, 'a finished airdrop sends nothing again');
  assert.equal(f.calls.length, 1);
});

test('a batch whose reply was lost is recorded from its saved receipt, not sent again', async (t) => {
  const f = batchFixture(t, { loseReply: true });
  await assert.rejects(f.runtime.execute(airdropInput), /reply lost/);
  assert.equal(f.journal.activeForWallet(walletPublicKey).airdrop?.transferred?.length || 0, 0);
  const result = await f.runtime.execute(airdropInput);
  assert.equal(f.calls.length, 1, 'the confirmed batch is not sent again');
  assert.deepEqual(result.transferred.map((row) => row.txId), ['sig-1', 'sig-1']);
});
