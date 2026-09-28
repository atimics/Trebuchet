// imageCache.js
//
// Disk cache for token logos fetched through /api/proxy-image. Logos come
// from slow public gateways (IPFS, Arweave, Irys) and were refetched every
// time the app started, so coin cards loaded blank and the gateways
// rate-limited us.
//
// Entries are keyed by a hash of the URL and stored under the config dir
// (image-cache/<hash>.img with a <hash>.json sidecar). Content-addressed
// URLs (IPFS, Arweave, Irys) never change, so they never expire; other URLs
// are kept for a week. A recent failure is remembered briefly so a dead
// gateway is not asked again on every render. The folder is capped at
// MAX_CACHE_BYTES, oldest first.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MAX_CACHE_BYTES = 100 * 1024 * 1024;
const MUTABLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;
const MEMORY_ENTRIES = 64;

const memory = new Map();
const failures = new Map();
let pruneTimer = null;

function cacheDir() {
  return path.join(process.env.TREBUCHET_CONFIG_DIR || __dirname, 'image-cache');
}

function keyFor(url) {
  return crypto.createHash('sha256').update(String(url)).digest('hex');
}

// IPFS/Arweave/Irys addresses name the content itself, so the bytes behind
// them never change.
export function isContentAddressed(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return /(^|\.)(arweave\.net|ar-io\.net|irys\.xyz)$/.test(host)
      || /(^|\.)ipfs\./.test(host)
      || host.endsWith('.ipfs.dweb.link')
      || host.endsWith('.ipfs.w3s.link')
      || parsed.pathname.startsWith('/ipfs/');
  } catch {
    return false;
  }
}

function fresh(meta, url) {
  if (!meta) return false;
  if (isContentAddressed(url)) return true;
  return Date.now() - Number(meta.fetchedAt || 0) < MUTABLE_TTL_MS;
}

function remember(key, entry) {
  memory.delete(key);
  memory.set(key, entry);
  while (memory.size > MEMORY_ENTRIES) memory.delete(memory.keys().next().value);
}

/** Cached { type, body } for a URL, or null. */
export function getCachedImage(url) {
  const key = keyFor(url);
  const hit = memory.get(key);
  if (hit && fresh(hit.meta, url)) {
    remember(key, hit);
    return { type: hit.meta.type, body: hit.body };
  }
  try {
    const base = path.join(cacheDir(), key);
    const meta = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'));
    if (!fresh(meta, url) || meta.url !== url) return null;
    const body = fs.readFileSync(`${base}.img`);
    remember(key, { meta, body });
    return { type: meta.type, body };
  } catch {
    return null;
  }
}

/** Store an image. Write failures are logged, never thrown. */
export function putCachedImage(url, { type, body }) {
  const key = keyFor(url);
  const meta = { url, type, bytes: body.length, fetchedAt: Date.now() };
  remember(key, { meta, body });
  failures.delete(key);
  try {
    const dir = cacheDir();
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, key);
    // Image first, then the sidecar that makes it visible, so a crash never
    // leaves a sidecar pointing at a half-written image.
    fs.writeFileSync(`${base}.img`, body);
    fs.writeFileSync(`${base}.json`, JSON.stringify(meta));
    schedulePrune();
  } catch (error) {
    console.warn(`imageCache: could not store ${url}: ${error.message}`);
  }
}

/** The last failure for a URL, if it happened within FAILURE_TTL_MS. */
export function recentImageFailure(url) {
  const key = keyFor(url);
  const failure = failures.get(key);
  if (!failure) return null;
  if (Date.now() - failure.at > FAILURE_TTL_MS) {
    failures.delete(key);
    return null;
  }
  return failure.message;
}

export function rememberImageFailure(url, message) {
  failures.set(keyFor(url), { at: Date.now(), message: String(message || 'failed') });
  while (failures.size > 500) failures.delete(failures.keys().next().value);
}

function schedulePrune() {
  if (pruneTimer) return;
  pruneTimer = setTimeout(() => {
    pruneTimer = null;
    pruneImageCache();
  }, 5000);
  pruneTimer.unref?.();
}

/** Remove the oldest entries until the folder is under maxBytes. */
export function pruneImageCache(maxBytes = MAX_CACHE_BYTES) {
  try {
    const dir = cacheDir();
    const entries = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.img'))
      .map((name) => {
        const file = path.join(dir, name);
        const stat = fs.statSync(file);
        return { base: file.slice(0, -4), size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (total <= maxBytes) break;
      for (const suffix of ['.json', '.img']) {
        try { fs.unlinkSync(entry.base + suffix); } catch { /* already gone */ }
      }
      total -= entry.size;
    }
    return total;
  } catch {
    return 0;
  }
}

// For tests: forget what is held in memory (the disk copy stays).
export function clearImageCacheMemory() {
  memory.clear();
  failures.clear();
}
