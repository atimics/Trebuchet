#!/usr/bin/env node
// test/startup-freeze.test.mjs — detects renderer freeze on startup
//
// Simulates a cold Electron-like launch: starts the server, loads the
// page WITH the splash screen intact, and verifies the page stays
// responsive through the critical first-paint to splash-dismiss window.
//
// Usage: node test/startup-freeze.test.mjs

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import net from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Setup: isolate config, inject demo mode, pick a free port, start server
const TMP = fs.mkdtempSync(path.join(tmpdir(), 'treb-freeze-'));
process.env.TREBUCHET_CONFIG_DIR = TMP;
fs.writeFileSync(TMP + '/userPrefs.json', JSON.stringify({ demoMode: true }));

process.env.PORT = String(await new Promise((res, rej) => {
  const s = net.createServer(); s.unref(); s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
}));

// Override connection factory so module-level Connection() doesn't try
// real DNS / RPC during import — a timeout there freezes everything.
import * as tokenService from '../tokenService.js';
import * as lpService from '../lpService.js';
import * as walletHelpers from '../walletHelpers.js';
import * as swapService from '../swapService.js';

const fakeConn = () => ({
  getBalance: async () => 5e9,
  getMinimumBalanceForRentExemption: async () => 890880,
  getAccountInfo: async () => null,
  getParsedAccountInfo: async () => ({ value: null }),
  getParsedTokenAccountsByOwner: async () => ({ value: [] }),
  getTokenAccountsByOwner: async () => ({ value: [] }),
  confirmTransaction: async () => ({ value: { err: null } }),
  sendTransaction: async () => 'fakesig',
  getSignaturesForAddress: async () => [],
  getParsedTransaction: async () => null,
  getLatestBlockhash: async () => ({ blockhash: '1'.repeat(32), lastValidBlockHeight: 1 }),
});

tokenService.setConnectionFactoryForTests(() => fakeConn());
lpService.setConnectionFactoryForTests(() => fakeConn());
walletHelpers.setConnectionFactoryForTests(() => fakeConn());
swapService.setConnectionFactoryForTests(() => fakeConn());
tokenService.refreshConnection();

// Start the Express server and capture its URL from the startup log.
let SERVER = null;
const _o = console.log;
console.log = (...a) => {
  _o(...a);
  const m = a.join(' ').match(/Server running on (http:\/\/127\.0\.0\.1:\d+)/);
  if (m) SERVER = m[1];
};
await import('../server.js');
for (let i = 0; i < 50 && !SERVER; i++) await new Promise(r => setTimeout(r, 100));
console.log = _o;
if (!SERVER) { console.error('Server did not start'); process.exit(1); }
console.log('Server: ' + SERVER);

// Test runner
let passed = 0;
let failed = 0;
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const browser = await chromium.launch({ headless: true });

async function withPage(fn, label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const consoleLog = [];
  p.on('console', (msg) => { consoleLog.push(msg.text()); });
  p.on('pageerror', (err) => { consoleLog.push('JS ERROR: ' + err.message); });
  try {
    await fn(p, consoleLog);
    console.log('  PASS: ' + label);
    passed++;
  } catch (e) {
    console.error('  FAIL: ' + label + ' — ' + e.message.split('\n')[0]);
    console.error('  Console log (all messages):');
    for (const line of consoleLog) console.error('    ' + line);
    failed++;
  } finally {
    try { await p.close(); } catch {}
    await ctx.close();
  }
}

// Test 1: Page loads and reaches domcontentloaded promptly
await withPage(async (p, log) => {
  const start = Date.now();
  await p.goto(SERVER, { waitUntil: 'domcontentloaded', timeout: 15000 });
  const elapsed = Date.now() - start;
  assert(elapsed < 10000, 'domcontentloaded took ' + elapsed + 'ms (threshold 10s)');
  console.log('    domcontentloaded in ' + elapsed + 'ms');
}, 'page reaches domcontentloaded');

