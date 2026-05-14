// Empirical test of getMintCompatibilityWithRaydiumClmm against mainnet data.
// Run with: node test-token2022-compat.mjs
//
// This validates that our compatibility check produces correct results
// against real on-chain mints — including the pump.fun mint that triggered
// the original failure and a few well-known controls. Not a unit test in
// the framework sense; it's a quick mainnet smoke test you can re-run any
// time you suspect Raydium changed their allowlist.

import { Connection, PublicKey } from '@solana/web3.js';
import { getMintCompatibilityWithRaydiumClmm } from './lpService.js';

// Public RPC works fine for read-only mint inspection — we're only doing
// getAccountInfo calls, no transactions. Set TREBUCHET_TEST_RPC if you
// need to use a paid/private RPC (the public one is rate-limited and may
// 429 if you spam-run this test).
const RPC = process.env.TREBUCHET_TEST_RPC || 'https://api.mainnet-beta.solana.com';

const TEST_MINTS = [
  {
    name: 'SOL (wrapped, classic SPL)',
    mint: 'So11111111111111111111111111111111111111112',
    expectCompatible: true,
    expectToken2022: false,
  },
  {
    name: 'USDC (classic SPL)',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    expectCompatible: true,
    expectToken2022: false,
  },
  {
    name: 'Cm6f...pump (the one that triggered our bug)',
    mint: 'Cm6fNnMk7NfzStP9CZpsQA2v3jjzbcYGAxdJySmHpump',
    expectCompatible: true, // should now pass given pump.fun's extension set
    expectToken2022: true,
  },
  {
    name: 'PYUSD (Token-2022, whitelisted by Raydium despite restricted extensions)',
    mint: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
    expectCompatible: true, // compatible because of Raydium's hardcoded whitelist
    expectToken2022: true,
    expectWhitelisted: true,
  },
];

async function main() {
  const connection = new Connection(RPC, 'confirmed');
  let allPassed = true;

  for (const tc of TEST_MINTS) {
    process.stdout.write(`${tc.name}\n  mint: ${tc.mint}\n`);
    try {
      const compat = await getMintCompatibilityWithRaydiumClmm(
        connection,
        new PublicKey(tc.mint),
      );
      console.log(`  programId: ${compat.programId.toBase58()}`);
      console.log(`  isToken2022: ${compat.isToken2022}`);
      console.log(`  extensions: [${compat.extensions.join(', ')}]`);
      console.log(`  compatible: ${compat.compatible}`);
      if (compat.whitelisted) {
        console.log(
          `  whitelisted: true (Raydium hardcoded; would otherwise fail on: ` +
            `${(compat.whitelistedDespite || []).join(', ') || 'no extensions'})`,
        );
      }
      if (!compat.compatible) {
        console.log(`  disallowed: [${compat.disallowedNames.join(', ')}]`);
      }

      const ok =
        compat.compatible === tc.expectCompatible &&
        compat.isToken2022 === tc.expectToken2022 &&
        (tc.expectWhitelisted === undefined ||
          !!compat.whitelisted === tc.expectWhitelisted);
      console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}`);
      if (!ok) allPassed = false;
    } catch (e) {
      console.log(`  ✗ ERROR: ${e.message}`);
      allPassed = false;
    }
    console.log();
  }

  console.log(allPassed ? '✓ all checks passed' : '✗ some checks failed');
  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
