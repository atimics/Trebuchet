import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createLaunchJournalStore,
  errorMessage,
  errorDetails,
  sanitizeForJournal,
  tokenCreationComplete,
} from '../src/launch-journal.js';

function makeStore(t, warnings = []) {
  const dir = mkdtempSync(path.join(tmpdir(), 'trebuchet-core-journal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createLaunchJournalStore({
    filePath: path.join(dir, 'launchJournals.json'),
    onWarn: (message) => warnings.push(message),
  });
}

test('start is idempotent per wallet and persists atomically', (t) => {
  const store = makeStore(t);
  const first = store.start({ walletPublicKey: 'WalletA1111111111111111111111111111111' });
  const second = store.start({ walletPublicKey: 'WalletA1111111111111111111111111111111' });
  assert.equal(first.id, second.id);
  assert.equal(store.list().length, 1);

  // The file on disk is valid JSON and matches the store view.
  const raw = JSON.parse(readFileSync(store.filePath, 'utf8'));
  assert.equal(raw.length, 1);
  assert.equal(raw[0].walletPublicKey, 'WalletA1111111111111111111111111111111');
});

test('secret-bearing fields are dropped before persistence', (t) => {
  const store = makeStore(t);
  const journal = store.upsertForWallet(
    'WalletB1111111111111111111111111111111',
    {
      stage: 'token_created',
      secretKey: [1, 2, 3],
      privateKey: 'deadbeef',
      mnemonic: 'zoo zoo zoo',
      token: { mint: 'Mint11111111111111111111111111111111', isSafe: true },
    },
    { stage: 'event_with_secret', secret: 'nope' },
  );
  const raw = JSON.parse(readFileSync(store.filePath, 'utf8'));
  const serialized = JSON.stringify(raw[0]);
  assert.equal(serialized.includes('deadbeef'), false);
  assert.equal(serialized.includes('zoo zoo'), false);
  assert.equal(serialized.includes('[1,2,3]'), false);
  assert.equal(journal.token.mint, 'Mint11111111111111111111111111111111');

  // sanitizeForJournal drops secret-like keys at any depth.
  assert.equal(sanitizeForJournal({ nested: { secretKey: 'x', ok: 1 } }).nested.ok, 1);
  assert.equal(sanitizeForJournal({ nested: { secretKey: 'x', ok: 1 } }).nested.secretKey, undefined);
});

test('update merges known objects and appends trimmed events', (t) => {
  const store = makeStore(t);
  const wallet = 'WalletC1111111111111111111111111111111';
  const journal = store.start({ walletPublicKey: wallet });
  store.update(journal.id, { token: { mint: 'MintC11111111111111111111111111111111' } });
  const merged = store.update(journal.id, { token: { supply: '1000' } }, { stage: 'supply_minted' });
  assert.equal(merged.token.mint, 'MintC11111111111111111111111111111111');
  assert.equal(merged.token.supply, '1000');
  assert.ok(merged.events.some((event) => event.stage === 'supply_minted'));
});

test('terminal journals are excluded from the default list and hidden from activeForWallet', (t) => {
  const store = makeStore(t);
  const wallet = 'WalletD1111111111111111111111111111111';
  const journal = store.start({ walletPublicKey: wallet });
  store.update(journal.id, { status: 'completed' });
  assert.equal(store.list().length, 0);
  assert.equal(store.list({ includeCompleted: true }).length, 1);
  assert.equal(store.activeForWallet(wallet), null);
  assert.ok(store.archive(journal.id));
  assert.equal(store.list({ includeCompleted: true }).length, 0);
  assert.equal(store.list({ includeCompleted: true, includeArchived: true }).length, 1);
});

test('tokenCreationComplete requires supply plus metadata or verified repair', () => {
  const base = { token: { mint: 'MintT11111111111111111111111111111111', mintAuthorityRenounced: true } };
  assert.equal(tokenCreationComplete({ ...base, events: [{ stage: 'supply_minted' }] }), false);
  assert.equal(tokenCreationComplete({
    ...base,
    events: [{ stage: 'supply_minted' }, { stage: 'metadata_account_created' }],
  }), true);
  assert.equal(tokenCreationComplete({
    ...base,
    token: { ...base.token, isSafe: true },
    events: [{ stage: 'supply_minted' }],
  }), true);
});

test('error helpers sanitize and truncate', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom');
  assert.equal(errorMessage(undefined), 'Unknown error');
  const details = errorDetails(new Error('bad'), { route: 'test' });
  assert.equal(details.message, 'bad');
  assert.equal(details.route, 'test');
  assert.ok(details.stack.length <= 8000 + 40);
});

test('corrupt recovery data stays byte-for-byte intact and blocks new records', (t) => {
  const store = makeStore(t);
  for (const bytes of ['{damaged journal', '{}', '[null]', '[{"id":"incomplete"}]']) {
    writeFileSync(store.filePath, bytes);
    assert.throws(() => store.start({ walletPublicKey: 'WalletE' }), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
    assert.equal(readFileSync(store.filePath, 'utf8'), bytes);
  }
});

test('a failed commit throws and preserves the prior checkpoint', (t) => {
  const errors = [];
  const store = makeStore(t);
  const original = store.start({ walletPublicKey: 'WalletF' });
  const before = readFileSync(store.filePath, 'utf8');
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('disk unavailable'), { code: 'EIO' }); });
  assert.throws(() => store.update(original.id, { stage: 'mint_sent' }), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  assert.equal(readFileSync(store.filePath, 'utf8'), before);
  assert.equal(store.get(original.id).stage, 'wallet_generated');
  assert.deepEqual(fs.readdirSync(path.dirname(store.filePath)), ['launchJournals.json']);
});
