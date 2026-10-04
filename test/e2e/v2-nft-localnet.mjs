#!/usr/bin/env node
// NFTs view, end to end in the browser against a local validator.
//
// Boots the real local server on a temp config dir pointed at the validator,
// imports a generated Sugar-style folder through the UI, grinds vanity
// addresses, estimates, approves, mints, and verifies. Uploads use the
// localnet-only fake uploader (Arweave cannot serve a local validator).
//
//   solana program dump -u m CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d mpl_core.so
//   solana-test-validator --reset --bpf-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d mpl_core.so
//   npm run build:c
//   TREBUCHET_NFT_LOCALNET_RPC=http://127.0.0.1:8899 node test/e2e/v2-nft-localnet.mjs [--shots <dir>]

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

const rpcUrl = process.env.TREBUCHET_NFT_LOCALNET_RPC;
if (!rpcUrl) {
  console.log('Skipped: set TREBUCHET_NFT_LOCALNET_RPC to a local validator with Metaplex Core loaded.');
  process.exit(0);
}
const shotsArg = process.argv.indexOf('--shots');
const shotsDir = shotsArg > 0 ? process.argv[shotsArg + 1] : null;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-nft-e2e-'));
const assetsDir = path.join(configDir, 'assets');
const ITEM_COUNT = 12;

fs.writeFileSync(path.join(configDir, 'userPrefs.json'), JSON.stringify({
  demoMode: false,
}));
fs.writeFileSync(path.join(configDir, 'rpcConfig.json'), JSON.stringify({
  active: rpcUrl,
  activeNetwork: 'devnet',
  saved: [{ url: rpcUrl, label: 'Localnet', network: 'devnet' }],
}));

// Sugar-style folder: N.png + N.json, plus collection.png/json.
function png(seed) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const size = 16;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) row.set([(seed * 37 + x * 9) & 255, (seed * 71 + y * 13) & 255, (seed * 11) & 255], 1 + x * 3);
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
fs.mkdirSync(assetsDir);
const eyes = ['Plain', 'Plain', 'Visor', 'Laser'];
for (let i = 0; i < ITEM_COUNT; i++) {
  fs.writeFileSync(path.join(assetsDir, `${i}.png`), png(i + 1));
  const attributes = [{ trait_type: 'Eyes', value: eyes[i % eyes.length] }];
  if (i !== 5) attributes.push({ trait_type: 'Mouth', value: i % 2 ? 'Grin' : 'Flat' });
  fs.writeFileSync(path.join(assetsDir, `${i}.json`), JSON.stringify({ name: `Genesis #${i}`, symbol: 'GEN', description: 'E2E', attributes }));
}
fs.writeFileSync(path.join(assetsDir, 'collection.png'), png(99));
fs.writeFileSync(path.join(assetsDir, 'collection.json'), JSON.stringify({ name: 'Genesis Series', symbol: 'GEN', description: 'E2E collection' }));

const port = await new Promise((resolve, reject) => {
  const socket = net.createServer();
  socket.unref();
  socket.on('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const { port: p } = socket.address();
    socket.close(() => resolve(p));
  });
});
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), TREBUCHET_CONFIG_DIR: configDir, TREBUCHET_NFT_LOCAL_UPLOADER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', (c) => { serverOutput = (serverOutput + c).slice(-20000); });
server.stderr.on('data', (c) => { serverOutput = (serverOutput + c).slice(-20000); });

