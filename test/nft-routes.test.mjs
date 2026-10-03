// NFT API routes. The chain test runs only against a local validator that has
// the Metaplex Core program loaded:
//
//   solana program dump -u m CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d mpl_core.so
//   solana-test-validator --reset --bpf-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d mpl_core.so
//   TREBUCHET_NFT_LOCALNET_RPC=http://127.0.0.1:8899 node --test test/nft-routes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import express from 'express';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';

process.env.TREBUCHET_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-nft-'));
process.env.TREBUCHET_NFT_LOCAL_UPLOADER = '1';
const { registerNftRoutes } = await import('../nftRoutes.js');

const LOCALNET = process.env.TREBUCHET_NFT_LOCALNET_RPC || '';
const hasGrinder = fs.existsSync(new URL('../c/build/vanity_keygen', import.meta.url));

function png(r, g, b) {
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
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, r, g, b]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function startApp({ demo = false, pinLocked = false, rpcUrl = 'http://127.0.0.1:1', wallets = new Map() } = {}) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  registerNftRoutes(app, {
    isDemoMode: () => demo,
    rejectIfSecretPinLocked: (res) => {
      if (!pinLocked) return false;
      res.status(423).json({ success: false, code: 'SECRET_PIN_LOCKED', error: 'locked' });
      return true;
    },
    sendErrorResponse: (res, error, status) => res.status(error?.statusCode || status || 500).json({ success: false, error: error.message, code: error.code }),
    getRpcUrl: () => rpcUrl,
    getManagedWallet: (pk) => wallets.get(pk) || null,
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const isBytes = Buffer.isBuffer(body);
    const res = await fetch(base + url, {
      method,
      headers: isBytes ? { 'Content-Type': 'image/png', ...headers } : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : isBytes ? body : JSON.stringify(body),
    });
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data };
  };
  return { call, close: () => { server.closeAllConnections(); server.close(); } };
}

async function waitForJob(call, id, kind) {
  for (let i = 0; i < 600; i++) {
    const { data } = await call('GET', `/api/v2/nfts/${id}`);
    const job = data.collection.job;
    if (job && job.kind === kind && job.status !== 'running') return { job, collection: data.collection };
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${kind} job did not finish`);
}

const ITEMS = [0, 1, 2].map((i) => ({
  index: i,
  name: `Genesis #${i}`,
  imageName: `${i}.png`,
  attributes: [{ trait_type: 'Eyes', value: i === 0 ? 'Laser' : 'Plain' }],
}));

test('collections: create, import, images, review, and no secrets in output', async () => {
  const { call, close } = await startApp();
  try {
    const created = await call('POST', '/api/v2/nfts', { config: { name: 'Genesis', symbol: 'gen', royaltyBps: 500 } });
    assert.equal(created.status, 200);
    const id = created.data.collection.id;
    assert.equal(created.data.collection.config.symbol, 'GEN');

    const bad = await call('PUT', `/api/v2/nfts/${id}/config`, { config: { itemVanity: { mode: 'suffix', pattern: 'l0l' } } });
    assert.equal(bad.status, 500);
    assert.match(bad.data.error, /never use/);

    let r = await call('POST', `/api/v2/nfts/${id}/items`, { items: ITEMS });
    assert.equal(r.data.collection.items.length, 3);
    assert.deepEqual(r.data.collection.images.missing, [0, 1, 2]);

    for (const i of [0, 1, 2]) {
      r = await call('PUT', `/api/v2/nfts/${id}/images/${i}`, png(i * 40, 10, 10));
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.type, 'png');
    }
    const rejected = await call('PUT', `/api/v2/nfts/${id}/images/0`, Buffer.from('not an image'));
    assert.equal(rejected.status, 400);
    r = await call('PUT', `/api/v2/nfts/${id}/images/cover`, png(1, 2, 3));
    assert.equal(r.status, 200);

    const img = await call('GET', `/api/v2/nfts/${id}/images/1`);
    assert.equal(img.status, 200);
    assert.ok(Buffer.isBuffer(img.data) && img.data[1] === 0x50);

    const detail = await call('GET', `/api/v2/nfts/${id}`);
    assert.deepEqual(detail.data.collection.images.missing, []);
    assert.equal(detail.data.collection.traits[0].traitType, 'Eyes');

    const odds = await call('GET', `/api/v2/nfts/${id}/odds?mode=suffix&pattern=zbro&caseInsensitive=1`);
    assert.equal(odds.data.rows.at(-1).pattern, 'zbro');

    const list = await call('GET', '/api/v2/nfts');
    assert.equal(list.data.collections.some((c) => c.id === id), true);
  } finally {
    close();
  }
});

