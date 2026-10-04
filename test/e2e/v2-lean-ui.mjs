#!/usr/bin/env node
// Lean launch view in a real browser, against the real local server.
//
// The draft, estimate and save paths hit the real routes. Only what a plain Node
// server cannot have is mocked: a managed wallet (it needs the desktop keychain),
// its balance, and the server-side run states (running, failed, completed) that
// need a chain. The chain itself is covered by test/e2e/v2-damm-localnet.mjs.
//
//   npm run test:e2e:lean:ui

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const configDir = mkdtempSync(path.join(tmpdir(), 'trebuchet-lean-ui-'));
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

const WALLET = '9smSZZnWGk3MLFpKcNNwqdHCBFXBmgjSi9rAP9uYMPbm';
const MINT = 'RUGx1zSD7LCVqFgTYQWNiJKSkDcfN3yRR5XoFoAXRUG';
const POOL = '22n8WsD5Rx544gqg4DjzQDJhgzMDG9Bb2CQAAxFwAKst';
const POSITION = 'E6sk5u6qieULexDRugJajGoezamFe4AahSxMBct5oXQz';
const NFT = '9u7b8fQsJqvSdADwxbjT1fp8AvpwZ2kNChHzo7zvhAhC';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) problems.push(message.text()); });

let balance = 0.05;
await page.route(/\/api\/v2\/wallets$/, (route) => route.fulfill({ json: { success: true, wallets: [
  { publicKey: WALLET, hasSecretKey: true, decryptionFailed: false, label: 'Launch wallet' },
  { publicKey: 'AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j', hasSecretKey: false, decryptionFailed: true, label: 'Old wallet' },
] } }));
await page.route(/\/api\/check-balance$/, (route) => route.fulfill({ json: { success: true, balance } }));

const text = () => page.evaluate(() => document.querySelector('#leanRoot')?.innerText || '');
const open = async () => {
  await page.goto(`${base}/v2/`);
  await page.waitForSelector('#view-coins [data-view="lean"]');
  await page.click('#view-coins [data-view="lean"]');
  await page.waitForSelector('#leanRoot .nft-shell');
};
const steps = [];
const check = (label, condition, detail = '') => { assert.ok(condition, `${label}${detail ? ` (${detail})` : ''}`); steps.push(label); };

// ---- the draft path, on the real routes ----------------------------------------------------------
await open();
let t = await text();
check('Coins stays highlighted and the view can go back to it', (await page.$eval('.nav-item.is-active', (el) => el.dataset.view)) === 'coins' && Boolean(await page.$('#leanRoot [data-view="coins"]')));
check('the header says what the venue saves before anything is typed', /\d+% less/.test(t), (t.match(/(\d+)% less/) || [])[0]);
check('only a wallet that can sign is offered', (await page.$$eval('[data-lean-field="walletPublicKey"] option', (o) => o.length)) === 1);
await page.fill('[data-lean-field="name"]', 'Trebuchet');
await page.fill('[data-lean-field="symbol"]', 'treb');
await page.waitForFunction(() => /Most this can spend/.test(document.querySelector('#leanRoot')?.innerText || ''));
t = await text();
check('the estimate has cost lines, no SOL seed and the lock stated', /SOL put into the pool\s+0\.0000 SOL/.test(t) && /locked permanently/.test(t));
check('the estimate has depth and fresh-buy tables', /To push the price to/.test(t) && /A fresh buy of/.test(t));
check('an underfunded wallet is told how much to send', /Send at least/.test(t));
check('Launch stays off before saving and approving', await page.isDisabled('[data-lean-action="run"]'));
await page.click('[data-lean-action="save"]');
await page.waitForFunction(() => /Saved\./.test(document.querySelector('#leanRoot')?.innerText || ''));
await page.check('[data-lean-field="approved"]');
check('Launch stays off while the wallet is short of funds', await page.isDisabled('[data-lean-action="run"]'));
balance = 1;
await page.click('[data-lean-action="balance"]');
await page.waitForFunction(() => !/Send at least/.test(document.querySelector('#leanRoot')?.innerText || ''));
await page.check('[data-lean-field="approved"]').catch(() => {});
check('Launch turns on once saved, approved and funded', !(await page.isDisabled('[data-lean-action="run"]')));
await page.fill('[data-lean-field="supply"]', '2000000000');
check('editing after approving takes the approval back and asks for a save', (await page.isDisabled('[data-lean-action="run"]')) && /Save your changes/.test(await text()));
await page.fill('[data-lean-field="supply"]', '1000000000');
await page.click('[data-lean-action="save"]');
await page.waitForFunction(() => /Saved\./.test(document.querySelector('#leanRoot')?.innerText || ''));
await page.check('[data-lean-field="approved"]');
await page.click('[data-lean-action="run"]');
await page.waitForFunction(() => /not a Trebuchet-managed wallet/.test(document.querySelector('#leanRoot')?.innerText || ''));
check('a refused launch says why, in plain words', true);
const draft = await (await fetch(`${base}/api/session`)).json();
const list = await (await fetch(`${base}/api/v2/damm/launches`, { headers: { 'x-trebuchet-session': draft.token } })).json();
const id = list.launches[0].id;
check('exactly one draft was saved', list.launches.length === 1 && list.launches[0].status === 'draft');

