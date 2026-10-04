#!/usr/bin/env node
// A locked Recovery PIN must always be one click from the PIN screen, even when the
// first saved wallet's key is gone. Real server, real PIN routes. Only the wallet
// list is mocked, because a plain Node server has no desktop keychain.
//
//   npm run test:e2e:pin-gate

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const configDir = mkdtempSync(path.join(tmpdir(), 'trebuchet-pin-gate-'));
const port = await new Promise((resolve, reject) => {
  const socket = net.createServer();
  socket.unref();
  socket.on('error', reject);
  socket.listen(0, '127.0.0.1', () => { const { port: free } = socket.address(); socket.close(() => resolve(free)); });
});
const base = `http://127.0.0.1:${port}`;
writeFileSync(path.join(configDir, 'userPrefs.json'), JSON.stringify({ demoMode: false }));

const server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), TREBUCHET_CONFIG_DIR: configDir }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (chunk) => { log += chunk; });
server.stderr.on('data', (chunk) => { log += chunk; });
const stop = () => server.kill('SIGTERM');
process.on('exit', stop);
for (let i = 0; ; i += 1) {
  try { if ((await fetch(`${base}/v2/`)).ok) break; } catch { /* starting */ }
  if (i > 120) { console.error(log.slice(-2000)); throw new Error('server did not start'); }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const token = (await (await fetch(`${base}/api/session`)).json()).token;
const call = async (method, route, body) => (await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', 'x-trebuchet-session': token }, body: body ? JSON.stringify(body) : undefined })).status;
assert.equal(await call('POST', '/api/secret-pin/setup', { pin: '4321' }), 200);
assert.equal(await call('POST', '/api/secret-pin/lock', {}), 200);

const GONE = 'AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j';
const LOCKED = '9smSZZnWGk3MLFpKcNNwqdHCBFXBmgjSi9rAP9uYMPbm';
const steps = [];
const check = (label, condition, detail = '') => { assert.ok(condition, `${label}${detail ? ` (${detail})` : ''}`); steps.push(label); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) problems.push(message.text()); });
// The key-gone wallet is listed first, which is what used to get selected.
await page.route(/\/api\/v2\/wallets$/, (route) => route.fulfill({ json: { success: true, wallets: [
  { publicKey: GONE, hasSecretKey: false, decryptionFailed: true, secretState: 'missing', label: 'Old wallet' },
  { publicKey: LOCKED, hasSecretKey: false, decryptionFailed: false, secretPinLocked: true, secretState: 'locked', label: 'Launch wallet' },
] } }));
await page.route(/\/api\/check-balance$/, (route) => route.fulfill({ json: { success: true, balance: 0 } }));

await page.goto(`${base}/v2/`);
await page.waitForSelector('#recoveryPinGate:not([hidden])', { timeout: 15000 });
check('the PIN screen opens by itself when the PIN is locked', true);
check('the PIN screen asks for the PIN', /Unlock Recovery PIN/.test(await page.innerText('#recoveryPinTitle')));
await page.click('#recoveryPinCancel');
await page.waitForSelector('#recoveryPinGate', { state: 'hidden' });
check('the PIN screen can be closed', true);
check('a wallet that still has a key is selected over the key-gone one', (await page.evaluate(() => state.selectedWalletPublicKey)) === LOCKED);

// Force the bad selection (the key-gone wallet): the unlock button must still be there.
await page.evaluate((gone) => { state.selectedWalletPublicKey = gone; state.accountId = gone; }, GONE);
await page.click('[data-view="wallet"]');
await page.waitForSelector('#view-wallet [data-action="unlock-secret-pin"]:not([disabled])', { timeout: 5000 });
check('Wallet offers an enabled Unlock PIN even when the selected key is gone', true);
await page.click('#view-wallet [data-action="unlock-secret-pin"]');
await page.waitForSelector('#recoveryPinGate:not([hidden])');
check('clicking Unlock PIN on Wallet shows the PIN screen', true);
await page.click('#recoveryPinCancel');
await page.waitForSelector('#recoveryPinGate', { state: 'hidden' });

// Every screen that tells the user to unlock the PIN must have a working button on that same screen.
const views = [...new Set([...(await page.$$eval('.nav-item[data-view]', (items) => items.map((item) => item.dataset.view))), 'launch', 'lean'])];
for (const view of views) {
  await page.evaluate((v) => (document.querySelector(`.nav-item[data-view="${v}"]`) || document.querySelector(`[data-view="${v}"]`))?.click(), view);
  await page.waitForTimeout(300);
  const result = await page.evaluate(() => {
    const visible = [...document.querySelectorAll('main section, main .view')].filter((el) => el.offsetParent !== null);
    const text = visible.map((el) => el.innerText).join('\n');
    const says = /unlock (the |your )?(recovery |secrets? )?pin/i.test(text);
    const button = visible.some((el) => el.querySelector('[data-action="unlock-secret-pin"]:not([disabled])'));
    return { says, button };
  });
  check(`${view}: any "unlock the PIN" message has an Unlock PIN button`, !result.says || result.button);
}

check('no JavaScript errors', problems.length === 0, problems.slice(0, 2).join(' || '));
await browser.close();
stop();
for (const step of steps) console.log(`ok  ${step}`);
console.log(`\nPIN gate: ${steps.length} checks passed`);
process.exit(0);
