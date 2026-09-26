import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const appJs = fs.readFileSync(new URL('../public/v2/app.js', import.meta.url), 'utf8');
const swapJs = fs.readFileSync(new URL('../swapService.js', import.meta.url), 'utf8');

// Pull the helper out of the browser bundle and run it.
const source = appJs.match(/function optionalDecimals\(value\) \{[\s\S]*?\n\}/)[0];
const optionalDecimals = new Function(`${source}; return optionalDecimals;`)();

test('unknown quote decimals stay undefined instead of becoming 0', () => {
  assert.equal(optionalDecimals(null), undefined);
  assert.equal(optionalDecimals(undefined), undefined);
  assert.equal(optionalDecimals(''), undefined);
  assert.equal(optionalDecimals('abc'), undefined);
  assert.equal(optionalDecimals(6), 6);
  assert.equal(optionalDecimals('0'), 0);
});

test('funding and plan allocations use the null-safe decimals helper', () => {
  assert.doesNotMatch(appJs, /Number\.isFinite\(Number\(pool\.quoteDecimals\)\)/);
  assert.doesNotMatch(appJs, /Number\.isFinite\(Number\(pool\.quoteDecimalsOverride \?\? pool\.quoteDecimals\)\)/);
  assert.match(appJs, /const quoteDecimalsOverride = optionalDecimals\(pool\.quoteDecimals\);/);
});

test('route price cache is keyed by mint and decimals', () => {
  assert.match(swapJs, /const cacheKey = `\$\{quoteMint\}:\$\{quoteDecimals\}`;/);
  assert.doesNotMatch(swapJs, /routeDiscoveryCache\.(get|has|set)\(quoteMint/);
});
