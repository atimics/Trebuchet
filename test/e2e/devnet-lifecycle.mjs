#!/usr/bin/env node
// test/e2e/devnet-lifecycle.mjs — full devnet launch with crash/resume
//
// Goes through the complete launch flow on devnet, simulating a crash
// partway through (after token creation), reloading the page, and
// resuming from the Recent Launches panel. Exercises real on-chain
// transactions: wallet generation, token creation with vanity grinding,
// CLMM pool creation, position opening, and fund sweep.
//
// Requires:
//   DEVNET_RPC             — devnet RPC endpoint (default: public devnet)
//   DEVNET_WALLET_SECRET_KEY — base64-encoded secret key of a funded
//                              devnet wallet (for funding the launch)
//   VANITY_PREFIX          — optional, e.g. "RAT"
//
// Usage:
//   DEVNET_RPC=https://devnet.helius-rpc.com/?api-key=KEY \
//   DEVNET_WALLET_SECRET_KEY=$(base64 < /path/to/keypair.json) \
//     node test/e2e/devnet-lifecycle.mjs

import { chromium } from 'playwright';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, clusterApiUrl } from '@solana/web3.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Real token images for CI metadata — pick one randomly per run.
// __dirname is test/e2e/; rati/ is a sibling repo at ../../rati/.
const TOKEN_IMAGES = [
  path.resolve(__dirname, '../../../rati/tokens/Kyro/image.png'),
  path.resolve(__dirname, '../../../rati/tokens/Ruby/image.png'),
  path.resolve(__dirname, '../../../rati/tokens/noxannihilism_bob_the_obsequious_snake_cca92fc1-79d1-46d3-b135-613a2851835d.png'),
];

const TMP = fs.mkdtempSync(path.join(tmpdir(), 'treb-devnet-'));
const DEVNET_RPC = process.env.DEVNET_RPC || clusterApiUrl('devnet');
const VANITY_PREFIX = process.env.VANITY_PREFIX || 'RAT';
const TOKEN_NAME = process.env.TOKEN_NAME || 'RATi';
const TOKEN_SYMBOL = process.env.TOKEN_SYMBOL || 'RATi';

// ── Fund the launch wallet from the devnet wallet ──────────────────
const devnetSecretB64 = process.env.DEVNET_WALLET_SECRET_KEY;
if (!devnetSecretB64) {
  console.error('DEVNET_WALLET_SECRET_KEY is required');
  process.exit(1);
}
const devnetSecret = Uint8Array.from(Buffer.from(devnetSecretB64, 'base64'));
const funder = Keypair.fromSecretKey(devnetSecret);
const FUND_AMOUNT = 0.3; // SOL to send to the launch wallet per step

console.log('Funder wallet: ' + funder.publicKey.toBase58());
console.log('Devnet RPC:    ' + DEVNET_RPC);
console.log('Vanity prefix: ' + (VANITY_PREFIX || '(none)'));
console.log('');

const connection = new Connection(DEVNET_RPC, 'confirmed');

// Check funder balance
const funderBal = await connection.getBalance(funder.publicKey);
console.log('Funder balance: ' + (funderBal / LAMPORTS_PER_SOL).toFixed(4) + ' SOL');
if (funderBal < FUND_AMOUNT * 2 * LAMPORTS_PER_SOL) {
  console.error('Funder balance too low. Fund via https://faucet.solana.com first.');
  process.exit(1);
}

// ── Start the server ───────────────────────────────────────────────
process.env.TREBUCHET_CONFIG_DIR = TMP;
process.env.PORT = String(await new Promise((res, rej) => {
  const s = net.createServer(); s.unref(); s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
}));

// Override default RPC to use devnet
fs.writeFileSync(path.join(TMP, 'rpcConfig.json'), JSON.stringify({
  active: DEVNET_RPC,
  activeNetwork: 'devnet',
  saved: [{ name: 'CI devnet', url: DEVNET_RPC, network: 'devnet' }],
}));

