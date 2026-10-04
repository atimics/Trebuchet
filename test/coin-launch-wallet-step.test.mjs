import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { SOL_DUST_THRESHOLD } from '../walletRecovery.js';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const source = server.slice(server.indexOf('function coinCreationSteps('), server.indexOf("app.get('/api/v2/coins/:mint'"));
const steps = (journal, launchWalletLamports) => {
  const context = vm.createContext({ SOL_DUST_THRESHOLD, Math, Set, Boolean, String,
    sealedMetadataRevealReadiness: () => ({ positionCount: 0, lockedPositionCount: 0 }), v2JournalLiquidityResults: () => [],
    v2TrimmedText: (value) => String(value || '').trim(), pendingWallets: { get: () => null } });
  vm.runInContext(source, context);
  return context.coinCreationSteps(journal, { launchWalletLamports }).steps.find((step) => step.id === 'return');
};
const swept = { walletPublicKey: 'wallet', token: { mint: 'mint' }, transfer: { walletEmpty: true } };

test('a swept launch wallet keeping its rent reserve counts as swept, not as a disagreement', () => {
  const step = steps(swept, 660241);
  assert.equal(step.state, 'done');
  assert.equal(step.detail, "Swept. 0.00066 SOL stays as the wallet's rent reserve.");
  assert.equal(steps(swept, 0).detail, 'Swept. The launch wallet is empty.');
});

test('SOL above the dust line is still shown as not swept', () => {
  assert.equal(steps(swept, 5_000_000).state, 'mismatch');
  assert.equal(steps({ ...swept, transfer: {} }, 5_000_000).state, 'todo');
  assert.equal(steps(swept, 5_000_000).detail, '0.0050 SOL is still in the launch wallet.');
});

test('no screen text says a key was deleted', () => {
  const page = ['public/v2/app.js', 'server.js'].map((name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(page, /key (was )?deleted|deletes Trebuchet's local secret|Discard local secret|permanently deletes the recovery phrase/i);
});