// ---- the run states, from mocked server records ------------------------------------------------
const record = (over) => ({
  id, status: 'draft', walletPublicKey: WALLET, hasLogo: false, positionNftSaved: false, error: null, events: [], job: { running: false },
  config: { token: { name: 'Trebuchet', symbol: 'TREB', supply: '1000000000', description: '', decimals: 9 }, pool: { startingMarketCapUsd: 250000, rangeMultiple: 1000, feeBps: 25 }, destination: null, vanity: { selectedPublicKey: null } },
  steps: { token: null, pool: null, keyTransfer: null },
  summary: { id, name: 'Trebuchet', symbol: 'TREB', status: 'draft', walletPublicKey: WALLET },
  estimate: null,
  ...over,
});
const estimate = await (await fetch(`${base}/api/v2/damm/estimate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-trebuchet-session': draft.token }, body: JSON.stringify({ config: { token: { name: 'Trebuchet', symbol: 'TREB' } } }) })).json();
const tokenDone = { complete: true, mint: MINT, mintAuthorityRenounced: true, freezeAuthorityDisabled: true, metadataImmutable: true };
const poolDone = { complete: true, pool: POOL, position: POSITION, positionNft: NFT, startMarketCapSol: 2084.6, solUsd: 119.92, verification: { passed: true, permanentlyLocked: true } };
let current = record({ estimate: estimate.estimate });
await page.route(/\/api\/v2\/damm\/launches$/, (route) => route.fulfill({ json: { success: true, launches: current.status === 'draft' ? [] : [{ ...current.summary, status: current.status, job: current.job }] } }));
await page.route(new RegExp(`/api/v2/damm/launches/${id}$`), (route) => route.fulfill({ json: { success: true, launch: current } }));
await page.route(new RegExp(`/api/v2/damm/launches/${id}/job$`), (route) => route.fulfill({ json: { success: true, job: current.job, status: current.status, steps: current.steps, events: current.events, error: current.error } }));
let fees = { success: true, holder: WALLET, position: {}, unclaimedSol: 0.012345 };
await page.route(new RegExp(`/api/v2/damm/launches/${id}/fees$`), (route) => route.fulfill({ json: fees }));
let claimed = 0;
await page.route(new RegExp(`/api/v2/damm/launches/${id}/claim$`), (route) => { claimed += 1; fees = { ...fees, unclaimedSol: 0 }; route.fulfill({ json: { success: true, signature: 'sig', receivedSol: 0.010345 } }); });

current = record({ status: 'running', job: { running: true, stage: 'damm_pool_created' }, steps: { token: tokenDone, pool: null, keyTransfer: null }, estimate: estimate.estimate });
await open();
t = await text();
check('a running launch shows the token done and the pool in progress', /Create the locked pool/.test(t) && /Keep Trebuchet open/.test(t) && /Verified|Waiting/.test(t));
check('a running launch has no way to edit or launch again', !(await page.$('[data-lean-action="run"]')) && !(await page.$('[data-lean-field="name"]')));

current = record({ status: 'failed', error: 'A pool for this token already exists, and it is not this launch\'s position. Nothing was created.', steps: { token: tokenDone, pool: null, keyTransfer: null }, estimate: estimate.estimate });
await open();
t = await text();
check('a failed launch shows the real error and that finished steps are kept', /Nothing was created/.test(t) && /will not create a second pool/.test(t));
check('a failed launch offers Run again', Boolean(await page.$('[data-lean-action="run"]')));

current = record({ status: 'completed', steps: { token: tokenDone, pool: poolDone, keyTransfer: null }, events: [{ stage: 'damm_pool_created', txId: 'sig1' }, { stage: 'launch_complete' }], estimate: estimate.estimate });
await open();
await page.waitForFunction(() => /Unclaimed/.test(document.querySelector('#leanRoot')?.innerText || ''));
t = await text();
check('a completed launch shows the token, pool, position and Fee Key', /Token/.test(t) && /Position/.test(t) && /Fee Key \(position NFT\)/.test(t));
check('a completed launch states what is true about it', /Locked for good\s+Yes/.test(t) && /Mint authority\s+Renounced/.test(t) && /Freeze authority\s+Off/.test(t));
check('the unclaimed SOL fees are shown', /0\.012345 SOL/.test(t));
const links = await page.$$eval('#leanRoot a[href^="https://solscan.io/"]', (a) => a.map((x) => x.getAttribute('href')));
check('addresses link to the explorer', links.some((href) => href.endsWith(`/token/${MINT}`)) && links.some((href) => href.endsWith(`/account/${POOL}`)));
await page.click('[data-lean-action="claim"]');
await page.waitForFunction(() => /Claimed 0\.010345 SOL/.test(document.querySelector('#leanRoot')?.innerText || ''));
check('claiming calls the claim route once and shows what came back', claimed === 1);
check('after claiming, nothing is left to claim', await page.isDisabled('[data-lean-action="claim"]'));

check('no JavaScript errors', problems.length === 0, problems.slice(0, 2).join(' || '));
await browser.close();
stop();
for (const step of steps) console.log(`ok  ${step}`);
console.log(`\nLean launch view: ${steps.length} checks passed`);
process.exit(0);
