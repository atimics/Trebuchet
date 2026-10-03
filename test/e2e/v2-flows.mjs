#!/usr/bin/env node
// API-backed Trebuchet browser smoke.
//
// Unlike the file:// viewport proof, this boots the real local Express app,
// lets the Trebuchet client establish its authenticated API session, creates a
// Trebuchet-managed demo wallet, verifies the secure import dialog, and runs
// the complete demo token/liquidity/sweep contract.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { Keypair } from '@solana/web3.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const configDir = mkdtempSync(path.join(tmpdir(), 'trebuchet-v2-e2e-'));
const returnWalletAddress = Keypair.generate().publicKey.toBase58();
const port = await new Promise((resolve, reject) => {
  const socket = net.createServer();
  socket.unref();
  socket.on('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const address = socket.address();
    socket.close(() => resolve(address.port));
  });
});
const baseUrl = `http://127.0.0.1:${port}`;

writeFileSync(path.join(configDir, 'userPrefs.json'), JSON.stringify({
  demoMode: true,
  playIntroVideo: false,
  playSoundEffects: false,
  playBackgroundMusic: false,
  coinPreview: false,
}, null, 2));

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    TREBUCHET_CONFIG_DIR: configDir,
    DEMO_TIME_SCALE: '0.01',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';
let serverExited = null;
const collectServerOutput = (chunk) => {
  serverOutput += chunk.toString();
  if (serverOutput.length > 30_000) serverOutput = serverOutput.slice(-30_000);
};
server.stdout.on('data', collectServerOutput);
server.stderr.on('data', collectServerOutput);
server.on('exit', (code, signal) => {
  serverExited = { code, signal };
});

// The first server import loads the Solana/Raydium dependency graph. Cold CI
// workers and busy developer machines can legitimately need more than 20s
// before the loopback listener is ready, so keep the smoke deterministic
// without weakening any of its readiness assertions.
async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (serverExited) {
      throw new Error(`v2 E2E server exited early (${JSON.stringify(serverExited)})\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/session`);
      const body = await response.json();
      if (response.ok && body?.token) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`v2 E2E server did not start: ${lastError?.message || 'timeout'}\n${serverOutput}`);
}

async function stopServer() {
  if (serverExited) return;
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (!serverExited) server.kill('SIGKILL');
}

