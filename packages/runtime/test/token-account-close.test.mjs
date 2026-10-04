import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireProfileOwner } from '../src/owner.js';
import { openRuntimeStore } from '../src/store.js';
import { createSolanaSigner, SOLANA_GENESIS_HASHES } from '../src/solana.js';
import { createTokenAccountCloseService, closableTokenAccount } from '../src/token-account-close.js';
import { wallet, walletPublicKey, key, closeChain } from './fixtures/token-account-close-chain.mjs';

function fixture(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-account-close-'));
  const owner = acquireProfileOwner(profile), store = openRuntimeStore(profile);
  t.after(() => { store.close(); owner.release(); fs.rmSync(profile, { recursive: true, force: true }); });
  const ledger = closeChain();
  const service = () => createTokenAccountCloseService({ owner, store, connection: ledger.connection, network: 'devnet', expectedGenesisHash: SOLANA_GENESIS_HASHES.devnet,
    signer: createSolanaSigner({ getSigners: async () => [wallet] }), authorize: async () => true,
    feePolicy: async ({ accountCount }) => ({ computeUnitLimit: 20_000 + 5_000 * accountCount, microLamports: 1000, feeCeilingLamports: 20_000 }), timeoutMs: 0 });
  const approval = (accounts) => ({ id: 'close-request', walletPublicKey, network: 'devnet', genesisHash: SOLANA_GENESIS_HASHES.devnet,
    expiresAtMs: Date.now() + 60_000, maxSpendLamports: 1_000_000, close: { accounts: [...accounts].sort() } });
  return { ...ledger, store, service, approval, active: () => store.getActiveOperation(walletPublicKey) };
}

test('empty classic and Token-2022 accounts close in one saved transaction and their rent returns to the wallet', async (t) => {
  const f = fixture(t);
  const accounts = [f.add(60), f.add(61, { token2022: true, withheld: 0n })];
  const result = await f.service().close({ scopeId: 'journal-a', walletPublicKey, accounts, approval: f.approval(accounts) });
  assert.equal(f.state.sends.length, 1);
  assert.deepEqual(result.closed, [...accounts].sort());
  assert.equal(result.reclaimedLamports, 2_039_280 + 2_074_080);
  assert.equal(f.state.balance, 1_000_000 + 2_039_280 + 2_074_080 - 5000);
  assert.equal(f.state.accounts.size, 0);
  const operation = f.store.getOperation(result.operationId);
  assert.equal(operation.state, 'confirmed');
  assert.equal(operation.evidence.chain.feeLamports, 5000);
  assert.equal(f.store.getTransactions(operation.id)[0].signature, result.txId);
  assert.deepEqual(await f.service().close({ scopeId: 'journal-a', walletPublicKey, accounts, approval: f.approval(accounts) }), result);
  assert.equal(f.state.sends.length, 1, 'a finished close is not sent again');
});

test('only empty accounts the wallet owns and can close by itself qualify', (t) => {
  const f = fixture(t);
  const check = (seed, options) => closableTokenAccount(f.add(seed, options), f.info(key(seed).toBase58()), walletPublicKey);
  assert.ok(check(70, {}));
  assert.equal(check(71, { amount: 1n }), null, 'holds tokens');
  assert.equal(check(72, { owner: key(99) }), null, 'another owner');
  assert.equal(check(73, { closeAuthority: key(98) }), null, 'another close authority');
  assert.ok(check(74, { closeAuthority: wallet.publicKey }), 'the wallet as close authority');
  assert.equal(check(75, { token2022: true, withheld: 3n }), null, 'withheld transfer fees');
  assert.equal(closableTokenAccount(walletPublicKey, f.info(walletPublicKey), walletPublicKey), null, 'not a token account');
});

test('an account that is not closable is refused before anything is saved or sent', async (t) => {
  const f = fixture(t);
  const accounts = [f.add(80), f.add(81, { amount: 5n })];
  await assert.rejects(f.service().close({ scopeId: 'journal-a', walletPublicKey, accounts, approval: f.approval(accounts) }), { code: 'INVALID_INPUT' });
  assert.equal(f.active(), null); assert.equal(f.state.sends.length, 0);
});

test('an approval for other accounts sends nothing', async (t) => {
  const f = fixture(t);
  const accounts = [f.add(82)];
  await assert.rejects(f.service().close({ scopeId: 'journal-a', walletPublicKey, accounts, approval: f.approval([f.add(83)]) }), { code: 'EXECUTION_APPROVAL_REQUIRED' });
  assert.equal(f.state.sends.length, 0);
});

test('a lost reply is recovered from the saved transaction without sending a second close', async (t) => {
  const f = fixture(t);
  const accounts = [f.add(84), f.add(85)];
  f.state.afterSend = () => { throw new Error('reply lost'); };
  await assert.rejects(f.service().close({ scopeId: 'journal-a', walletPublicKey, accounts, approval: f.approval(accounts) }), /reply lost/);
  assert.equal(f.active().state, 'recovery_required');
  f.state.afterSend = null;
  const result = await f.service().recover({ walletPublicKey, approval: f.approval(accounts) });
  assert.equal(result.reclaimedLamports, 2 * 2_039_280);
  assert.equal(f.state.sends.length, 1); assert.equal(f.active(), null);
});

test('a receipt that does not show every account emptied into the wallet is not accepted', async (t) => {
  const f = fixture(t);
  const accounts = [f.add(86)];
  f.state.receiptTransform = (receipt) => receipt && { ...receipt, meta: { ...receipt.meta, postBalances: receipt.meta.postBalances.map((value, index) => index === 0 ? value - 1 : value) } };
  await assert.rejects(f.service().close({ scopeId: 'journal-a', walletPublicKey, accounts, approval: f.approval(accounts) }), { code: 'CHAIN_STATE_UNAVAILABLE' });
  assert.notEqual(f.active()?.state, 'confirmed');
  assert.equal(f.state.sends.length, 1);
});
