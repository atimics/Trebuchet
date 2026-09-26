import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlaceholderSweepDestination } from '../src/validators.js';

test('placeholder sweep destinations are detected', () => {
  assert.equal(isPlaceholderSweepDestination('11111111111111111111111111111116'), true);
  assert.equal(isPlaceholderSweepDestination('11111111111111111111111111111112'), true);
  assert.equal(isPlaceholderSweepDestination('11111111111111111111111111111111'), true);
});

test('real destinations are not flagged', () => {
  assert.equal(isPlaceholderSweepDestination('AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j'), false);
  assert.equal(isPlaceholderSweepDestination(''), false);
  assert.equal(isPlaceholderSweepDestination(null), false);
  assert.equal(isPlaceholderSweepDestination('FLY3ytMF4wyGQcVPo2RZ5FTFsf7JEBj4DrtucnRqrFLY'), false);
});

test('unsafe sweep destinations: placeholder, incinerator, and the launch wallet', async () => {
  const { unsafeSweepDestinationReason, INCINERATOR_ADDRESS } = await import('../src/validators.js');
  const launchWallet = 'ACksrjbzDigbMdvcmfjG2WimbaUWTWygiuvxnDGJkHpL';
  assert.match(unsafeSweepDestinationReason('11111111111111111111111111111116'), /placeholder/);
  assert.match(unsafeSweepDestinationReason(INCINERATOR_ADDRESS), /incinerator/);
  assert.match(unsafeSweepDestinationReason(launchWallet, { launchWallet }), /launch wallet itself/);
  assert.equal(unsafeSweepDestinationReason('AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j', { launchWallet }), null);
  // Blank is not unsafe: the host resolves it to the funding wallet.
  assert.equal(unsafeSweepDestinationReason(''), null);
});
