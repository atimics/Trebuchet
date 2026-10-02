import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProfileJournalStore, createProfileLaunchStore } from '../src/profile-stores.js';
const fixture = JSON.parse(fs.readFileSync(new URL('../../core/test/fixtures/guided-sol-plan.json', import.meta.url)));
function profile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-profile-migrate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
test('app journal adapter migrates legacy state once and preserves the original', (t) => {
  const dir = profile(t), file = path.join(dir, 'launchJournals.json');
  const original = JSON.stringify([{ id: 'old', walletPublicKey: 'wallet', token: { mint: 'mint' }, events: [{ stage: 'supply_minted' }] }]);
  fs.writeFileSync(file, original);
  const store = createProfileJournalStore(dir);
  assert.equal(store.activeForWallet('wallet').token.mint, 'mint');
  store.update('old', { stage: 'liquidity_created' }, { stage: 'pool_create_done', poolId: 'pool' });
  assert.equal(createProfileJournalStore(dir).get('old').stage, 'liquidity_created');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(store.get('old').events.length, 2);
});
test('saved launches migrate with their configuration and keep the source file', (t) => {
  const dir = profile(t), file = path.join(dir, 'launches.json');
  const original = JSON.stringify([{ id: 'old', name: 'Existing', config: fixture.intent, source: 'app' }]);
  fs.writeFileSync(file, original);
  const store = createProfileLaunchStore(dir);
  assert.equal(store.get('old').config.token.symbol, fixture.intent.token.symbol);
  store.save({ id: 'old', config: fixture.intent, name: 'Renamed', source: 'cli' });
  assert.equal(createProfileLaunchStore(dir).get('old').name, 'Renamed');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});
test('damaged legacy records leave migration pending and preserve all bytes', (t) => {
  const dir = profile(t), file = path.join(dir, 'launchJournals.json');
  fs.writeFileSync(file, '[null]');
  assert.throws(() => createProfileJournalStore(dir).start({ walletPublicKey: 'new' }), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  assert.equal(fs.readFileSync(file, 'utf8'), '[null]');
  fs.writeFileSync(file, '[{"id":"recovered","walletPublicKey":"old"}]');
  assert.equal(createProfileJournalStore(dir).get('recovered').walletPublicKey, 'old');
});
