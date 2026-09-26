import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedVanityAttempts } from '../packages/core/src/validators.js';
import { buildV2LaunchPlan } from '../v2LaunchPlan.js';

test('any-case odds divide by the base58 case variants per letter', () => {
  assert.equal(expectedVanityAttempts('RUG', 'RUG'), 58 ** 6);
  assert.equal(expectedVanityAttempts('RUG', 'RUG', { caseInsensitive: true }), Math.round(58 ** 6 / 64));
  // "L" has no base58 lowercase, "o" no uppercase, digits have one case.
  assert.equal(expectedVanityAttempts('L1o', '', { caseInsensitive: true }), 58 ** 3);
});

function plan(vanity) {
  return buildV2LaunchPlan({
    token: { name: 'Rug Case', symbol: 'RUG', supply: '1000000000' },
    mode: 'dry-run',
    launchSol: 1,
    walletPublicKey: '11111111111111111111111111111115',
    poolTopology: {
      targetMarketCapUsd: 250000,
      pools: [{ id: 'sol-main', quoteSymbol: 'SOL', quoteMint: 'So11111111111111111111111111111111111111112', supplyPercent: 100, distribution: [{ sharePercent: 100 }], ladder: { mode: 'off' }, support: { mode: 'off' } }],
      airdrop: { enabled: false, recipients: [], supplyPercent: 0 },
      report: { publish: false },
    },
    vanity,
  });
}

test('an any-case vanity address is accepted only when the plan says any case', () => {
  const address = 'rUgXq3Gm8tVbWcJzYkPn4HaD5sEfR7LmNq2TwxRuG';
  assert.throws(() => plan({ prefix: 'RUG', suffix: 'RUG', selectedPublicKey: address }), /does not start with RUG/);
  const accepted = plan({ prefix: 'RUG', suffix: 'RUG', caseInsensitive: true, selectedPublicKey: address });
  assert.equal(accepted.vanity.caseInsensitive, true);
});

test('exact-case plans keep their fingerprint shape (no caseInsensitive key)', () => {
  const exact = plan({ prefix: 'RUG', suffix: '' });
  assert.equal('caseInsensitive' in exact.vanity, false);
});

test('the grinder honors --case-insensitive', { timeout: 120000 }, async () => {
  const { generateVanityKeypair } = await import('../vanityKeygen.js');
  const result = await generateVanityKeypair({ prefix: 'rug', caseInsensitive: true });
  assert.equal(result.publicKey.slice(0, 3).toLowerCase(), 'rug');
});
