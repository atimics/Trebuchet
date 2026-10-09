import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const dialogs = readFileSync(new URL('../public/v2/features/shell/dialogs.js', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../public/v2/api-client.js', import.meta.url), 'utf8');
const connectionSource = readFileSync(new URL('../public/v2/features/shell/connection.js', import.meta.url), 'utf8');
const locked = { configured: true, unlocked: false, locked: true, damaged: false };
const unlocked = { ...locked, unlocked: true, locked: false };
const failure = (code) => Object.assign(new Error('Request interrupted'), { code });

function gateHarness(apiClient, refresh = async () => {}) {
  const timers = new Map();
  const nodes = new Map();
  const notices = [];
  let sequence = 0;
  let settled = null;
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', disabled: false, dataset: {}, setAttribute() {},
      classList: { toggle() {} }, focus() {} });
    return nodes.get(id);
  };
  const boxes = Array.from({ length: 4 }, (_, index) => node(`box-${index}`));
  const context = {
    state: { secretPin: { ...locked }, recoveryPinGate: { open: true, value: '4321', status: 'idle', reason: 'unlock' }, apiClient },
    window: { setTimeout: (callback) => { const id = ++sequence; timers.set(id, callback); return id; },
      clearTimeout: (id) => timers.delete(id), requestAnimationFrame: (callback) => callback() },
    document: { body: { classList: { toggle() {} } } },
    $: node, $$: () => boxes,
    recoveryPinGatePromise: {}, recoveryPinGateResolve: (value) => { settled = value; },
    recoveryPinGateTimer: null, recoveryPinReturnFocus: null,
    refreshSecretPinStatus: refresh, restoreDialogFocus() {},
    renderAll: () => context.renderRecoveryPinGate(),
  };
  vm.runInNewContext(dialogs, context);
  context.notify = (message) => notices.push(message);
  return { context, notices, node, settled: () => settled, tick: () => {
    for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
  } };
}

test('PIN work has time to finish after the short general request budget', async () => {
  const response = (body) => ({ ok: true, status: 200, json: async () => body });
  const context = { URL, URLSearchParams, AbortController, setTimeout, clearTimeout };
  context.globalThis = context;
  vm.runInNewContext(apiSource, context);
  const paths = [];
  const client = context.TrebuchetV2Api.createV2ApiClient({ timeoutMs: 5,
    fetchImpl: async (url, init = {}) => {
      if (url === '/api/session') return response({ token: 'test-session' });
      paths.push(url);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(response({ success: true, status: unlocked })), 20);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    } });
  for (const operation of [() => client.setupSecretPin('4321'), () => client.unlockSecretPin('4321'),
    () => client.changeSecretPin({ currentPin: '4321', newPin: '1234' }), () => client.getSecretPinStatus()]) {
    assert.equal((await operation()).unlocked, true);
  }
  assert.deepEqual(paths, ['/api/secret-pin/setup', '/api/secret-pin/unlock', '/api/secret-pin/change', '/api/secret-pin/status']);
  const boot = await client.bootstrap();
  assert.equal(boot.secretPin.unlocked, true, 'bootstrap status uses the PIN request budget');
  assert.equal(boot.endpointStatus.secretPin, true);
  assert.equal(boot.endpointStatus.prefs, false, 'ordinary bootstrap reads retain their short budget');
});

test('a timeout with the PIN still locked clears the digits and enables another try', async () => {
  let statusReads = 0;
  const harness = gateHarness({ unlockSecretPin: async () => { throw failure('TIMEOUT'); },
    getSecretPinStatus: async () => { statusReads++; return locked; } });
  await harness.context.submitRecoveryPinGate();
  assert.equal(statusReads, 1);
  assert.equal(harness.context.state.secretPin.locked, true);
  assert.equal(harness.context.state.recoveryPinGate.status, 'error');
  harness.tick();
  assert.equal(harness.context.state.recoveryPinGate.status, 'idle');
  assert.equal(harness.node('#recoveryPinInput').disabled, false);
  assert.equal(harness.node('#recoveryPinInput').value, '');
  harness.context.state.apiClient.unlockSecretPin = async () => unlocked;
  harness.context.state.recoveryPinGate.value = '4321';
  await harness.context.submitRecoveryPinGate(); harness.tick();
  assert.equal(harness.settled(), true);
});

