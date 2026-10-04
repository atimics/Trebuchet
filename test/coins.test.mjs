import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCoins } from '../coinService.js';

const RUG = 'RUGx1zSD7LCVqFgTYQWNiJKSkDcfN3yRR5XoFoAXRUG';
const OTHER = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

test('coins merge drafts, launches, and coins added by address', () => {
  const coins = mergeCoins({
    launches: [
      { id: 'draft-1', updatedAt: '2026-09-27T01:00:00Z', config: { token: { name: 'Pumpkin', symbol: 'PMPK' } } },
      // Launched since: shown once, as the on-chain coin.
      { id: 'draft-2', updatedAt: '2026-09-26T20:00:00Z', config: { token: { name: 'RUGOWEEN', symbol: 'RUG' } } },
      { id: 'draft-3', updatedAt: '2026-09-27T02:00:00Z', config: { token: { name: 'Ghost', symbol: 'GHST' }, vanity: { selectedPublicKey: 'GhoSt1111111111111111111111111111111111111' } } },
    ],
    journals: [
      { id: 'j1', status: 'completed', updatedAt: '2026-09-26T22:00:00Z', token: { mint: RUG }, launchConfig: { token: { name: 'RUGOWEEN', symbol: 'RUG' } } },
      { id: 'j2', status: 'completed', updatedAt: '2026-09-26T22:00:00Z', token: { mint: 'DemoMint111111111111111111111111111111111' }, launchConfig: { token: { name: 'Practice', symbol: 'PRAC' } } },
    ],
    added: [
      { mint: RUG, name: 'RUGOWEEN', symbol: 'RUG', source: 'added', events: [{ type: 'support_added' }] },
      { mint: OTHER, name: 'USD Coin', symbol: 'USDC', source: 'added', updatedAt: '2026-09-25T00:00:00Z', events: [] },
      { mint: 'Gone111111111111111111111111111111111111111', source: 'added', hidden: true, events: [] },
    ],
  });
  const byKey = Object.fromEntries(coins.map((coin) => [coin.key, coin]));
  assert.deepEqual(Object.keys(byKey).sort(), ['draft:draft-1', 'draft:draft-3', `mint:${OTHER}`, `mint:${RUG}`].sort());
  // A record is a claim: the list says what it claims until the chain is read.
  assert.equal(byKey[`mint:${RUG}`].status, 'Launched');
  assert.equal(byKey[`mint:${RUG}`].launchedHere, true);
  assert.equal(byKey[`mint:${RUG}`].eventCount, 1);
  assert.equal(byKey[`mint:${OTHER}`].status, 'Added');
  assert.equal(byKey['draft:draft-1'].status, 'Draft');
  assert.equal(byKey['draft:draft-3'].status, 'Address reserved');
  assert.equal(coins[0].key, 'draft:draft-3', 'most recently touched first');
});

test('practice coins appear only in Practice', () => {
  const journals = [{ id: 'j', status: 'completed', token: { mint: 'DemoMint111111111111111111111111111111111' }, launchConfig: { token: { name: 'P', symbol: 'P' } } }];
  assert.equal(mergeCoins({ journals, practice: false }).length, 0);
  assert.equal(mergeCoins({ journals, practice: true })[0].practice, true);
});

test('a stand-in placeholder image URL is not a coin image', async () => {
  const { realImageUrl } = await import('../coinService.js');
  assert.equal(realImageUrl('https://gateway.irys.xyz/placeholder-token-image'), null);
  assert.equal(realImageUrl(''), null);
  assert.equal(realImageUrl('https://gateway.irys.xyz/-pEACkpm9px9ThmiXCZ'), 'https://gateway.irys.xyz/-pEACkpm9px9ThmiXCZ');
});
