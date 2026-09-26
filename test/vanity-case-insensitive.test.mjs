import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedVanityAttempts } from '../packages/core/src/validators.js';
import { buildV2LaunchPlan } from '../v2LaunchPlan.js';

test('odds account for first-character bias, case, and length', () => {
  // Measured on 300,000 real keypairs: "R" 1 in 1003, "R|r" 1 in 489, 43 chars 1 in 18.
  assert.ok(Math.abs(expectedVanityAttempts('R', '') - 1003) / 1003 < 0.05);
  assert.ok(Math.abs(expectedVanityAttempts('R', '', { caseInsensitive: true }) - 489) / 489 < 0.05);
  assert.equal(expectedVanityAttempts('', '', { length: 43 }), 18);
  // "A" is a common first character (1 in ~17), not 1 in 58.
  assert.ok(expectedVanityAttempts('A', '') < 20);
  // Suffixes are uniform.
  assert.equal(expectedVanityAttempts('', 'RUGRUG'), 58 ** 6);
  assert.ok(expectedVanityAttempts('RUG', 'RUG') > 6e11);
  assert.ok(expectedVanityAttempts('RUG', 'RUG', { caseInsensitive: true }) < expectedVanityAttempts('RUG', 'RUG') / 50);
  // "RUG" cannot start a 44-character address.
  assert.equal(expectedVanityAttempts('RUG', '', { length: 44 }), Infinity);
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

test('the grinder honors --length', { timeout: 120000 }, async () => {
  const { generateVanityKeypair } = await import('../vanityKeygen.js');
  const result = await generateVanityKeypair({ suffix: 'a', length: 43 });
  assert.equal(result.publicKey.length, 43);
  assert.ok(result.publicKey.endsWith('a'));
});

test('a plan with a length rejects an address of another length', () => {
  const address44 = '5igPsKHquNAYitDfDxwZFbr7iVPfuw3LVzwjX17zpump';
  assert.throws(() => plan({ suffix: 'pump', length: 43, selectedPublicKey: address44 }), /not 43 characters long/);
  assert.equal(plan({ suffix: 'pump', length: 44, selectedPublicKey: address44 }).vanity.length, 44);
});

test('the grinder honors --case-insensitive', { timeout: 120000 }, async () => {
  const { generateVanityKeypair } = await import('../vanityKeygen.js');
  const result = await generateVanityKeypair({ prefix: 'rug', caseInsensitive: true });
  assert.equal(result.publicKey.slice(0, 3).toLowerCase(), 'rug');
});
