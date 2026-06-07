#!/usr/bin/env node
// test/e2e/devnet-lifecycle.mjs

import { chromium } from 'playwright';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, clusterApiUrl } from '@solana/web3.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import net from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(tmpdir(), 'treb-devnet-'));
const DEVNET_RPC = process.env.DEVNET_RPC || clusterApiUrl('devnet');
const VANITY_PREFIX = process.env.VANITY_PREFIX || 'RAT';
const TOKEN_NAME = process.env.TOKEN_NAME || 'RATi';
const TOKEN_SYMBOL = process.env.TOKEN_SYMBOL || 'RATi';

const devnetSecretB64 = process.env.DEVNET_WALLET_SECRET_KEY;
if (!devnetSecretB64) { console.error('DEVNET_WALLET_SECRET_KEY is required'); process.exit(1); }
const devnetSecret = Uint8Array.from(Buffer.from(devnetSecretB64, 'base64'));
const funder = Keypair.fromSecretKey(devnetSecret);
const FUND_AMOUNT = 0.3;

console.log('Funder wallet: ' + funder.publicKey.toBase58());
console.log('Devnet RPC:    ' + DEVNET_RPC);
console.log('Vanity prefix: ' + VANITY_PREFIX + '\n');

const connection = new Connection(DEVNET_RPC, 'confirmed');
const funderBal = await connection.getBalance(funder.publicKey);
console.log('Funder balance: ' + (funderBal / LAMPORTS_PER_SOL).toFixed(4) + ' SOL');
if (funderBal < FUND_AMOUNT * 2 * LAMPORTS_PER_SOL) {
  console.error('Funder balance too low.');
  process.exit(1);
}

process.env.TREBUCHET_CONFIG_DIR = TMP;
process.env.PORT = String(await new Promise((res, rej) => {
  const s = net.createServer(); s.unref(); s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
}));
fs.writeFileSync(path.join(TMP, 'rpcConfig.json'), JSON.stringify({
  active: DEVNET_RPC, activeNetwork: 'devnet',
  saved: [{ name: 'CI devnet', url: DEVNET_RPC, network: 'devnet' }],
}));

let SERVER = null;
const _o = console.log;
console.log = (...a) => { _o(...a); const m = a.join(' ').match(/Server running on (http:\/\/127\.0\.0\.1:\d+)/); if (m) SERVER = m[1]; };
await import('../../server.js');
for (let i = 0; i < 80 && !SERVER; i++) await new Promise(r => setTimeout(r, 250));
console.log = _o;
if (!SERVER) { console.error('Server did not start'); process.exit(1); }
console.log('Server: ' + SERVER + '\n');

let passed = 0, failed = 0;
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const log = (s) => console.log('  ' + s);

async function withPage(fn, label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const clog = [];
  p.on('console', (msg) => { clog.push(msg.text()); });
  p.on('pageerror', (err) => { clog.push('PAGE ERROR: ' + err.message); });
  try {
    await fn(p, clog);
    log('PASS: ' + label);
    passed++;
  } catch (e) {
    console.error('  FAIL: ' + label + ' \u2014 ' + e.message.split('\n')[0]);
    console.error('  Console (last 20):');
    for (const line of clog.slice(-20)) console.error('    ' + line);
    failed++;
  } finally {
    try { await p.close(); } catch {}
    await ctx.close();
  }
}

async function textOf(p, sel) { return (await p.textContent(sel) || '').trim(); }

async function dismissStartup(p) {
  try {
    await p.waitForSelector('#splashSkipBtn', { state: 'visible', timeout: 8000 });
    await p.evaluate(() => { const btn = document.getElementById('splashSkipBtn'); if (btn) btn.click(); });
    await p.waitForFunction(() => {
      const el = document.getElementById('splashScreen');
      return !el || el.classList.contains('is-dismissing');
    }, { timeout: 10000 });
    log('splash dismissed');
  } catch {}
  try {
    const cb = await p.waitForSelector('#disclaimerAgreeCheck', { state: 'visible', timeout: 5000 });
    await cb.click(); await p.click('#disclaimerAgreeBtn');
    log('disclaimer dismissed');
  } catch {}
  await p.waitForTimeout(500);
}

async function forceClick(p, sel) {
  await p.waitForSelector(sel, { state: 'attached', timeout: 30000 });
  await p.evaluate((s) => { const b = document.querySelector(s); if (b) { b.disabled = false; b.click(); } }, sel);
}

async function stepIs(p, n) {
  await p.waitForSelector('#step' + n + '-card.is-active', { timeout: 30000 });
}

async function fundLaunchWallet(pubkeyStr, solAmount) {
  const pubkey = new PublicKey(pubkeyStr);
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: funder.publicKey, toPubkey: pubkey,
    lamports: Math.floor(solAmount * LAMPORTS_PER_SOL),
  }));
  const sig = await sendAndConfirmTransaction(connection, tx, [funder]);
  console.log('  Funded ' + pubkeyStr.slice(0, 8) + '... ' + solAmount + ' SOL (' + sig.slice(0, 16) + '...)');
  return sig;
}

const browser = await chromium.launch({ headless: true });