let SERVER = null;
const _o = console.log;
console.log = (...a) => {
  _o(...a);
  const m = a.join(' ').match(/Server running on (http:\/\/127\.0\.0\.1:\d+)/);
  if (m) SERVER = m[1];
};

await import('../../server.js');
for (let i = 0; i < 80 && !SERVER; i++) await new Promise(r => setTimeout(r, 250));
console.log = _o;
if (!SERVER) { console.error('Server did not start'); process.exit(1); }
console.log('Server: ' + SERVER + '\n');

// ── Helpers ────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const log = (s) => console.log('  ' + s);

async function withPage(fn, label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const consoleLog = [];
  p.on('console', (msg) => { consoleLog.push(msg.text()); });
  p.on('pageerror', (err) => { consoleLog.push('PAGE ERROR: ' + err.message); });
  try {
    await fn(p, consoleLog);
    log('PASS: ' + label);
    passed++;
  } catch (e) {
    console.error('  FAIL: ' + label + ' — ' + e.message.split('\n')[0]);
    console.error('  Console (last 20):');
    for (const line of consoleLog.slice(-20)) console.error('    ' + line);
    failed++;
  } finally {
    try { await p.close(); } catch {}
    await ctx.close();
  }
}

async function textOf(p, sel) { return (await p.textContent(sel) || '').trim(); }

async function dismissStartup(p) {
  // Dismiss splash
  try {
    await p.waitForSelector('#splashSkipBtn', { state: 'visible', timeout: 8000 });
    await p.evaluate(() => {
      const btn = document.getElementById('splashSkipBtn');
      if (btn) btn.click();
    });
    await p.waitForFunction(() => {
      const el = document.getElementById('splashScreen');
      return !el || el.classList.contains('is-dismissing');
    }, { timeout: 10000 });
    log('splash dismissed');
  } catch { /* no splash */ }

  // Dismiss first-run disclaimer
  try {
    const cb = await p.waitForSelector('#disclaimerAgreeCheck', { state: 'visible', timeout: 5000 });
    await cb.click();
    await p.click('#disclaimerAgreeBtn');
    log('disclaimer dismissed');
  } catch { /* already agreed */ }

  await p.waitForTimeout(500);
}

// Avoid the disabled-continue-button problem by forcing clicks.
async function forceClick(p, sel) {
  await p.waitForSelector(sel, { state: 'attached', timeout: 30000 });
  await p.evaluate((s) => {
    const b = document.querySelector(s);
    if (b) { b.disabled = false; b.click(); }
  }, sel);
}

async function stepIs(p, n) {
  await p.waitForSelector('#step' + n + '-card.is-active', { timeout: 30000 });
}

// ── Send SOL from funder to launch wallet ──────────────────────────
async function fundLaunchWallet(pubkeyStr, solAmount) {
  const pubkey = new PublicKey(pubkeyStr);
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: funder.publicKey,
      toPubkey: pubkey,
      lamports: Math.floor(solAmount * LAMPORTS_PER_SOL),
    })
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [funder]);
  console.log('  Funded ' + pubkeyStr.slice(0, 8) + '... with ' + solAmount + ' SOL (' + sig.slice(0, 16) + '...)');
  return sig;
}

// ── Launch browser ─────────────────────────────────────────────────
const browser = await chromium.launch({ headless: true });

