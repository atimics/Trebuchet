// Meteora DAMM v2 lean launch API. No chain here: the guards that run before any money
// moves, the draft lifecycle, and that no secret ever appears in output. The chain flow is
// test/e2e/v2-damm-localnet.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import express from 'express';
import { Keypair } from '@solana/web3.js';

process.env.TREBUCHET_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-damm-'));
const { registerDammV2Routes } = await import('../dammV2Routes.js');
const store = await import('../dammV2Store.js');

function png() {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 1, 2, 3]))), chunk('IEND', Buffer.alloc(0))]);
}
const LOGO = `data:image/png;base64,${png().toString('base64')}`;

async function startApp({ demo = false, pinLocked = false, wallets = new Map(), solUsd = 118, destinationReason = null } = {}) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  const created = [];
  registerDammV2Routes(app, {
    isDemoMode: () => demo,
    rejectIfSecretPinLocked: (res) => {
      if (!pinLocked) return false;
      res.status(423).json({ success: false, code: 'SECRET_PIN_LOCKED', error: 'locked' });
      return true;
    },
    sendErrorResponse: (res, error, status) => res.status(error?.statusCode || status || 500).json({ success: false, error: error.message, code: error.code }),
    getRpcUrl: () => 'http://127.0.0.1:1',
    getManagedWallet: (pk) => wallets.get(pk) || null,
    createToken: async (args) => { created.push(args); throw new Error('no chain in this test'); },
    getVanityCandidate: () => null,
    removeVanityCandidate: () => {},
    getSolUsd: async () => solUsd,
    destinationRejection: async () => destinationReason,
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  return { call, created, close: () => { server.closeAllConnections(); server.close(); } };
}

const CONFIG = { token: { name: 'Trebuchet', symbol: 'treb', supply: '1000000000', description: 'A launch' } };

test('estimate: price, depth, cost and the saving against the Raydium path', async () => {
  const { call, close } = await startApp();
  try {
    const { status, data } = await call('POST', '/api/v2/damm/estimate', { config: CONFIG, solUsd: 118 });
    assert.equal(status, 200);
    assert.equal(data.config.token.symbol, 'TREB');
    const e = data.estimate;
    assert.equal(e.solUsd, 118);
    assert.equal(e.solUsdIsFallback, false);
    assert.ok(Math.abs(e.pricing.startMarketCapSol - 250000 / 118) < 1e-9);
    assert.equal(e.pricing.depth.length, 5);
    assert.equal(e.pricing.buys.length, 3);
    assert.equal(e.cost.seedSol, 0);
    assert.ok(e.cost.total > 0.07 && e.cost.total < 0.12, `total ${e.cost.total}`);
    assert.ok(e.comparison.savedSol > 0.09, `saves ${e.comparison.savedSol}`);
    assert.ok(e.facts.length >= 4);
    const bad = await call('POST', '/api/v2/damm/estimate', { config: { ...CONFIG, feeBps: 0 } });
    assert.equal(bad.status, 500);
    assert.match(bad.data.error, /Trading fee must be between/);
  } finally { close(); }
});

test('estimate falls back to the app default price when the market price is unavailable', async () => {
  const { call, close } = await startApp({ solUsd: 0 });
  try {
    const { data } = await call('POST', '/api/v2/damm/estimate', { config: CONFIG });
    assert.equal(data.estimate.solUsdIsFallback, true);
    assert.equal(data.estimate.solUsd, 200);
  } finally { close(); }
});

test('drafts: create, read, edit, remove, and no secret or logo bytes in output', async () => {
  const { call, close } = await startApp();
  try {
    const created = await call('POST', '/api/v2/damm/launches', { config: CONFIG, logoDataUrl: LOGO });
    assert.equal(created.status, 200);
    const id = created.data.launch.id;
    assert.match(id, /^damm_\d+_[0-9a-f]{8}$/);
    assert.equal(created.data.launch.status, 'draft');
    assert.equal(created.data.launch.hasLogo, true);
    store.savePositionNft(id, Keypair.generate().secretKey);
    const read = await call('GET', `/api/v2/damm/launches/${id}`);
    const text = JSON.stringify(read.data);
    assert.equal(read.data.launch.positionNftSaved, true);
    assert.ok(!text.includes('positionNftEnc'), 'the encrypted key is not exposed');
    assert.ok(!text.includes(LOGO.slice(30, 80)), 'logo bytes stay on the server');
    assert.equal((await call('GET', '/api/v2/damm/launches')).data.launches.length, 1);

    const wallet = Keypair.generate().publicKey.toBase58();
    const edited = await call('POST', `/api/v2/damm/launches/${id}/update`, { walletPublicKey: wallet, config: { ...CONFIG, feeBps: 100 } });
    assert.equal(edited.data.launch.walletPublicKey, wallet);
    assert.equal(edited.data.launch.config.pool.feeBps, 100);
    const badLogo = await call('POST', '/api/v2/damm/launches', { config: CONFIG, logoDataUrl: 'data:image/png;base64,AAAA' });
    assert.equal(badLogo.status, 400);
    assert.match(badLogo.data.error, /PNG, JPEG or GIF/);
    assert.equal((await call('POST', `/api/v2/damm/launches/${id}/remove`)).status, 200);
    assert.equal((await call('GET', `/api/v2/damm/launches/${id}`)).status, 404);
  } finally { close(); }
});

async function draftWithWallet(call, wallets) {
  const wallet = Keypair.generate();
  wallets.set(wallet.publicKey.toBase58(), { secretKey: Array.from(wallet.secretKey) });
  const created = await call('POST', '/api/v2/damm/launches', { config: CONFIG, walletPublicKey: wallet.publicKey.toBase58() });
  return { id: created.data.launch.id, total: created.data.launch.estimate.cost.total, wallet };
}

test('run refuses in practice mode, with a locked PIN, and without a wallet or key', async () => {
  const wallets = new Map();
  for (const [opts, status, code] of [[{ demo: true }, 409, 'DAMM_PRACTICE_MODE'], [{ pinLocked: true }, 423, 'SECRET_PIN_LOCKED']]) {
    const { call, close } = await startApp({ ...opts, wallets });
    try {
      const { id, total } = await draftWithWallet(call, wallets);
      const run = await call('POST', `/api/v2/damm/launches/${id}/run`, { maxSpendSol: total, solUsd: 118 });
      assert.equal(run.status, status);
      assert.equal(run.data.code, code);
    } finally { close(); }
  }
  const { call, close } = await startApp();
  try {
    const noWallet = (await call('POST', '/api/v2/damm/launches', { config: CONFIG })).data.launch.id;
    const a = await call('POST', `/api/v2/damm/launches/${noWallet}/run`, { maxSpendSol: 1, solUsd: 118 });
    assert.equal(a.status, 400);
    assert.match(a.data.error, /Choose the launch wallet/);
    const stranger = Keypair.generate().publicKey.toBase58();
    const unmanaged = (await call('POST', '/api/v2/damm/launches', { config: CONFIG, walletPublicKey: stranger })).data.launch.id;
    const b = await call('POST', `/api/v2/damm/launches/${unmanaged}/run`, { maxSpendSol: 1, solUsd: 118 });
    assert.equal(b.status, 404);
    assert.match(b.data.error, /not a Trebuchet-managed wallet/);
  } finally { close(); }
});

test('run needs the spend cap and the SOL price the operator saw', async () => {
  const wallets = new Map();
  const { call, close } = await startApp({ wallets, solUsd: 118 });
  try {
    const { id, total } = await draftWithWallet(call, wallets);
    const low = await call('POST', `/api/v2/damm/launches/${id}/run`, { maxSpendSol: total - 0.001, solUsd: 118 });
    assert.equal(low.status, 400);
    assert.equal(low.data.code, 'DAMM_SPEND_CAP');
    assert.match(low.data.error, /Approve at least/);
    assert.equal((await call('POST', `/api/v2/damm/launches/${id}/run`, { solUsd: 118 })).data.code, 'DAMM_SPEND_CAP', 'no cap is not a cap');
    const noPrice = await call('POST', `/api/v2/damm/launches/${id}/run`, { maxSpendSol: total });
    assert.equal(noPrice.status, 400);
    assert.match(noPrice.data.error, /solUsd is required/);
    const moved = await call('POST', `/api/v2/damm/launches/${id}/run`, { maxSpendSol: total, solUsd: 80 });
    assert.equal(moved.status, 409);
    assert.equal(moved.data.code, 'DAMM_PRICE_MOVED');
    assert.match(moved.data.error, /Review the starting price again/);
  } finally { close(); }
});

test('run refuses a Fee Key destination the classic rules refuse', async () => {
  const wallets = new Map();
  const { call, close } = await startApp({ wallets, destinationReason: 'that address has not been proven yours' });
  try {
    const wallet = Keypair.generate();
    wallets.set(wallet.publicKey.toBase58(), { secretKey: Array.from(wallet.secretKey) });
    const dest = Keypair.generate().publicKey.toBase58();
    const created = await call('POST', '/api/v2/damm/launches', { config: { ...CONFIG, destination: dest }, walletPublicKey: wallet.publicKey.toBase58() });
    const id = created.data.launch.id;
    const run = await call('POST', `/api/v2/damm/launches/${id}/run`, { maxSpendSol: created.data.launch.estimate.cost.total, solUsd: 118 });
    assert.equal(run.status, 400);
    assert.match(run.data.error, /Refusing to send the Fee Key: that address has not been proven yours/);
  } finally { close(); }
});

test('a launch that is running or finished cannot be started again, and only drafts are editable', async () => {
  const wallets = new Map();
  const { call, close } = await startApp({ wallets });
  try {
    const { id, total } = await draftWithWallet(call, wallets);
    store.update(id, { status: 'completed' });
    const again = await call('POST', `/api/v2/damm/launches/${id}/run`, { maxSpendSol: total, solUsd: 118 });
    assert.equal(again.status, 409);
    assert.equal(again.data.code, 'DAMM_ALREADY_COMPLETE');
    assert.equal((await call('POST', `/api/v2/damm/launches/${id}/update`, { config: CONFIG })).status, 409);
    assert.equal((await call('POST', `/api/v2/damm/launches/${id}/remove`)).status, 409);
  } finally { close(); }
});

test('fees and claim need a finished pool', async () => {
  const wallets = new Map();
  const { call, close } = await startApp({ wallets });
  try {
    const { id } = await draftWithWallet(call, wallets);
    assert.equal((await call('GET', `/api/v2/damm/launches/${id}/fees`)).status, 409);
    assert.equal((await call('POST', `/api/v2/damm/launches/${id}/claim`, {})).status, 409);
    assert.equal((await call('GET', '/api/v2/damm/positions?owner=nope')).status, 400);
  } finally { close(); }
});
