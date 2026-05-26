import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectLogoImageMime,
  normalizeTokenDescription,
  normalizeLogoImageMime,
  normalizeTokenName,
  normalizeTokenSymbol,
  normalizeWholeTokenSupply,
} from '../validators.js';

test('normalizes token metadata fields', () => {
  assert.equal(normalizeTokenName('  Test Token  '), 'Test Token');
  assert.equal(normalizeTokenSymbol(' tok '), 'tok');
  assert.equal(normalizeTokenDescription('  hello  '), 'hello');
});

test('rejects token metadata fields that exceed on-chain limits', () => {
  assert.throws(() => normalizeTokenName('x'.repeat(33)), /32 UTF-8 bytes/);
  assert.throws(() => normalizeTokenSymbol('x'.repeat(11)), /10 UTF-8 bytes/);
  assert.throws(() => normalizeTokenDescription('x'.repeat(1001)), /1000 UTF-8 bytes/);
});

test('keeps token supply as an integer string and strips commas', () => {
  assert.equal(normalizeWholeTokenSupply('1,000,000,000'), '1000000000');
});

test('rejects invalid and u64-overflowing token supplies', () => {
  assert.throws(() => normalizeWholeTokenSupply('0'), /positive whole number/);
  assert.throws(() => normalizeWholeTokenSupply('1.5'), /positive whole number/);
  assert.throws(() => normalizeWholeTokenSupply('18446744074'), /too large/);
});

test('sniffs uploaded logo image bytes instead of trusting MIME labels', () => {
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  ]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const html = Buffer.from('<script>alert(1)</script>');

  assert.equal(detectLogoImageMime(png), 'image/png');
  assert.equal(detectLogoImageMime(jpeg), 'image/jpeg');
  assert.equal(detectLogoImageMime(html), null);
  assert.throws(() => normalizeLogoImageMime(html), /PNG or JPG/);
});