// Test 2: Splash screen renders and skip button is clickable
await withPage(async (p, log) => {
  await p.goto(SERVER, { waitUntil: 'domcontentloaded', timeout: 15000 });

  // The splash screen should exist in the DOM immediately.
  const splash = await p.waitForSelector('#splashScreen', { state: 'attached', timeout: 5000 });
  assert(splash, 'splash screen not found in DOM');
  console.log('    splash screen present');

  // The skip button should be visible.
  const skipBtn = await p.waitForSelector('#splashSkipBtn', { state: 'visible', timeout: 8000 });
  assert(skipBtn, 'skip button not visible');

  // Diagnostic before click.
  const diag = await p.evaluate(() => {
    const splash = document.getElementById('splashScreen');
    const video = document.getElementById('splashVideo');
    return {
      splashClassList: splash ? splash.className : 'N/A',
      videoReadyState: video ? video.readyState : 'N/A',
      bodyHasSplash: document.body.classList.contains('has-splash'),
      hasActiveModal: !!document.querySelector('.modal.is-active'),
    };
  });
  console.log('    pre-click diag: ' + JSON.stringify(diag));

  // Probe: did setupSplashScreen actually attach event listeners?
  // Check if clicking the backdrop calls tryStartPlayback or dismiss.
  const btnHasClick = await p.evaluate(() => {
    var btn = document.getElementById('splashSkipBtn');
    // We can't enumerate listeners, but we can check if the splash
    // backdrop click does anything by looking at _startupGates
    return {
      btnExists: !!btn,
      bodyClass: document.body.className,
      splashGated: typeof _startupGates !== 'undefined' ? _startupGates.splash : 'no _startupGates',
    };
  });
  console.log('    probe: ' + JSON.stringify(btnHasClick));

  // Click skip via evaluate to avoid Playwright hitting the video element.
  await p.evaluate(() => {
    const btn = document.getElementById('splashSkipBtn');
    if (btn) btn.click();
  });

  // After skip click, the splash should start fading.
  await p.waitForFunction(() => {
    const el = document.getElementById('splashScreen');
    return !el || el.classList.contains('is-dismissing');
  }, { timeout: 10000 });

  console.log('    splash dismissed via skip button');
}, 'splash skip button is clickable');

// Test 3: Main UI reachable and responsive after splash dismiss
await withPage(async (p, log) => {
  await p.goto(SERVER, { waitUntil: 'domcontentloaded', timeout: 15000 });

  // Dismiss the first-run disclaimer if it appears.
  try {
    var dcb = await p.waitForSelector('#disclaimerAgreeCheck', { state: 'visible', timeout: 5000 });
    await dcb.click();
    await p.click('#disclaimerAgreeBtn');
    console.log('    disclaimer dismissed');
  } catch (_) {}

  // Dismiss the splash.
  await p.waitForSelector('#splashSkipBtn', { state: 'visible', timeout: 8000 });
  await p.evaluate(() => {
    const btn = document.getElementById('splashSkipBtn');
    if (btn) btn.click();
  });
  await p.waitForFunction(() => {
    const el = document.getElementById('splashScreen');
    return !el || el.classList.contains('is-dismissing');
  }, { timeout: 10000 });

  // After splash, main UI should be clickable.
  const genBtn = await p.waitForSelector('#generateWalletBtn', { state: 'visible', timeout: 8000 });
  assert(genBtn, 'Generate Wallet button not visible after splash dismiss');
  console.log('    main UI reachable after splash dismiss');

  await genBtn.click();
  const walletInfo = await p.waitForSelector('#walletInfo', { state: 'visible', timeout: 10000 });
  assert(walletInfo, 'wallet info not visible after Generate Wallet click');
  console.log('    wallet generation responded to click');
}, 'main UI responsive after splash');

// Test 4: No fetch() calls fire during initial script evaluation
await withPage(async (p, log) => {
  // Inject a fetch probe before the page loads.
  await p.addInitScript(() => {
    window.__fetchTimestamps = [];
    var origFetch = window.fetch;
    window.fetch = function () {
      var input = arguments[0];
      window.__fetchTimestamps.push({
        url: typeof input === 'string' ? input : (input && input.url) || 'unknown',
        ms: performance.now(),
        documentState: document.readyState,
      });
      return origFetch.apply(this, arguments);
    };
  });

  await p.goto(SERVER, { waitUntil: 'domcontentloaded', timeout: 15000 });

  // Dismiss the first-run disclaimer if it appears.
  try {
    var dcb = await p.waitForSelector('#disclaimerAgreeCheck', { state: 'visible', timeout: 5000 });
    await dcb.click();
    await p.click('#disclaimerAgreeBtn');
    console.log('    disclaimer dismissed');
  } catch (_) {}

  // Dismiss the splash.
  await p.waitForSelector('#splashSkipBtn', { state: 'visible', timeout: 8000 });
  await p.evaluate(() => {
    var btn = document.getElementById('splashSkipBtn');
    if (btn) btn.click();
  });
  await p.waitForFunction(() => {
    var el = document.getElementById('splashScreen');
    return !el || el.classList.contains('is-dismissing');
  }, { timeout: 10000 });

  // Wait for deferred fetches to fire.
  await p.waitForTimeout(2000);

  var timestamps = await p.evaluate(() => window.__fetchTimestamps);
  var duringLoading = timestamps.filter(function(t) { return t.documentState === 'loading'; });
  var afterLoading = timestamps.filter(function(t) { return t.documentState !== 'loading'; });

  console.log('    fetch calls during loading: ' + duringLoading.length);
  console.log('    fetch calls after loading:  ' + afterLoading.length);

  for (var i = 0; i < duringLoading.length; i++) {
    console.log('      DURING LOAD: ' + duringLoading[i].url + ' at ' + duringLoading[i].ms.toFixed(0) + 'ms');
  }

  assert(
    duringLoading.length <= 1,
    duringLoading.length + ' fetch() calls fired during document loading — ' +
    'at most 1 (session token) is acceptable; more indicates a race risk'
  );
}, 'no fetch() calls during script evaluation');

// Teardown
await browser.close();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
