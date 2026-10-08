import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireProfileOwner } from '../packages/runtime/src/owner.js';
import { openRuntimeStore } from '../packages/runtime/src/store.js';
import { createWalletExecutionRuntime } from '../walletExecution.js';
import { wallet, walletPublicKey, closeChain } from '../packages/runtime/test/fixtures/token-account-close-chain.mjs';

function fixture(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-wallet-close-'));
  const owner = acquireProfileOwner(profile);
  t.after(() => { owner.release(); fs.rmSync(profile, { recursive: true, force: true }); });
  const ledger = closeChain();
  const runtime = createWalletExecutionRuntime({ owner, getScopeId: () => 'journal-a', networkForRequest: () => 'devnet', createConnection: () => ledger.connection, timeoutMs: 0 });
  const store = () => { const db = openRuntimeStore(profile); t.after(() => db.close()); return db; };
  return { ...ledger, runtime, store, secret: Array.from(wallet.secretKey) };
}

test('the launch wallet closes every empty token account it owns, in batches, and leaves the rest', async (t) => {
  const f = fixture(t);
  const empty = Array.from({ length: 10 }, (_, index) => f.add(100 + index, { token2022: index % 2 === 1 }));
  f.add(120, { amount: 7n });
  f.add(121, { token2022: true, withheld: 2n });
  const before = f.state.balance;
  const result = await f.runtime.closeEmptyTokenAccounts({ tempWalletSecretKey: f.secret });
  assert.equal(result.closed.length, 10); assert.deepEqual(result.errors, []);
  assert.equal(f.state.sends.length, 2, 'eight accounts per transaction');
  const rent = 5 * 2_039_280 + 5 * 2_074_080;
  assert.equal(result.reclaimedLamports, rent);
  assert.equal(f.state.balance, before + rent - 2 * 5000);
  assert.deepEqual([...f.state.accounts.keys()].sort(), [...f.state.accounts.keys()].filter((address) => !empty.includes(address)).sort());
  assert.equal(f.state.accounts.size, 2, 'the account holding tokens and the one with withheld fees stay');
  assert.equal(f.runtime.active(walletPublicKey), null);
  assert.deepEqual(await f.runtime.closeEmptyTokenAccounts({ tempWalletSecretKey: f.secret }), { closed: [], reclaimedLamports: 0, errors: [] });
});

test('an unconfirmed close holds the wallet until it is recovered, with one send', async (t) => {
  const f = fixture(t);
  f.add(130); f.add(131);
  f.state.afterSend = () => { throw new Error('reply lost'); };
  await assert.rejects(f.runtime.closeEmptyTokenAccounts({ tempWalletSecretKey: f.secret }), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  assert.equal(f.runtime.active(walletPublicKey).kind, 'token-account-close');
  f.state.afterSend = null;
  const recovered = await f.runtime.recover({ tempWalletSecretKey: f.secret });
  assert.equal(recovered.closed.length, 2);
  assert.equal(f.runtime.active(walletPublicKey), null);
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.accounts.size, 0);
});