let browser = null;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  const consoleErrors = [];
  const nativeDialogs = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('dialog', async (dialog) => {
    nativeDialogs.push(`${dialog.type()}: ${dialog.message()}`);
    await dialog.dismiss();
  });

  await page.goto(`${baseUrl}/v2/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => (
    document.body.dataset.apiStatus === 'connected'
    && document.querySelector('#networkLabel')?.textContent?.trim() === 'Nothing is sent'
  ), null, { timeout: 30_000 });
  assert.equal(new URL(page.url()).pathname, '/v2/');

  const session = await page.evaluate(async () => {
    const response = await fetch('/api/session');
    return response.json();
  });
  assert.equal(session.success, true);
  assert.ok(session.token, 'Trebuchet did not receive a local API session token');

  // Coins come first: the app opens on the coin list, and creating a token
  // is an action on a coin. No separate guided mode.
  assert.equal(await page.getAttribute('body', 'data-experience-mode'), null);
  await page.waitForSelector('#view-coins.is-active');
  assert.equal(await page.locator('[data-view="launch"]').count(), 0, 'Launch is back in the navigation');
  await page.waitForSelector('.sidebar', { state: 'visible' });
  await page.click('[data-view="wallet"]');
  await page.waitForSelector('#view-wallet.is-active');
  await page.click('#newVaultButton');
  await page.waitForSelector('#accountList .account-row', { timeout: 20_000 });
  const fundingAddress = (await page.textContent('#walletDetailPanel code'))?.trim() || '';
  assert.match(fundingAddress, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

  await page.evaluate(() => {
    const publicKey = selectedLaunchWalletPublicKey();
    state.secretPin = { ...state.secretPin, configured: true, locked: true, unlocked: false };
    state.managedWallets = state.managedWallets.map((wallet) => (
      wallet.publicKey === publicKey ? { ...wallet, secretPinLocked: true } : wallet
    ));
    renderAll();
  });
  assert.match(await page.getAttribute('#walletButton', 'aria-label'), /Unlock .* Recovery PIN/i);
  await page.click('#walletButton');
  await page.waitForSelector('#recoveryPinGate:not([hidden])');
  assert.match(await page.locator('#recoveryPinGate').innerText(), /Enter Recovery PIN/i);
  await page.click('#recoveryPinCancel');
  await page.waitForSelector('#recoveryPinGate', { state: 'hidden' });
  await page.evaluate(() => {
    const publicKey = selectedLaunchWalletPublicKey();
    state.secretPin = { ...state.secretPin, configured: false, locked: false, unlocked: true };
    state.managedWallets = state.managedWallets.map((wallet) => (
      wallet.publicKey === publicKey ? { ...wallet, secretPinLocked: false } : wallet
    ));
    renderAll();
  });

  await page.click('[data-action="import-wallet"]');
  await page.waitForSelector('#operatorPromptGate:not([hidden])');
  assert.equal(await page.getAttribute('#operatorPromptInput', 'type'), 'password');
  const sentinelSecret = 'never-persist-this-e2e-secret';
  await page.fill('#operatorPromptInput', sentinelSecret);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#operatorPromptGate', { state: 'hidden' });
  assert.equal(await page.inputValue('#operatorPromptInput'), '');
  assert.doesNotMatch(await page.locator('body').innerText(), new RegExp(sentinelSecret));

  await page.click('.nav-item[data-view="history"]');
  await page.waitForSelector('#view-history.is-active');
  await page.focus('#historyTabRecovery');
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector('#historyPanelWallets:not([hidden])');
  assert.equal(await page.getAttribute('#historyTabWallets', 'aria-selected'), 'true');
  assert.equal(await page.getAttribute('#historyTabRecovery', 'tabindex'), '-1');
  await page.keyboard.press('End');
  await page.waitForSelector('#historyPanelJournal:not([hidden])');
  assert.equal(await page.getAttribute('#historyTabJournal', 'aria-selected'), 'true');

  await page.click('.nav-item[data-view="coins"]');
  await page.click('[data-action="new-coin"]');
  await page.waitForSelector('#view-launch.is-active');
  assert.equal(await page.getAttribute('body', 'data-launch-workspace'), 'mint');
  assert.match(await page.locator('#viewTitle').innerText(), /New coin/i);
  assert.match(await page.locator('#viewEyebrow').innerText(), /Coins/i);
  assert.equal(await page.getAttribute('.nav-item.is-active', 'data-view'), 'coins', 'A coin being created is still under Coins');
  await page.click('.coin-fact[data-coin-fact="wallet"]');
  await page.waitForFunction(() => document.body.dataset.launchWorkspace === 'wallet');
  assert.deepEqual(await page.evaluate(() => (
    [...document.querySelectorAll('[data-classic-workspace]')]
      .filter((panel) => !panel.hidden)
      .map((panel) => panel.dataset.classicWorkspace)
  )), ['wallet'], 'Phase 1 was not isolated before wallet selection');

  await page.click('.launch-wallet-choice');
  await page.waitForFunction(() => document.body.dataset.launchWorkspace === 'mint');
  assert.equal(await page.getAttribute('.coin-fact[data-coin-fact="mint"]', 'aria-pressed'), 'true');
  assert.match(await page.locator('#configureStepTitle').textContent(), /Token & pools/i);
  assert.deepEqual(await page.evaluate(() => (
    [...document.querySelectorAll('[data-classic-workspace]')]
      .filter((panel) => !panel.hidden)
      .map((panel) => panel.dataset.classicWorkspace)
  )), [], 'Classic phases leaked into Phase 2');

  // Funding has no row; the rail's Funding details link opens its panel.
  await page.evaluate(() => setLaunchWorkspace('fund'));
  await page.waitForFunction(() => document.body.dataset.launchWorkspace === 'fund');
  assert.match(await page.locator('#fundStepTitle').textContent(), /^Fund$/i);
  // Assets return to the wallet that funds the launch (or one that signs),
  // so estimating does not wait on a typed return wallet.
  // The only way on is the action the coin's facts ask for, never a "Continue".
  assert.equal(await page.locator('.classic-workspace-fund').getByText(/Continue/).count(), 0);
  assert.deepEqual(
    await page.evaluate(() => [...document.querySelectorAll('.classic-workspace-fund [data-next-fact]:not([hidden])')].map((button) => button.dataset.launchWorkspace)),
    await page.evaluate(() => (nextCoinFact()?.action && nextCoinFact().id !== 'fund' ? [nextCoinFact().id] : [])),
  );
  await page.click('.classic-workspace-fund [data-action="estimate-funding"]');
  // In test mode the estimate says no SOL is needed and links to the next
  // step; there is no deposit address to show.
  await page.waitForSelector('.classic-workspace-fund .funding-task .funding-receipt', { timeout: 30_000 });
  await page.evaluate(() => renderClassicBridge());
  assert.deepEqual(await page.evaluate(() => (
    [...document.querySelectorAll('[data-classic-workspace]')]
      .filter((panel) => !panel.hidden)
      .map((panel) => panel.dataset.classicWorkspace)
  )), ['fund'], 'An async funding refresh exposed multiple launch phases');
  assert.match(await page.locator('.classic-workspace-fund .funding-task').innerText(), /No SOL needed/i);
  assert.equal(await page.locator('.classic-workspace-fund .funding-task-address').count(), 0);
  // The only way on is the action the coin's facts ask for, never a "Continue".
  assert.equal(await page.locator('.classic-workspace-fund').getByText(/Continue/).count(), 0);
  assert.deepEqual(
    await page.evaluate(() => [...document.querySelectorAll('.classic-workspace-fund [data-next-fact]:not([hidden])')].map((button) => button.dataset.launchWorkspace)),
    await page.evaluate(() => (nextCoinFact()?.action && nextCoinFact().id !== 'fund' ? [nextCoinFact().id] : [])),
  );
  await page.evaluate(() => {
    const config = currentLaunchConfig();
    const walletPublicKey = selectedLaunchWalletPublicKey();
    state.demoActive = false;
    state.prefs.demoMode = false;
    state.managedWallets = state.managedWallets.map((wallet) => (
      wallet.publicKey === walletPublicKey
        ? { ...wallet, hasSecretKey: true, decryptionFailed: false }
        : wallet
    ));
    state.secretPin = { ...state.secretPin, configured: false, locked: false, unlocked: true };
    state.classicFundingEstimate = stampClassicFundingEstimate({
      totalSol: 0.46,
      autoSwapPlan: [],
      byQuote: {},
      quoteBreakdown: [],
    }, config);
    state.manualPrefund = {
      walletPublicKey,
      balance: { sol: 1, tokens: {} },
      polling: false,
      error: null,
      lastUpdatedAt: new Date().toISOString(),
    };
    state.executionReadiness = {
      status: 'ready',
      nextAction: 'Create token',
      nextEndpoint: '/api/create-token',
      blockers: [],
      warnings: [],
      phases: [],
    };
    state.lastRunEnvelope = null;
    applyLaunchPlan(fallbackLaunchPlan(), config, { openApproval: false });
    state.launchWorkspace = 'mint';
    state.phaseSlide = { ...(state.phaseSlide || {}), mint: 'run' };
    renderAll();
  });
  await page.waitForFunction(() => document.body.dataset.launchWorkspace === 'mint');
  const mintWorkspace = page.locator('[data-classic-workspace="mint"]');
  assert.match(await mintWorkspace.innerText(), /Review this launch/i);
  assert.match(await mintWorkspace.textContent(), /Review launch/i);
  assert.doesNotMatch(await mintWorkspace.innerText(), /\/api\/create-token/i);

  // The unnamed token comes first: the rail asks for the name, and shows no second action button.
  assert.match(await page.locator('#launchNextRail .rail-act').innerText(), /Name the token/i);
  // The pane keeps its own (hidden) button as the handler; the rail is the visible one.
  await page.evaluate(() => document.querySelector('[data-classic-workspace="mint"] [data-action="review-and-arm-run"]').click());
  await page.waitForSelector('#approvalFloating.is-open');
  assert.match(await page.locator('#approvalFloating').innerText(), /Review before creating/i);
  assert.match(await page.locator('#approvalFloating').innerText(), /Approving sends nothing/i);
  assert.match(await page.locator('#approvalFloating').innerText(), /Approve/);
  await page.click('[data-action="close-approval"]');
  await page.evaluate(() => {
    state.lastRunEnvelope = { id: 'phase-4-e2e-envelope', status: 'armed' };
    renderAll();
  });
  await page.waitForSelector('[data-classic-workspace="mint"] [data-action="execute-next-run"]', { state: 'attached' });
  assert.match(
    await page.locator('[data-classic-workspace="mint"] [data-action="execute-next-run"]').textContent(),
    /Create token/i,
  );

  await page.evaluate(() => {
    state.lastRunEnvelope = null;
    state.executionReadiness = {
      ...state.executionReadiness,
      nextAction: 'Finish interrupted token',
      nextEndpoint: '/api/finish-token-creation',
      completion: {
        ...(state.executionReadiness?.completion || {}),
        tokenCreated: false,
        tokenNeedsFinish: true,
      },
      phases: (state.executionReadiness?.phases || []).map((phase) => (
        phase.id === 'token'
          ? { ...phase, title: 'Finish token', endpoint: '/api/finish-token-creation', state: 'ready' }
          : phase
      )),
    };
    renderAll();
  });
  assert.match(await mintWorkspace.innerText(), /Finish interrupted token/i);
  assert.match(await mintWorkspace.textContent(), /Finish interrupted token safely/i);
  assert.doesNotMatch(await mintWorkspace.innerText(), /Resume missing work/i);

  await page.evaluate(() => {
    state.lastRunEnvelope = null;
    state.executionReadiness = null;
    state.transactions = [];
    state.demoActive = true;
    state.prefs.demoMode = true;
    state.launchWorkspace = 'mint';
    state.phaseSlide = { ...(state.phaseSlide || {}), mint: 'details' };
    renderAll();
  });

  // Practice launch through the same six phases a live launch uses.
  await page.click('.coin-fact[data-coin-fact="mint"]');
  await page.click('[data-plan-tab="details"]');
  await page.fill('#tokenName', 'First Launch');
  await page.fill('#tokenSymbol', 'FIRST');
  await page.setInputFiles(
    '#tokenLogoFile',
    path.join(root, 'public', 'release-assets', 'frames', 'f01.png'),
  );
  // Where assets go: hold back 10%, then share it with both funding wallets.
  // Holding back 10% shrinks the SOL pool to 90%, so the split stays at 100%.
  await page.evaluate(() => {
    const input = document.querySelector('#preallocationSupplyPercent');
    input.value = '10';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector('#mainPoolPercent').value === '90');
  // Where assets go is its own slide of the Plan row.
  await page.click('.coin-fact[data-coin-fact="wallet"]');
  await page.click('[data-plan-tab="return"]');
  assert.match(await page.locator('#returnWalletCard').innerText(), /Funding wallets show here once SOL arrives/);
  await page.evaluate(async () => {
    const session = await (await fetch('/api/session')).json();
    await fetch('/api/demo/inject-funds', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}`, 'x-trebuchet-session': session.token },
      body: JSON.stringify({ publicKey: selectedLaunchWalletPublicKey(), sol: 2 }),
    });
    await refreshDestinations({ force: true });
  });
  const shareBoxes = page.locator('#returnWalletCard input[data-action="toggle-held-share"]');
  assert.equal(await shareBoxes.count(), 2, 'Both practice funders should be listed');
  assert.equal(await shareBoxes.nth(0).isChecked(), false, 'No funder is ticked by default');
  await shareBoxes.nth(0).click();
  await shareBoxes.nth(1).click();
  const shared = await page.evaluate(() => currentAirdropPlan().recipients.map((row) => row.tokens));
  assert.deepEqual(shared, [70_000_000, 30_000_000], 'Held-back tokens are not split by SOL sent');

  await page.click('.coin-fact[data-coin-fact="mint"]');
  await page.click('[data-plan-tab="run"]');
  // The rail's one button runs the whole test launch.
  assert.match(await page.locator('#launchNextRail .rail-act').innerText(), /test launch/i);
  await page.click('#launchNextRail [data-action="launch-rail-act"]');
  await page.waitForFunction(() => document.body.dataset.launchWorkspace === 'finish', null, { timeout: 60_000 });
  const finishText = await page.locator('[data-classic-workspace="finish"]').innerText();
  assert.match(finishText, /Test launch complete/i);
  assert.match(finishText, /Nothing was sent/i);
  assert.match(finishText, /SOL spent\s*0/i);
  assert.match(finishText, /Switch to live/i);
  assert.doesNotMatch(finishText, /Needs proof/i, 'Practice result showed live proof requirements');
  const delivered = await page.evaluate(() => (state.lastDemoLaunchRun?.transfer?.airdrop?.transferred || []).map((row) => row.tokens));
  assert.deepEqual(delivered, [70_000_000, 30_000_000], 'Practice run did not airdrop the shared tokens');

  // Add buy support to an existing pool (practice plans against a sample pool).
  await page.evaluate(async () => {
    const session = await (await fetch('/api/session')).json();
    await fetch('/api/demo/inject-funds', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}`, 'x-trebuchet-session': session.token },
      body: JSON.stringify({ publicKey: selectedLaunchWalletPublicKey(), sol: 1 }),
    });
  });
  // The practiced coin is listed under Coins with its own page; buy support
  // is an action there.
  await page.click('#viewEyebrow [data-action="coins-back"]');
  await page.click('.coin-card-ui:has-text("Test coin")');
  await page.waitForSelector('#view-coins.is-active #coinPage:not([hidden])');
  await page.waitForSelector('#poolSupportPanel:not([hidden])');
  await page.fill('#poolSupportSol', '0.1');
  await page.click('[data-action="preview-pool-support"]');
  await page.waitForSelector('.pool-support-plan');
  const supportPlanText = await page.locator('#poolSupportResult').innerText();
  assert.match(supportPlanText, /Cheapest elsewhere/i);
  assert.match(supportPlanText, /never returned/i);
  await page.click('[data-action="open-pool-support"]');
  await page.waitForSelector('#operatorPromptGate:not([hidden])');
  assert.match(await page.locator('#operatorPromptGate').innerText(), /ADD SUPPORT/);
  await page.fill('#operatorPromptInput', 'ADD SUPPORT');
  await page.click('#operatorPromptSubmit');
  await page.waitForSelector('.pool-support-done');

  // The support is now a position the coin page lists; withdraw it.
  await page.waitForSelector('.coin-positions [data-action="withdraw-coin-position"]');
  assert.equal(await page.locator('.coin-positions li').count(), 1);
  await page.click('.coin-positions [data-action="withdraw-coin-position"]');
  await page.waitForSelector('#operatorPromptGate:not([hidden])');
  assert.match(await page.locator('#operatorPromptGate').innerText(), /WITHDRAW/);
  await page.fill('#operatorPromptInput', 'WITHDRAW');
  await page.click('#operatorPromptSubmit');
  await page.waitForFunction(() => document.querySelectorAll('.coin-positions li').length === 0, null, { timeout: 30_000 });
  await page.waitForFunction(() => /Position withdrawn/.test(document.querySelector('.coin-activity')?.textContent || ''), null, { timeout: 30_000 });
  assert.equal(await page.locator('[data-action="read-coin-evidence"]').count(), 0, 'Practice coins explain how to inspect a live coin');

  // Public evidence stays usable when a lock scan has only partial coverage.
  const evidenceMint = 'RUGx1zSD7LCVqFgTYQWNiJKSkDcfN3yRR5XoFoAXRUG';
  const evidence = {
    schema: 'trebuchet-market-evidence/v1', mint: evidenceMint, network: 'mainnet', inspectedAt: '2026-09-28T07:00:00Z',
    holderSample: null, holderError: 'Holder RPC needs another try',
    feeRights: 'Trading fees accrue to the current Fee Key holder.', flywheel: 'Static pool allocation. Fee routing is a planned feature.',
    poolCoverage: { requested: 1, inspected: 1 }, pools: [{
      poolId: '2SV3NWgJes9mHkWdBeuHFg8kNqfJS1XQKtNb1eJStVDC',
      token: { mint: evidenceMint, amount: '300000000000000000', decimals: 9 },
      quote: { mint: 'So11111111111111111111111111111111111111112', amount: '427512764', decimals: 9 },
      locks: [], lockStatus: 'unavailable', lockError: 'Lock RPC needs another try',
    }],
  };
  await page.route(`**/api/v2/coins/${evidenceMint}`, (route) => route.fulfill({ json: { success: true, coin: { mint: evidenceMint, info: { name: 'RUGOWEEN', symbol: 'RUG' }, events: [], markets: { pools: [] } } } }));
  await page.route(`**/api/v2/coins/${evidenceMint}/positions`, (route) => route.fulfill({ json: { success: true, positions: [] } }));
  await page.route(`**/api/v2/coins/${evidenceMint}/evidence`, (route) => route.fulfill({ json: { success: true, evidence } }));
  let quotedAmount;
  await page.route(`**/api/v2/coins/${evidenceMint}/sell-quote`, (route) => {
    quotedAmount = route.request().postDataJSON().amount;
    return route.fulfill({ json: { success: true, quote: { amount: quotedAmount, outputLamports: '1234567', minimumLamports: '1222221', quotedAt: '2026-09-28T07:00:00Z', source: 'Raydium Trade API', scope: 'Route estimate at the quoted time.' } } });
  });
  await page.evaluate((mint) => openCoinByMint(mint), evidenceMint);
  await page.waitForSelector('[data-action="read-coin-evidence"]');
  await page.fill('#sellQuoteAmount', '1000.000000001');
  await page.click('[data-action="read-coin-evidence"]');
  await page.waitForSelector('[data-action="download-coin-evidence"]');
  assert.equal(await page.inputValue('#sellQuoteAmount'), '1000.000000001', 'A chain refresh preserves the exact typed amount');
  await page.click('.market-evidence-pool summary');
  assert.match(await page.locator('.market-evidence').innerText(), /0\.427512764 SOL/);
  assert.match(await page.locator('.market-evidence').innerText(), /Lock RPC needs another try/);
  await page.click('[data-action="quote-coin-sale"]');
  await page.waitForFunction(() => /0\.001234567 SOL/.test(document.querySelector('.market-sell-quote')?.textContent || ''));
  assert.equal(quotedAmount, '1000.000000001');
  const downloadEvent = page.waitForEvent('download');
  await page.click('[data-action="download-coin-evidence"]');
  const evidenceDownload = await downloadEvent;
  assert.deepEqual(JSON.parse(readFileSync(await evidenceDownload.path(), 'utf8')), evidence);
  assert.deepEqual(nativeDialogs, [], 'Trebuchet opened a native prompt/confirm dialog');
  // Pairs have their own ids even after a restore: one numbered past the count must not repeat.
  const pairIds = await page.evaluate(() => {
    const pair = (id, symbol, mint) => ({ id, quoteToken: mint, quoteMint: mint, quoteSymbol: symbol, supplyPercent: 5, ammConfigIndex: 5, distribution: [{ sharePercent: 100 }], ladder: { mode: 'off' }, support: { mode: 'off' }, startPricePremiumPct: 25 });
    const config = JSON.parse(JSON.stringify(currentLaunchConfig()));
    config.poolTopology.pools = [config.poolTopology.pools[0],
      pair('custom-pool-2', 'RUG', 'RUGx1zSD7LCVqFgTYQWNiJKSkDcfN3yRR5XoFoAXRUG'),
      pair('custom-pool-3', 'DGU', '7AL5rfx4Jf1DLFzZpQEPHkmR9BJjpcmWwne1f9xqfmTu')];
    restoreLaunchConfigFromJournal({ launchConfig: config });
    addCustomPool({ mint: 'J1bZFRAFC8ALqAN7ktkcCpobgoeTGfP5Xh1BwCP1oqoj', name: 'XLRT', symbol: 'XLRT' });
    const ids = state.customPools.map((pool) => pool.id);
    // A saved launch that already repeats an id is repaired on restore.
    config.poolTopology.pools.push(pair('custom-pool-3', 'DUP', 'J1bZFRAFC8ALqAN7ktkcCpobgoeTGfP5Xh1BwCP1oqoj'));
    restoreLaunchConfigFromJournal({ launchConfig: config });
    return { ids, repaired: state.customPools.map((pool) => pool.id) };
  });
  assert.equal(new Set(pairIds.ids).size, pairIds.ids.length, `pairs share an id: ${pairIds.ids}`);
  assert.equal(new Set(pairIds.repaired).size, pairIds.repaired.length, `restore kept a repeated id: ${pairIds.repaired}`);
  await page.evaluate(() => { state.customPools = []; renderAll(); });

  assert.deepEqual(pageErrors, [], 'Trebuchet emitted page errors');
  assert.deepEqual(consoleErrors, [], 'Trebuchet emitted console errors');

  console.log('Trebuchet API-backed E2E passed: session, wallet, secure dialog, practice launch');
} catch (error) {
  if (serverOutput) process.stderr.write(`\n--- Trebuchet E2E server output ---\n${serverOutput}\n`);
  throw error;
} finally {
  await browser?.close().catch(() => {});
  await stopServer();
}