try {
  // Phase 1
  await withPage(async (p, _clog) => {
    await p.goto(SERVER, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await dismissStartup(p);

    assert(await p.isVisible('#step1-card.is-active'), 'step 1 not active');
    await p.click('#generateWalletBtn');
    await stepIs(p, 2);
    const walletAddr = await p.inputValue('#walletAddress');
    assert(walletAddr.length >= 32, 'wallet address too short');
    log('Wallet: ' + walletAddr.slice(0, 8) + '...');

    await p.fill('#tokenName', TOKEN_NAME);
    await p.fill('#tokenSymbol', TOKEN_SYMBOL);
    const modeSelect = await p.$('#vanityCAMode');
    if (modeSelect) await modeSelect.selectOption('prefix');
    const targetInput = await p.$('#vanityCATarget');
    if (targetInput) await targetInput.fill(VANITY_PREFIX);
    await p.waitForTimeout(2000);

    // Build a simple SOL-only pool via the exposed pools global.
    await p.evaluate(() => {
      var p = window.__trebuchet_pools;
      if (!p) return;
      p.length = 0;
      p.push({
        quoteToken: 'So11111111111111111111111111111111111111112',
        supplyPercent: '100',
        ammConfigIndex: 2,
        quoteUsdOverride: null,
        quoteDecimalsOverride: null,
        quoteSymbolOverride: 'SOL',
        slices: [],
        bootstrapConfig: { mode: 'minimal' },
        ladderConfig: { mode: 'off', bands: [] },
        support: 0,
        resolvedPriceUsd: null,
        resolvedSymbol: 'SOL',
        resolvedDecimals: 9,
      });
      var mcEl = document.getElementById('targetMarketCap');
      if (mcEl) mcEl.value = '100000';
    });
    await p.waitForTimeout(2000);

    await forceClick(p, '#continueToFundingBtn');
    await stepIs(p, 3);
    log('funding wallet with ' + FUND_AMOUNT + ' SOL...');
    await fundLaunchWallet(walletAddr, FUND_AMOUNT);
    await p.waitForTimeout(5000);

    await forceClick(p, '#continueToTokenBtn');
    await stepIs(p, 4);
    await p.waitForTimeout(1000);
    await forceClick(p, '#createTokenBtn');

    await p.waitForSelector('#tokenCreatedInfo', { state: 'visible', timeout: 300000 });
    const mint = await textOf(p, '#tokenMintAddress');
    assert(mint.length > 30, 'mint address missing');
    assert(mint.startsWith(VANITY_PREFIX), 'vanity prefix not found: ' + mint);
    log('Token mint: ' + mint);
  }, 'create token with vanity prefix');

  // Phase 2
  await withPage(async (p, _clog) => {
    await p.goto(SERVER, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await dismissStartup(p);

    const loadBtn = await p.waitForSelector('#recentLaunchesList button[data-action="load-launch"]', { timeout: 15000 });
    log('recent launches panel visible');
    await loadBtn.click();
    await p.waitForTimeout(3000);
    log('launch loaded');

    const walletAddr = await p.inputValue('#walletAddress');
    assert(walletAddr && walletAddr.length > 30, 'wallet not restored after Load');

    log('funding wallet for LP...');
    await fundLaunchWallet(walletAddr, FUND_AMOUNT);
    await p.waitForTimeout(5000);

    const step5card = await p.$('#step5-card.is-active');
    assert(step5card, 'step 5 should be active after Load');
    log('step 5 active');

    // Re-inject SOL pool config — the journal may not persist poolPlan
    // if the create-token request didn't include allocations.
    await p.evaluate(() => {
      var p = window.__trebuchet_pools;
      if (!p) return;
      p.length = 0;
      p.push({
        quoteToken: 'So11111111111111111111111111111111111111112',
        supplyPercent: '100', ammConfigIndex: 2,
        quoteUsdOverride: null, quoteDecimalsOverride: null,
        quoteSymbolOverride: 'SOL',
        slices: [], bootstrapConfig: { mode: 'minimal' },
        ladderConfig: { mode: 'off', bands: [] }, support: 0,
        resolvedPriceUsd: null, resolvedSymbol: 'SOL', resolvedDecimals: 9,
      });
    });
    await p.waitForTimeout(500);


    // Re-inject SOL pool config — journal may not persist poolPlan.
    await p.evaluate(() => {
      var pl = window.__trebuchet_pools;
      if (!pl) return;
      pl.length = 0;
      pl.push({
        quoteToken: 'So11111111111111111111111111111111111111112',
        supplyPercent: '100', ammConfigIndex: 2,
        quoteUsdOverride: null, quoteDecimalsOverride: null,
        quoteSymbolOverride: 'SOL',
        slices: [], bootstrapConfig: { mode: 'minimal' },
        ladderConfig: { mode: 'off', bands: [] }, support: 0,
        resolvedPriceUsd: null, resolvedSymbol: 'SOL', resolvedDecimals: 9,
      });
    });
    await p.waitForTimeout(500);

    await forceClick(p, '#createLpBtn');
    // Confirm the preflight modal if it appears.
    try {
      await p.waitForSelector("#createLpConfirmModal.is-active", { timeout: 15000 });
      log("preflight modal visible");
      await p.click("#createLpConfirmProceedBtn");
      log("preflight confirmed");
      await p.waitForTimeout(2000);
    } catch (e) {
      log("preflight modal skipped: " + e.message.slice(0, 80));
    // If preflight failed, the UI may show an error. Log it.
    try {
      var errEl = await p.waitForSelector("#lpFailInfo:not(.hidden)", { timeout: 5000 });
      var errText = await errEl.textContent();
      log("LP error: " + errText.trim().slice(0, 200));
    } catch {}
    }
    log('LP creation started');
    await p.waitForFunction(() => {
      const card = document.getElementById('step5-card');
      return card && card.classList.contains('is-completed');
    }, { timeout: 300000 });
    log('LP creation completed');

    await p.fill('#destinationWallet', funder.publicKey.toBase58());
    await forceClick(p, '#transferBtn');
    await p.waitForSelector('#transferCompletePanel', { state: 'visible', timeout: 120000 });
    log('transfer completed');
  }, 'crash-resume and complete launch');

} finally {
  await browser.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
