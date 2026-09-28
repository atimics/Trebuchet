import test from 'node:test';
import assert from 'node:assert/strict';

const { buildV2ExecutionReadiness } = await import('../v2LaunchPlan.js');

function config(sweepDestination) {
  return {
    token: { name: 'Sweep Default', symbol: 'SWP', supply: '1000000000' },
    mode: 'guarded',
    launchSol: 1,
    walletPublicKey: 'ACksrjbzDigbMdvcmfjG2WimbaUWTWygiuvxnDGJkHpL',
    poolTopology: {
      targetMarketCapUsd: 250000,
      pools: [{ id: 'sol-main', quoteSymbol: 'SOL', quoteMint: 'So11111111111111111111111111111111111111112', supplyPercent: 100, distribution: [{ sharePercent: 100 }], ladder: { mode: 'off' }, support: { mode: 'off' } }],
      airdrop: { enabled: false, recipients: [], supplyPercent: 0 },
      report: { publish: false },
      ...(sweepDestination ? { sweepDestination } : {}),
    },
  };
}

function sweepReadiness(sweepDestination) {
  return buildV2ExecutionReadiness(config(sweepDestination), {
    demoMode: true,
    walletPublicKey: 'ACksrjbzDigbMdvcmfjG2WimbaUWTWygiuvxnDGJkHpL',
    walletAvailable: true,
    secretAvailable: true,
    tokenMint: 'FLY3ytMF4wyGQcVPo2RZ5FTFsf7JEBj4DrtucnRqrFLY',
    liquidityComplete: true,
  });
}

test('a blank return wallet still reaches the final sweep, aimed at the funding wallet', () => {
  const readiness = sweepReadiness('');
  assert.equal(readiness.nextEndpoint, '/api/transfer-assets');
  assert.equal(readiness.nextAction, 'Return assets to the funding wallet');
  assert.equal(readiness.classicPayloads.transferAssets.destinationWallet, null);
});

test('an explicit return wallet is used as the sweep destination', () => {
  const readiness = sweepReadiness('AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j');
  assert.equal(readiness.nextEndpoint, '/api/transfer-assets');
  assert.equal(readiness.classicPayloads.transferAssets.destinationWallet, 'AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j');
});

test('the live sweep handler resolves a blank destination to the funder and refuses unsafe ones', async () => {
  const { readFile } = await import('node:fs/promises');
  const services = await readFile(new URL('../launchExecution.js', import.meta.url), 'utf8');
  const handler = services.slice(services.indexOf('async function transferAssets('), services.indexOf('const nftSweep = await sweepNftsToDestination'));
  assert.match(handler, /findFundingWallet\(walletPublicKey\)/);
  assert.match(handler, /unsafeSweepDestinationReason\(destinationWallet, \{ launchWallet: walletPublicKey \}\)/);
});
