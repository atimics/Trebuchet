import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// Test #3: Vanity SSE endpoint doesn't clamp threads.
test('vanity SSE endpoint clamps threads to a sane maximum', () => {
  const serverPath = path.join(REPO, 'server.js');
  const src = readFileSync(serverPath, 'utf8');
  const routeMatch = src.match(/app\.get\('\/api\/generate-vanity-wallet-stream'[\s\S]*?\n\}\);/);
  assert.ok(routeMatch, 'vanity-stream route must exist');
  const routeHandler = routeMatch[0];
  const hasClamp = /Math\.min\(.*threads/.test(routeHandler) || /clamp\(.*threads/i.test(routeHandler);
  // FAILS: threads is passed through unclamped.
  assert.ok(hasClamp, 'vanity-stream must clamp threads before passing to C binary');
});

// Test #4: No single-flight guard on the grinder.
test('vanity keygen has single-flight guard against concurrent grinds', () => {
  const keygenPath = path.join(REPO, 'vanityKeygen.js');
  const src = readFileSync(keygenPath, 'utf8');
  const hasGuard = /inFlight/.test(src) || /inflight/i.test(src) || /concurrent/.test(src) || /active.?[Gg]rind/.test(src) || /pending/.test(src);
  // FAILS: no concurrency guard exists.
  assert.ok(hasGuard, 'vanityKeygen.js must have a single-flight guard');
});

// Test #8: getentropy failure aborts instead of using predictable seed.
test('vanity C binary does not fall back to gettimeofday on entropy failure', () => {
  const cPath = path.join(REPO, 'c', 'vanity_keygen.c');
  let src;
  try {
    src = readFileSync(cPath, 'utf8');
  } catch {
    return;
  }
  const hasGettimeofdayFallback = /gettimeofday/.test(src);
  // FAILS if gettimeofday is used as entropy fallback (produces guessable keys).
  assert.ok(!hasGettimeofdayFallback, 'vanity_keygen.c must not fall back to gettimeofday on entropy failure');
});