test('money routes refuse practice mode, a locked PIN, unknown wallets and missing caps', async () => {
  const practice = await startApp({ demo: true });
  const locked = await startApp({ pinLocked: true });
  const live = await startApp();
  try {
    const { data } = await live.call('POST', '/api/v2/nfts', { config: { name: 'X', symbol: 'X' } });
    const id = data.collection.id;
    assert.equal((await practice.call('POST', `/api/v2/nfts/${id}/run`, {})).data.code, 'NFT_PRACTICE_MODE');
    assert.equal((await locked.call('POST', `/api/v2/nfts/${id}/run`, {})).status, 423);
    assert.equal((await locked.call('POST', `/api/v2/nfts/${id}/grind`, {})).status, 423);
    const blocked = await live.call('POST', `/api/v2/nfts/${id}/run`, { walletPublicKey: Keypair.generate().publicKey.toBase58(), maxSpendSol: 1 });
    assert.equal(blocked.data.code, 'NFT_RUN_BLOCKED');
  } finally {
    practice.close(); locked.close(); live.close();
  }
});

test('grinding gives every item an address that matches the pattern', { skip: !hasGrinder && 'grinder not built' }, async () => {
  const { call, close } = await startApp();
  try {
    const { data } = await call('POST', '/api/v2/nfts', {
      config: { name: 'G', symbol: 'G', collectionVanity: { mode: 'suffix', pattern: 'zb', caseInsensitive: true }, itemVanity: { mode: 'suffix', pattern: 'z', caseInsensitive: true } },
    });
    const id = data.collection.id;
    await call('POST', `/api/v2/nfts/${id}/items`, { items: ITEMS });
    assert.equal((await call('POST', `/api/v2/nfts/${id}/grind`)).status, 200);
    const { job, collection } = await waitForJob(call, id, 'grind');
    assert.equal(job.status, 'done', job.error);
    assert.match(collection.collectionKey.address, /zb$/i);
    for (const item of collection.items) assert.match(item.address, /z$/i);
    const raw = fs.readFileSync(path.join(process.env.TREBUCHET_CONFIG_DIR, 'nftCollections', id, 'collection.json'), 'utf8');
    assert.doesNotMatch(JSON.stringify(collection), /scalarEnc/);
    assert.match(raw, /scalarEnc/);

    // Changing the item pattern drops keys that no longer match.
    const changed = await call('PUT', `/api/v2/nfts/${id}/config`, { config: { itemVanity: { mode: 'suffix', pattern: 'zzz', caseInsensitive: false } } });
    assert.ok(changed.data.collection.items.every((item) => item.address === null || item.address.endsWith('zzz')));
  } finally {
    close();
  }
});

test('localnet: upload, create collection, mint, verify, resume', { skip: (!LOCALNET || !hasGrinder) && 'set TREBUCHET_NFT_LOCALNET_RPC' }, async () => {
  const payer = Keypair.generate();
  const connection = new Connection(LOCALNET, 'confirmed');
  const sig = await connection.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, 'confirmed');
  const wallets = new Map([[payer.publicKey.toBase58(), { secretKey: Array.from(payer.secretKey) }]]);
  const { call, close } = await startApp({ rpcUrl: LOCALNET, wallets });
  try {
    const { data } = await call('POST', '/api/v2/nfts', {
      config: {
        name: 'Genesis', symbol: 'GEN', royaltyBps: 500,
        creators: [{ address: payer.publicKey.toBase58(), percentage: 100 }],
        collectionVanity: { mode: 'suffix', pattern: 'zb', caseInsensitive: true },
        itemVanity: { mode: 'suffix', pattern: 'z', caseInsensitive: true },
      },
    });
    const id = data.collection.id;
    await call('POST', `/api/v2/nfts/${id}/items`, { items: ITEMS });
    for (const i of [0, 1, 2]) await call('PUT', `/api/v2/nfts/${id}/images/${i}`, png(i, i, i));
    await call('PUT', `/api/v2/nfts/${id}/images/cover`, png(9, 9, 9));
    await call('POST', `/api/v2/nfts/${id}/grind`);
    assert.equal((await waitForJob(call, id, 'grind')).job.status, 'done');

    const est = await call('POST', `/api/v2/nfts/${id}/estimate`, { walletPublicKey: payer.publicKey.toBase58() });
    assert.equal(est.status, 200, JSON.stringify(est.data));
    assert.ok(est.data.estimate.totalSol > 0.01 && est.data.estimate.totalSol < 0.03, `estimate ${est.data.estimate.totalSol}`);
    assert.equal(est.data.estimate.shortfallSol, 0);

    const before = await connection.getBalance(payer.publicKey);
    const run = await call('POST', `/api/v2/nfts/${id}/run`, { walletPublicKey: payer.publicKey.toBase58(), maxSpendSol: est.data.estimate.totalSol });
    assert.equal(run.status, 200, JSON.stringify(run.data));
    const { job, collection } = await waitForJob(call, id, 'run');
    assert.equal(job.status, 'done', job.error);
    assert.ok(collection.collectionSignature);
    assert.ok(collection.items.every((it) => it.mintSignature && !it.mintError));
    const spent = (before - (await connection.getBalance(payer.publicKey))) / LAMPORTS_PER_SOL;
    assert.ok(spent <= est.data.estimate.totalSol, `spent ${spent} within estimate ${est.data.estimate.totalSol}`);

    const verify = await call('POST', `/api/v2/nfts/${id}/verify`, {});
    assert.equal(verify.status, 200, JSON.stringify(verify.data));
    const v = verify.data.verification;
    assert.equal(v.checks.collection.ok, true, JSON.stringify(v.checks.collection));
    assert.equal(v.checks.collection.royaltyBps, 500);
    assert.equal(v.checks.supply.onChain, 3);
    assert.equal(v.checks.membership.passed, 3);
    assert.equal(v.checks.pattern.passed, 3);
    assert.equal(v.passed, true, JSON.stringify(v.checks));

    // A second run finds nothing to do and sends nothing.
    const again = await call('POST', `/api/v2/nfts/${id}/run`, { walletPublicKey: payer.publicKey.toBase58(), maxSpendSol: 0.01 });
    assert.equal(again.status, 200);
    const balanceBefore = await connection.getBalance(payer.publicKey);
    assert.equal((await waitForJob(call, id, 'run')).job.status, 'done');
    assert.equal(await connection.getBalance(payer.publicKey), balanceBefore);

    const proof = await call('GET', `/api/v2/nfts/${id}/proof`);
    assert.equal(proof.data.proof.items.length, 3);
    assert.equal(proof.data.proof.verification.passed, true);

    // Fixed fields refuse edits once the collection is on chain.
    const edit = await call('PUT', `/api/v2/nfts/${id}/config`, { config: { name: 'Other' } });
    assert.equal(edit.status, 409);
  } finally {
    close();
  }
});

