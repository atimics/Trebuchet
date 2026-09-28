import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import * as native from '../packages/core/src/browser.js';
import { buildBrowserCoreString, buildV2AppString } from '../scripts/build-v2-js.mjs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const bundle = read('public/v2/core.js');
const plain = (value) => JSON.parse(JSON.stringify(value));
const now = '2026-01-01T00:00:00.000Z';

function browserContext() {
  const sandbox = { console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, atob, btoa };
  vm.createContext(sandbox);
  vm.runInContext(bundle, sandbox, { filename: 'web://core.js' });
  assert.equal(vm.runInContext('typeof Buffer', sandbox), 'undefined');
  assert.equal(vm.runInContext('typeof process', sandbox), 'undefined');
  return sandbox;
}

test('shipped browser rules and renderer match their source builds', () => {
  assert.equal(bundle, buildBrowserCoreString());
  assert.equal(read('public/v2/app.js'), buildV2AppString());
  const html = read('public/v2/index.html');
  assert.ok(html.indexOf('./core.js?') < html.indexOf('./app.js?'));
});

test('streamlined planning produces identical plans in Node and the shipped browser bundle', () => {
  const core = browserContext().TrebuchetCore;
  for (const input of [
    { token: { name: 'Web Test', symbol: 'WEB' }, solUsd: 150 },
    { token: { name: 'Pairs', symbol: 'PAIR' }, poolCount: 3, quotes: ['SOL', 'USDC', 'USDT'], solUsd: 95 },
    { token: { name: 'Fees', symbol: 'FEE' }, fees: { buyBps: 100, sellBps: 50, treasury: '5K9eGhNM9NvjNpyBLk7EhWJ3WX8fC9eYp8N7k4RfJX9z' } },
  ]) {
    const plan = core.buildStreamlinedPlan(input, { now });
    assert.deepEqual(plain(plan), native.buildStreamlinedPlan(input, { now }));
    assert.equal(core.verifyStreamlinedPlan(plan).valid, true);
  }
  assert.equal(core.buildStreamlinedPlan({}, { now }).ledger.totalSol, 0.12138);
});

function imageHeaders() {
  const png = Buffer.alloc(33);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  png.write('IHDR', 12);
  png.writeUInt32BE(128, 16);
  png.writeUInt32BE(64, 20);
  const jpeg = Buffer.from([255, 216, 255, 192, 0, 17, 8, 0, 64, 0, 128, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217]);
  const gif = Buffer.alloc(13);
  gif.write('GIF89a');
  gif.writeUInt16LE(128, 6);
  gif.writeUInt16LE(64, 8);
  return [['image/png', png], ['image/jpeg', jpeg], ['image/gif', gif]];
}

test('image bytes and logo plans work with browser byte views and keep existing SHA-256 digests', () => {
  const core = browserContext().TrebuchetCore;
  for (const [mime, bytes] of imageHeaders()) {
    // Offset views catch reads against the whole backing buffer.
    const padded = new Uint8Array(bytes.length + 8);
    padded.set(bytes, 4);
    const view = padded.subarray(4, 4 + bytes.length);
    assert.equal(core.normalizeLogoImageMime(view), mime);
    assert.deepEqual(plain(core.detectLogoImageDimensions(view)), { width: 128, height: 64 });
    const input = {
      token: { name: 'Image 🌑', symbol: 'IMG', logo: { name: 'logo', dataUrl: `data:${mime};base64,${bytes.toString('base64')}` } },
      launchSol: 1, mode: 'dry-run',
    };
    const plan = core.buildV2LaunchPlan(input, { now });
    assert.deepEqual(plain(plan), plain(native.buildV2LaunchPlan(input, { now })));
    assert.equal(core.verifyLaunchPlan(plan).valid, true);
    // The old digest used Node crypto over the sorted integrity payload.
    const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
    const { integrity, ...payload } = plain(plan);
    assert.equal(integrity.digest, createHash('sha256').update(JSON.stringify(stable(payload))).digest('hex'));
    for (let length = 0; length < bytes.length; length++) {
      assert.doesNotThrow(() => core.detectLogoImageDimensions(view.subarray(0, length)));
    }
  }
  assert.throws(() => core.buildV2LaunchPlan({ token: { logo: { dataUrl: 'data:image/png;base64,A===' } } }), /valid base64/);
});

test('recovery and proof rules agree across Node and browser hosts', () => {
  const core = browserContext().TrebuchetCore;
  const journal = {
    id: 'launch-1', walletPublicKey: '11111111111111111111111111111115', status: 'failed',
    token: { mint: '11111111111111111111111111111116', mintAuthorityRenounced: true, isSafe: true },
    events: [{ stage: 'supply_minted' }],
    lp: { failedPhase: 'lock', results: [{ poolId: 'pool-1', positions: [{ nftMint: 'position-1' }] }] },
  };
  assert.deepEqual(plain(core.buildV2ExecutionContext({ journal })), plain(native.buildV2ExecutionContext({ journal })));
  const proof = { journal, token: journal.token, lp: journal.lp, transfer: { walletEmpty: false } };
  assert.equal(core.v2LaunchProofFingerprint(proof), native.v2LaunchProofFingerprint(proof));
  assert.deepEqual(plain(core.verifyTrebuchetProof(proof)), plain(native.verifyTrebuchetProof(proof)));
});

test('browser cost and vanity displays use the shared rules at different prices and sizes', () => {
  const sandbox = browserContext();
  vm.runInContext(read('public/v2/features/launch/quick.js'), sandbox);
  const distribution = read('public/v2/features/launch/distribution.js');
  const airdrop = distribution.match(/function computeAirdropExecutionCostSol[\s\S]*?\n}/)[0];
  const vanity = read('public/v2/features/launch/vanity.js').match(/function vanityExpectedAttempts[\s\S]*?\n}/)[0];
  vm.runInContext(`${airdrop}\n${vanity}`, sandbox);
  for (const price of [0.5, 95, 150, 1800]) {
    vm.runInContext(`QUICK_SOL_USD = ${price}`, sandbox);
    for (const quote of ['SOL', 'USDC', 'USDT']) {
      const shown = sandbox.quickLaunchLedger(quote);
      const expected = native.buildStreamlinedLedger({ quotes: [quote], solUsd: price });
      assert.equal(shown.total, expected.totalSol);
      assert.deepEqual(plain(shown.lines.map((line) => line.sol)), expected.lines.map((line) => line.sol));
    }
  }
  for (const count of [0, 1, 10, 11, 1000]) assert.equal(sandbox.computeAirdropExecutionCostSol(count), native.estimateAirdropExecutionCostSol(count));
  for (const length of [null, 43, 44]) {
    assert.equal(sandbox.vanityExpectedAttempts('RUG', 'rug', true, length), native.expectedVanityAttempts('RUG', 'rug', { caseInsensitive: true, length }));
  }
});