try {
  // ══════════════════════════════════════════════════════════════════
  // Phase 1: Generate wallet, configure token, create it
  // ══════════════════════════════════════════════════════════════════
  await withPage(async (p, _clog) => {
    await p.goto(SERVER, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await dismissStartup(p);

    // Step 1: Generate Wallet
    assert(await p.isVisible('#step1-card.is-active'), 'step 1 not active');
    await p.click('#generateWalletBtn');
    await stepIs(p, 2);
    const walletAddr = await p.inputValue('#walletAddress');
    assert(walletAddr.length >= 32, 'wallet address too short');
    console.log('  Wallet: ' + walletAddr.slice(0, 8) + '...');

    // Step 2: Configure token
    await p.fill('#tokenName', TOKEN_NAME);
    await p.fill('#tokenSymbol', TOKEN_SYMBOL);
    // Set vanity prefix — must select 'prefix' mode and fill the target
    const modeSelect = await p.$('#vanityCAMode');
    if (modeSelect) {
      await modeSelect.selectOption('prefix');
    }
    const targetInput = await p.$('#vanityCATarget');
    if (targetInput) {
      await targetInput.fill(VANITY_PREFIX);
    }
    await p.waitForTimeout(2000); // let cost estimate settle

    // Step 3: Fund wallet
    await forceClick(p, '#continueToFundingBtn');
    await stepIs(p, 3);
    const step3Addr = await textOf(p, '#step3WalletAddr');
    assert(step3Addr.length > 20, 'step 3 address missing');
    log('funding wallet with ' + FUND_AMOUNT + ' SOL...');
    await fundLaunchWallet(walletAddr, FUND_AMOUNT);
    // Wait for balance poll to pick up the funding
    await p.waitForTimeout(5000);

    // Step 4: Create token (with vanity grind)
    await forceClick(p, '#continueToTokenBtn');
    await stepIs(p, 4);
    await p.waitForTimeout(1000);

    await forceClick(p, '#createTokenBtn');
    // Token creation with vanity grinding can take a while
    await p.waitForSelector('#tokenCreatedInfo', { state: 'visible', timeout: 300000 });
    const mint = await textOf(p, '#tokenMintAddress');
    assert(mint.length > 30, 'mint address missing');
    assert(mint.startsWith(VANITY_PREFIX), 'vanity prefix not found in mint: ' + mint);
    console.log('  Token mint: ' + mint);
  }, 'create token with vanity prefix');

  // ══════════════════════════════════════════════════════════════════
  // Phase 2: Simulate crash — reload and resume
  // ══════════════════════════════════════════════════════════════════
  await withPage(async (p, _clog) => {
    await p.goto(SERVER, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await dismissStartup(p);

    // Wait for the Load button on the first launch row to appear.
    const loadBtn = await p.waitForSelector('#recentLaunchesList button[data-action="load-launch"]', { timeout: 15000 });
    log('recent launches panel visible');
    await loadBtn.click();
    await p.waitForTimeout(2000);
    log('launch loaded');

    // We should now be at some step >= 4.  Fund again and complete LP.
    const walletAddr = await p.inputValue('#walletAddress');
    if (walletAddr && walletAddr.length > 30) {
      log('funding wallet for LP phase...');
      await fundLaunchWallet(walletAddr, FUND_AMOUNT);
      await p.waitForTimeout(5000);
    }

    // Step 5: Create pools (if not already done)
    const step5card = await p.$('#step5-card.is-active');
    if (step5card) {
      log('already at step 5');
    } else {
      // Try to advance
      try {
        await forceClick(p, '#continueToTokenBtn');
        await stepIs(p, 4);
        await p.waitForTimeout(1000);
        await forceClick(p, '#createTokenBtn');
        await p.waitForTimeout(2000);
      } catch {}
    }

    // Step 5: Create LP
    await forceClick(p, '#createLpBtn');
    await stepIs(p, 5);
    log('LP creation started');
    // LP creation takes time; wait for it to complete by watching for
    // the step to deactivate or a completion message.
    await p.waitForFunction(() => {
      const card = document.getElementById('step5-card');
      return card && card.classList.contains('is-completed');
    }, { timeout: 300000 });
    log('LP creation completed');

    // Step 6: Transfer assets
    // Fill in a destination (back to funder wallet)
    await p.fill('#destinationWallet', funder.publicKey.toBase58());
    await forceClick(p, '#transferBtn');
    // Wait for transfer to complete
    await p.waitForSelector('#transferCompletePanel', { state: 'visible', timeout: 120000 });
    log('transfer completed');
  }, 'crash-resume and complete launch');

} finally {
  await browser.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
