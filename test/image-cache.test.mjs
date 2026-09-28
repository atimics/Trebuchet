// imageCache.js: logos survive a restart, expire only when their URL can
// change, remember recent failures, and stay under the size cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treb-image-cache-'));
process.env.TREBUCHET_CONFIG_DIR = dir;
const cache = await import('../imageCache.js');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

test('a stored logo is read back from disk after memory is cleared', () => {
  const url = 'https://gateway.irys.xyz/logo-a';
  cache.putCachedImage(url, { type: 'image/png', body: PNG });
  cache.clearImageCacheMemory();
  const hit = cache.getCachedImage(url);
  assert.equal(hit.type, 'image/png');
  assert.deepEqual(hit.body, PNG);
});

test('content-addressed URLs never expire; others expire after a week', () => {
  assert.equal(cache.isContentAddressed('https://ipfs.io/ipfs/bafy123'), true);
  assert.equal(cache.isContentAddressed('https://arweave.net/abc'), true);
  assert.equal(cache.isContentAddressed('https://gateway.irys.xyz/abc'), true);
  assert.equal(cache.isContentAddressed('https://example.com/logo.png'), false);

  const mutable = 'https://example.com/logo.png';
  const permanent = 'https://arweave.net/old-logo';
  cache.putCachedImage(mutable, { type: 'image/png', body: PNG });
  cache.putCachedImage(permanent, { type: 'image/png', body: PNG });
  // Age both sidecars by eight days.
  const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
  for (const file of fs.readdirSync(path.join(dir, 'image-cache')).filter((name) => name.endsWith('.json'))) {
    const full = path.join(dir, 'image-cache', file);
    const meta = JSON.parse(fs.readFileSync(full, 'utf8'));
    fs.writeFileSync(full, JSON.stringify({ ...meta, fetchedAt: old }));
  }
  cache.clearImageCacheMemory();
  assert.equal(cache.getCachedImage(mutable), null);
  assert.ok(cache.getCachedImage(permanent));
});

test('a recent failure is remembered, and a later success clears it', () => {
  const url = 'https://ipfs.io/ipfs/dead';
  assert.equal(cache.recentImageFailure(url), null);
  cache.rememberImageFailure(url, 'upstream 504');
  assert.equal(cache.recentImageFailure(url), 'upstream 504');
  cache.putCachedImage(url, { type: 'image/png', body: PNG });
  assert.equal(cache.recentImageFailure(url), null);
});

test('pruning removes the oldest logos first until under the cap', () => {
  const big = Buffer.alloc(1000, 7);
  const urls = ['https://arweave.net/p1', 'https://arweave.net/p2', 'https://arweave.net/p3'];
  urls.forEach((url, index) => {
    cache.putCachedImage(url, { type: 'image/png', body: big });
    const file = path.join(dir, 'image-cache', `${crypto.createHash('sha256').update(url).digest('hex')}.img`);
    const when = new Date(Date.now() - (10 - index) * 60_000);
    fs.utimesSync(file, when, when);
  });
  const total = cache.pruneImageCache(2500);
  assert.ok(total <= 2500, `cache is ${total} bytes`);
  cache.clearImageCacheMemory();
  assert.equal(cache.getCachedImage(urls[0]), null, 'the oldest logo is removed');
  assert.ok(cache.getCachedImage(urls[2]), 'the newest logo is kept');
});
