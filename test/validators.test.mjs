import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeTokenDescription,
  normalizeTokenName,
  normalizeTokenSymbol,
  normalizeWholeTokenSupply,
} from '../validators.js';

test('normalizes token metadata fields', () => {
  assert.equal(normalizeTokenName('  Test Token  '), 'Test Token');
  assert.equal(normalizeTokenSymbol(' tok '), 'TOK');
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