test('a lost unlock reply accepts only a confirmed local unlocked status', async () => {
  for (const error of [failure('TIMEOUT'), failure('INVALID_JSON'), new TypeError('fetch failed')]) {
    let attempts = 0;
    let statusReads = 0;
    const harness = gateHarness({ unlockSecretPin: async () => { attempts++; throw error; },
      getSecretPinStatus: async () => { statusReads++; return unlocked; } });
    await harness.context.submitRecoveryPinGate(); harness.tick();
    assert.equal(attempts, 1); assert.equal(statusReads, 1);
    assert.equal(harness.settled(), true);
    assert.equal(harness.context.state.secretPin.unlocked, true);
  }
});

test('an unavailable status read leaves a timed out PIN check ready for another try', async () => {
  const harness = gateHarness({ unlockSecretPin: async () => { throw failure('TIMEOUT'); },
    getSecretPinStatus: async () => { throw new TypeError('fetch failed'); } });
  await harness.context.submitRecoveryPinGate(); harness.tick();
  assert.equal(harness.settled(), null);
  assert.equal(harness.context.state.secretPin.locked, true);
  assert.equal(harness.node('#recoveryPinInput').disabled, false);
});

test('partial or conflicting status replies keep the vault locked', async () => {
  for (const status of [{ unlocked: true }, { ...unlocked, configured: false },
    { ...unlocked, locked: true }, { ...unlocked, damaged: true }]) {
    const harness = gateHarness({ unlockSecretPin: async () => { throw failure('TIMEOUT'); },
      getSecretPinStatus: async () => status });
    await harness.context.submitRecoveryPinGate(); harness.tick();
    assert.equal(harness.settled(), null);
    assert.equal(harness.context.state.secretPin.locked, true);
    assert.equal(harness.node('#recoveryPinInput').disabled, false);
  }
});

test('a wrong PIN can be tried again while damaged or unavailable keys keep their error', async () => {
  for (const code of ['BAD_SECRET_PIN', 'SECRET_PIN_STATE_DAMAGED', 'SECRET_PIN_DEVICE_SECRET_UNAVAILABLE']) {
    let reads = 0;
    const harness = gateHarness({ unlockSecretPin: async () => { throw failure(code); },
      getSecretPinStatus: async () => { reads++; return unlocked; } });
    await harness.context.submitRecoveryPinGate(); harness.tick();
    assert.equal(reads, 0); assert.equal(harness.settled(), null);
    assert.equal(harness.context.state.recoveryPinGate.status, code === 'BAD_SECRET_PIN' ? 'idle' : 'error');
  }
});

test('wallet refresh failure keeps a confirmed PIN unlock successful', async () => {
  const harness = gateHarness({ unlockSecretPin: async () => unlocked }, async () => { throw failure('TIMEOUT'); });
  await harness.context.submitRecoveryPinGate(); harness.tick();
  assert.equal(harness.context.state.secretPin.unlocked, true);
  assert.equal(harness.settled(), true);
  assert.equal(harness.notices.length, 1);
});

test('a partial wallet bootstrap keeps the confirmed PIN state until a successful status read', async () => {
  const harness = gateHarness({ unlockSecretPin: async () => unlocked });
  Object.assign(harness.context, {
    applyPersonalDiscoveryState() {}, restoreDetectedLaunch() {}, renderSavedLaunchList() {},
    normalizeClmmFeeTiers: () => [], freeVanityCandidates: () => [], authoritativeNetworkLabel: () => 'Solana',
  });
  harness.context.state.updateCheck = {};
  const start = connectionSource.indexOf('function applyBootState(');
  const end = connectionSource.indexOf('async function bootLocalApi()', start);
  vm.runInNewContext(connectionSource.slice(start, end), harness.context);
  harness.context.refreshSecretPinStatus = async () => harness.context.applyBootState({
    api: { available: true, status: 'connected' }, endpointStatus: { secretPin: false },
    secretPin: { configured: false, unlocked: false, locked: false },
  });
  await harness.context.submitRecoveryPinGate(); harness.tick();
  assert.equal(harness.context.state.secretPin.unlocked, true);
  assert.equal(harness.context.state.secretPin.configured, true);
  assert.equal(harness.settled(), true);
  harness.context.state.recoveryPinOffered = true;
  harness.context.applyBootState({ api: { available: true, status: 'connected' },
    endpointStatus: { secretPin: true }, secretPin: locked });
  assert.equal(harness.context.state.secretPin.locked, true, 'a later confirmed lock replaces the saved UI state');
  harness.context.applyBootState({ api: { available: false, status: 'static' },
    secretPin: { configured: false, unlocked: false, locked: false } });
  assert.equal(harness.context.state.secretPin.locked, true, 'an unavailable API preserves the last confirmed lock');
});