let browser;
try {
  const deadline = Date.now() + 60_000;
  let token = null;
  while (!token && Date.now() < deadline) {
    try { token = (await (await fetch(`${baseUrl}/api/session`)).json()).token; } catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  assert.ok(token, `server did not start\n${serverOutput}`);
  const headers = { 'x-trebuchet-session': token, 'Content-Type': 'application/json' };
  const generated = await (await fetch(`${baseUrl}/api/v2/wallets/generate`, { method: 'POST', headers, body: '{}' })).json();
  const wallet = generated.wallet.publicKey;
  const connection = new Connection(rpcUrl, 'confirmed');
  await connection.confirmTransaction(await connection.requestAirdrop(new PublicKey(wallet), LAMPORTS_PER_SOL), 'confirmed');

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const shot = async (name) => { if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${name}.png`), fullPage: true }); };
  const idle = () => page.waitForFunction(() => !document.querySelector('#nftRoot .nft-tag-run') && !document.querySelector('#nftRoot .nft-rail button[disabled]'), null, { timeout: 120_000 });
  const noError = async () => {
    const banner = await page.evaluate(() => document.querySelector('.nft-banner-bad')?.textContent || null);
    assert.equal(banner, null, `UI error: ${banner}`);
  };

  await page.goto(`${baseUrl}/v2/`, { waitUntil: 'load' });
  await page.evaluate(() => document.querySelector('.nav-item[data-view="nfts"]').click());
  await page.waitForSelector('#nftRoot .nft-shell');
  await page.click('[data-nft-action="new"]');
  await page.waitForSelector('.nft-fact-list');
  await shot('01-new');

  await page.click('[data-nft-tab="items"]');
  await page.setInputFiles('[data-nft-file="folder"]', assetsDir);
  await page.waitForSelector('.nft-items', { timeout: 60_000 });
  await idle();
  await noError();
  const head = await page.textContent('.nft-head-title strong');
  assert.equal(head, 'Genesis Series', 'collection.json fills the empty name');
  await shot('02-items');
  await page.click('[data-nft-action="accept-all"]');
  await idle();

  await page.click('[data-nft-tab="collection"]');
  await page.click('[data-nft-vmode="collection:suffix"]');
  await page.fill('[data-nft-field="collectionVanity.pattern"]', 'zb');
  await page.click('[data-nft-action="creator-add"]');
  await page.click('.nft-actions [data-nft-action="save"]');
  await idle();
  await noError();

  await page.click('[data-nft-tab="addresses"]');
  await page.click('[data-nft-vmode="item:suffix"]');
  await page.fill('[data-nft-field="itemVanity.pattern"]', 'z');
  await page.click('.nft-main [data-nft-action="save"]');
  await idle();
  await page.click('.nft-main [data-nft-action="grind"]');
  await page.waitForFunction((n) => document.querySelector('.nft-fact-list [data-nft-tab="addresses"] small')?.textContent === `${n} ground`, ITEM_COUNT, { timeout: 120_000 });
  await noError();
  await shot('03-addresses');

  await page.click('[data-nft-tab="fund"]');
  await page.click('.nft-main [data-nft-action="estimate"]');
  await page.waitForSelector('.nft-kv .nft-total');
  await idle();
  await noError();
  await shot('04-fund');

  await page.click('[data-nft-tab="mint"]');
  await page.check('[data-nft-field="approved"]');
  await page.click('.nft-main [data-nft-action="run"]');
  await page.waitForFunction((n) => document.querySelector('.nft-fact-list [data-nft-tab="mint"] small')?.textContent === `All ${n} on-chain`, ITEM_COUNT, { timeout: 180_000 });
  await noError();
  await shot('05-minted');

  await page.click('[data-nft-tab="verify"]');
  await page.click('.nft-main [data-nft-action="verify"]');
  await page.waitForFunction(() => document.querySelector('.nft-fact-list [data-nft-tab="verify"] small')?.textContent === 'Every asset checked on-chain', null, { timeout: 120_000 });
  await shot('06-verified');

  const list = await (await fetch(`${baseUrl}/api/v2/nfts`, { headers })).json();
  const summary = list.collections[0];
  assert.equal(summary.minted, ITEM_COUNT);
  assert.equal(summary.verified, true);
  assert.match(summary.collectionAddress, /zb$/i);
  assert.deepEqual(errors, []);
  console.log(`NFT localnet E2E passed: ${ITEM_COUNT} vanity assets in collection ${summary.collectionAddress}`);
} finally {
  await browser?.close();
  server.kill();
}
