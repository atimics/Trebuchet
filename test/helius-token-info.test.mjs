// Helius getAsset parsing: the USD price and display fields Trebuchet reads
// when the configured RPC is Helius.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractPriceFromHeliusAsset,
  extractDisplayMetaFromHeliusAsset,
} from '../tokenInfoService.js';

test('Helius price is read from token_info.price_info in USDC', () => {
  const asset = { token_info: { price_info: { price_per_token: 0.0001919056, currency: 'USDC' } } };
  assert.equal(extractPriceFromHeliusAsset(asset).toString(), '0.0001919056');
});

test('Helius price is null when missing, zero, or not in USD', () => {
  assert.equal(extractPriceFromHeliusAsset(null), null);
  assert.equal(extractPriceFromHeliusAsset({ token_info: {} }), null);
  assert.equal(extractPriceFromHeliusAsset({ token_info: { price_info: { price_per_token: 0, currency: 'USDC' } } }), null);
  assert.equal(extractPriceFromHeliusAsset({ token_info: { price_info: { price_per_token: 2, currency: 'SOL' } } }), null);
});

test('Helius display meta gives the name and a usable logo URL', () => {
  const asset = { content: { metadata: { name: 'RUGOWEEN' }, links: { image: 'https://gateway.irys.xyz/abc' } } };
  assert.deepEqual(extractDisplayMetaFromHeliusAsset(asset), { name: 'RUGOWEEN', imageUrl: 'https://gateway.irys.xyz/abc' });
  assert.deepEqual(
    extractDisplayMetaFromHeliusAsset({ content: { metadata: { name: 'DEATON' }, links: { image: 'javascript:alert(1)' } } }),
    { name: 'DEATON', imageUrl: null },
  );
  assert.equal(extractDisplayMetaFromHeliusAsset({ content: {} }), null);
});
