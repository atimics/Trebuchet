import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { deterministicKeypair } from './helpers/mockSolana.mjs';

const profile = mkdtempSync(path.join(tmpdir(), 'trebuchet-fee-config-'));
process.env.TREBUCHET_CONFIG_DIR = profile;
const lp = await import('../lpService.js');
const { WSOL_MINT } = await import('../lpConstants.js');
test.afterEach(() => lp.resetTestFactories());
test.after(() => rmSync(profile, { recursive: true, force: true }));

for (const dynamicFeeControl of [0, 1]) {
  test(`pool creation reaches the SDK with a ${dynamicFeeControl ? 'dynamic' : 'fixed'} fee config`, async (t) => {
    const owner = deterministicKeypair(41);
    const mint = deterministicKeypair(42).publicKey;
    const configKey = deterministicKeypair(43).publicKey;
    const config = { id: configKey.toBase58(), index: 1, tickSpacing: 60,
      tradeFeeRate: 2500, dynamicFeeControl };
    const mintData = Buffer.alloc(82);
    mintData[44] = 9;
    mintData[45] = 1;
    mintData.writeBigUInt64LE(1_000_000_000_000_000_000n, 36);
    const stages = [], logs = [], requests = [];
    const reachedBuilder = new Error('Pool builder reached');
    t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    t.mock.method(globalThis, 'fetch', async (url) => {
      assert.match(String(url), /price\/v3\?ids=/);
      return new Response(JSON.stringify({ [WSOL_MINT]: { usdPrice: 200 } }));
    });
    lp.setSdkFactoryForTests(async () => ({
      connection: {
        getAccountInfo: async (key) => {
          assert.equal(key.toBase58(), mint.toBase58());
          return { owner: TOKEN_PROGRAM_ID, data: mintData };
        },
        getRecentPrioritizationFees: async () => [],
      },
      api: { getClmmConfigs: async () => [config] },
      clmm: { createPool: async (request) => { requests.push(request); throw reachedBuilder; } },
    }));

    // Exercise the public orchestrator through its first pool build. The SDK
    // boundary stops the fixture before transaction construction or sending.
    await assert.rejects(lp.createPoolsAndPositions({
      tempWalletSecretKey: [...owner.secretKey], tokenMint: mint.toBase58(),
      tokenDecimals: 9, tokenTotalSupply: '1000000000', targetMarketCapUsd: 25000,
      allocations: [{ quoteToken: 'SOL', supplyPercent: 100, ammConfigIndex: 1,
        distribution: [{ sharePercent: 100 }], bootstrap: { mode: 'minimal' } }],
      onProgress: (event) => stages.push(event.stage),
    }), (error) => error === reachedBuilder);
    assert.ok(stages.includes('lp_quote_resolved'));
    assert.ok(stages.includes('pool_create_start'));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].ammConfig.id.toBase58(), configKey.toBase58());
    assert.equal(requests[0].ammConfig.dynamicFeeControl, dynamicFeeControl);
    assert.equal(logs.some((line) => line.includes('DYNAMIC fee config')), Boolean(dynamicFeeControl));
  });
}
