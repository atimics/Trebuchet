import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const guard = read('public/v2/features/shell/close-guard.js');

function page(overrides = {}) {
  const listeners = {};
  const state = { fullRunRunning: false, realExecutionRunning: false, demoLaunchRunning: false, sweepingWalletPublicKey: null,
    cancelRefund: { running: false }, heldWallets: { sweep: null }, airdropRunning: false, quoteAcquire: { running: false },
    reportPublishing: false, ...overrides };
  const context = vm.createContext({ state, window: { addEventListener: (name, run) => { listeners[name] = run; } } });
  vm.runInContext(guard, context);
  context.bindCloseGuard();
  const close = () => {
    const event = { prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } };
    listeners.beforeunload(event);
    return event;
  };
  return { state, close };
}

test('closing is free when no wallet work is running', () => {
  const event = page().close();
  assert.equal(event.prevented, false);
  assert.equal(event.returnValue, undefined);
});

test('closing asks first while a launch, sweep, airdrop or purchase is running', () => {
  for (const [overrides, reason] of [
    [{ fullRunRunning: true }, 'A launch step is running'],
    [{ sweepingWalletPublicKey: 'wallet' }, 'A wallet sweep is running'],
    [{ heldWallets: { sweep: { finished: false } } }, 'A wallet sweep is running'],
    [{ cancelRefund: { running: true } }, 'A wallet sweep is running'],
    [{ airdropRunning: true }, 'An airdrop is sending'],
    [{ quoteAcquire: { running: true } }, 'A pair-token purchase is running'],
  ]) {
    const event = page(overrides).close();
    assert.equal(event.prevented, true, reason);
    assert.equal(event.returnValue, reason);
  }
  assert.equal(page({ heldWallets: { sweep: { finished: true } } }).close().prevented, false);
});

test('the guard is bound at startup and the desktop dialog states facts', () => {
  assert.match(read('public/v2/features/shell/startup.js'), /bindCloseGuard\(\);/);
  const main = read('main.js');
  assert.match(main, /will-prevent-unload/);
  assert.doesNotMatch(main, /Pending Wallets panel|ephemeral wallet/);
});
