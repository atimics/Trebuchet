// Funding balances and automatic read recovery in an isolated browser session.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const configDir = mkdtempSync(path.join(tmpdir(), 'trebuchet-funding-recovery-'));
const shots = process.env.FUNDING_RECOVERY_SHOTS || '';
if (shots) mkdirSync(shots, { recursive: true });

const port = await new Promise((resolve, reject) => {
  const socket = net.createServer();
  socket.unref();
  socket.on('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const { port: free } = socket.address();
    socket.close(() => resolve(free));
  });
});
const baseUrl = `http://127.0.0.1:${port}`;

writeFileSync(path.join(configDir, 'userPrefs.json'), JSON.stringify({
  demoMode: true,
}, null, 2));

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), TREBUCHET_CONFIG_DIR: configDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
let serverExited = null;
const collect = (chunk) => { serverOutput = (serverOutput + chunk.toString()).slice(-20_000); };
server.stdout.on('data', collect);
server.stderr.on('data', collect);
server.on('exit', (code, signal) => { serverExited = { code, signal }; });

async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverExited) throw new Error(`server exited early\n${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/api/session`);
      if (response.ok && (await response.json())?.token) return;
    } catch { /* not ready yet */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`server did not start\n${serverOutput}`);
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${baseUrl}/v2/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.dataset.apiStatus === 'connected');
  const initial = await page.evaluate(() => {
    if (liveOpsTimer) { clearInterval(liveOpsTimer); liveOpsTimer = null; }
    const wallet = '11111111111111111111111111111111';
    state.selectedWalletPublicKey = wallet;
    state.managedWallets = [{ publicKey: wallet, hasSecret: true }];
    state.demoActive = false;
    state.launchChecks = { active: false };
    state.customPools = [];
    state.launchWorkspace = 'fund';
    state.phaseSlide = { ...state.phaseSlide, fund: 'cost' };
    setView('launch');
    state.manualPrefund = { walletPublicKey: wallet, balance: { sol: 2.6, tokens: { OWL: { amountRaw: '1000000', decimals: 6 } } }, lastUpdatedAt: new Date().toISOString() };
    const estimate = { totalSol: 3, subtotalSol: 2.8, bufferSol: 0.2, byQuote: {}, quoteBreakdown: [],
      autoSwapPlan: [{ allocationIndex: 0, quoteMint: 'OWL', quoteSymbol: 'OWL', quoteDecimals: 6, minRaw: '1000000', targetRaw: '2000000', estSolSpend: 0.4 }] };
    state.classicFundingEstimate = stampClassicFundingEstimate(estimate, currentLaunchConfig());
    state.quoteAcquire = defaultQuoteAcquireState();
    renderAll();
    return { ready: quoteAcquireStatus().ready, missingSol: fundingMeterSnapshot().missingSol, cost: fundingMeterSnapshot().estimatedCost };
  });
  assert.equal(initial.ready, true); assert.equal(initial.missingSol, 0); assert.equal(initial.cost, 2.6);
  const missing = await page.evaluate(() => {
    state.classicFundingEstimate = { ...state.classicFundingEstimate, autoSwapPlan: [],
      byQuote: { OWL: '3333334' }, quoteBreakdown: [{ mint: 'OWL', symbol: 'OWL', amount: 3.333334, decimals: 6 }] };
    state.manualPrefund.balance = { sol: 10, tokens: {} };
    renderClassicBridge();
    return document.querySelector('.funding-task').textContent;
  });
  assert.match(missing, /Add 3.333334 OWL/); assert.match(missing, /Balances refresh automatically/);
  await page.locator('.funding-task').waitFor({ state: 'visible' });
  if (shots) await page.screenshot({ path: path.join(shots, 'funding-shortfall.png') });
  const recovered = await page.evaluate(async () => {
    let attempts = 0, readinessReads = 0, sends = 0;
    const wallet = selectedLaunchWalletPublicKey();
    const estimate = { ...state.classicFundingEstimate };
    state.apiClient = {
      estimateClassicFunding: async () => { attempts++; if (attempts === 1) throw new Error('Quote service busy'); return estimate; },
      checkDetailedBalance: async () => ({ sol: 10, tokens: { OWL: { amountRaw: '3333334', decimals: 6 } } }),
      checkExecutionReadiness: async () => { readinessReads++; return { status: 'ready', blockers: [], warnings: [], phases: [], walletPublicKey: wallet }; },
      executeNext: async () => { sends++; },
    };
    state.classicFundingEstimate = null;
    state.launchChecks = { active: true };
    await refreshLaunchChecks();
    const error = state.launchChecks.error;
    state.launchChecks.nextAt = 0;
    await refreshLaunchChecks();
    await refreshManualPrefundBalance({ quiet: true });
    renderClassicBridge();
    return { error, attempts, readinessReads, sends, ready: manualPrefundSummary(quoteManualPrefundItems()).className,
      text: document.querySelector('.funding-task').textContent };
  });
  assert.equal(recovered.error, 'Quote service busy'); assert.equal(recovered.attempts, 2);
  assert.equal(recovered.readinessReads, 1); assert.equal(recovered.sends, 0); assert.equal(recovered.ready, '');
  assert.match(recovered.text, /Launch wallet ready/);
  assert.deepEqual(pageErrors, []);
  console.log('v2 funding recovery: ok');
} finally {
  await browser?.close().catch(() => {});
  await stopServer();
}
