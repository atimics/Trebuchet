import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyToken2022Extensions,
  RAYDIUM_CLMM_ALLOWED_TOKEN2022_EXTENSIONS,
  RAYDIUM_CLMM_MINT_WHITELIST,
  EXTENSION_DISPLAY_NAMES,
} from '../lpMintCompat.js';

// A non-whitelisted mint address
const SOME_MINT = '7GC5uBoR9YpQkLmXwN3vFj2HsTdA6cE1xZ8pW4yUqRmV';

// PYUSD mint (whitelisted)
const PYUSD_MINT = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';

// AUSD mint (whitelisted)
const AUSD_MINT = 'AUSD1jCcCyPLybk1YnvPWsHQSrZ46dxwoMniN4N2UEB9';

test('empty extensions → compatible', () => {
  const result = classifyToken2022Extensions([], SOME_MINT);
  assert.equal(result.compatible, true);
  assert.equal(result.whitelisted, false);
  assert.deepEqual(result.disallowed, []);
  assert.deepEqual(result.disallowedNames, []);
});

test('all allowed extensions → compatible', () => {
  const allowed = ['TransferFeeConfig', 'MetadataPointer', 'TokenMetadata'];
  const result = classifyToken2022Extensions(allowed, SOME_MINT);
  assert.equal(result.compatible, true);
  assert.deepEqual(result.disallowed, []);
});

test('single disallowed extension → incompatible', () => {
  const result = classifyToken2022Extensions(['PermanentDelegate'], SOME_MINT);
  assert.equal(result.compatible, false);
  assert.deepEqual(result.disallowed, ['PermanentDelegate']);
  assert.deepEqual(result.disallowedNames, ['PermanentDelegate']);
});

test('multiple disallowed extensions → all reported', () => {
  const extensions = [
    'TransferFeeConfig',   // allowed
    'PermanentDelegate',   // disallowed
    'TransferHook',        // disallowed
    'MetadataPointer',     // allowed
    'ImmutableOwner',      // disallowed
  ];
  const result = classifyToken2022Extensions(extensions, SOME_MINT);
  assert.equal(result.compatible, false);
  assert.deepEqual(result.disallowed, ['PermanentDelegate', 'TransferHook', 'ImmutableOwner']);
  assert.equal(result.disallowedNames.length, 3);
});

test('unknown extension names → reported with prefix', () => {
  const result = classifyToken2022Extensions(['SomeFutureExtension'], SOME_MINT);
  assert.equal(result.compatible, false);
  assert.deepEqual(result.disallowedNames, ['extension:SomeFutureExtension']);
});

test('PYUSD with disallowed extensions → compatible via whitelist', () => {
  const extensions = [
    'TransferFeeConfig',
    'PermanentDelegate',
    'ConfidentialTransferMint',
    'TransferHook',
    'MetadataPointer',
    'TokenMetadata',
    'ConfidentialTransferFeeConfig',
    'ConfidentialTransferFeeAmount',
  ];
  const result = classifyToken2022Extensions(extensions, PYUSD_MINT);
  assert.equal(result.compatible, true);
  assert.equal(result.whitelisted, true);
  assert.deepEqual(result.disallowed, []);
  assert.equal(result.whitelistedDespite.length, 5);
  // The disallowed extensions should appear in whitelistedDespite
  assert.ok(result.whitelistedDespite.includes('PermanentDelegate'));
  assert.ok(result.whitelistedDespite.includes('ConfidentialTransferMint'));
  assert.ok(result.whitelistedDespite.includes('TransferHook'));
});

test('AUSD with disallowed extensions → compatible via whitelist', () => {
  const result = classifyToken2022Extensions(
    ['PermanentDelegate', 'TransferHook'],
    AUSD_MINT,
  );
  assert.equal(result.compatible, true);
  assert.equal(result.whitelisted, true);
});

test('whitelisted match is case-sensitive and exact', () => {
  // A typo'd or near-miss address should NOT match
  const nearMiss = PYUSD_MINT.slice(0, -1) + 'X';
  const result = classifyToken2022Extensions(['PermanentDelegate'], nearMiss);
  assert.equal(result.compatible, false);
  assert.equal(result.whitelisted, false);
});

test('whitelist does not apply to non-whitelisted mint with disallowed extensions', () => {
  const result = classifyToken2022Extensions(['PermanentDelegate'], SOME_MINT);
  assert.equal(result.compatible, false);
  assert.equal(result.whitelisted, false);
  assert.equal(result.whitelistedDespite.length, 0);
});

test('disallowedNames uses display names from the map', () => {
  const result = classifyToken2022Extensions(['NonTransferable'], SOME_MINT);
  assert.equal(result.disallowedNames[0], 'NonTransferable (soulbound)');
});

test('whitelist has exactly 6 entries', () => {
  assert.equal(RAYDIUM_CLMM_MINT_WHITELIST.size, 6);
});

test('allowlist includes ScaledUiAmount variants', () => {
  assert.ok(RAYDIUM_CLMM_ALLOWED_TOKEN2022_EXTENSIONS.has('ScaledUiAmount'));
  assert.ok(RAYDIUM_CLMM_ALLOWED_TOKEN2022_EXTENSIONS.has('ScaledUiAmountConfig'));
});