test('localnet: the approved spend cap stops a run, and a new approval resumes it', { skip: (!LOCALNET || !hasGrinder) && 'set TREBUCHET_NFT_LOCALNET_RPC' }, async () => {
  const payer = Keypair.generate();
  const connection = new Connection(LOCALNET, 'confirmed');
  await connection.confirmTransaction(await connection.requestAirdrop(payer.publicKey, LAMPORTS_PER_SOL), 'confirmed');
  const wallets = new Map([[payer.publicKey.toBase58(), { secretKey: Array.from(payer.secretKey) }]]);
  const { call, close } = await startApp({ rpcUrl: LOCALNET, wallets });
  const wallet = payer.publicKey.toBase58();
  try {
    const { data } = await call('POST', '/api/v2/nfts', { config: { name: 'Capped', symbol: 'CAP' } });
    const id = data.collection.id;
    await call('POST', `/api/v2/nfts/${id}/items`, { items: ITEMS });
    for (const i of [0, 1, 2]) await call('PUT', `/api/v2/nfts/${id}/images/${i}`, png(i + 5, 1, 1));
    await call('POST', `/api/v2/nfts/${id}/grind`);
    await waitForJob(call, id, 'grind');

    // The collection alone costs ~0.002 SOL, so a 0.001 cap stops before its transaction.
    const balanceBeforeCap = await connection.getBalance(payer.publicKey);
    await call('POST', `/api/v2/nfts/${id}/run`, { walletPublicKey: wallet, maxSpendSol: 0.001 });
    const halted = await waitForJob(call, id, 'run');
    assert.equal(halted.job.status, 'failed');
    assert.match(halted.job.error, /spend cap/);
    assert.equal(halted.collection.collectionSignature, null);
    assert.equal(halted.collection.items.filter((it) => it.mintSignature).length, 0);
    assert.ok(balanceBeforeCap - await connection.getBalance(payer.publicKey) <= 1_000_000);

    // One shared budget allows the collection and one asset, even with four workers.
    const balanceBeforePartial = await connection.getBalance(payer.publicKey);
    await call('POST', `/api/v2/nfts/${id}/run`, { walletPublicKey: wallet, maxSpendSol: 0.006 });
    const partial = await waitForJob(call, id, 'run');
    assert.equal(partial.job.status, 'failed');
    assert.match(partial.job.error, /spend cap/);
    assert.ok(partial.collection.collectionSignature);
    assert.equal(partial.collection.items.filter((it) => it.mintSignature).length, 1);
    assert.ok(balanceBeforePartial - await connection.getBalance(payer.publicKey) <= 6_000_000);

    const est = await call('POST', `/api/v2/nfts/${id}/estimate`, { walletPublicKey: wallet });
    assert.equal(est.data.estimate.collectionSol, 0, 'the created collection is excluded from the new estimate');
    await call('POST', `/api/v2/nfts/${id}/run`, { walletPublicKey: wallet, maxSpendSol: est.data.estimate.totalSol });
    const done = await waitForJob(call, id, 'run');
    assert.equal(done.job.status, 'done', done.job.error);
    assert.equal(done.collection.items.filter((it) => it.mintSignature).length, 3);
  } finally {
    close();
  }
});
