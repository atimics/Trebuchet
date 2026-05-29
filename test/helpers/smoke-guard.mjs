// test/helpers/smoke-guard.mjs
//
// Guards mainnet smoke tests behind the TREBUCHET_SMOKE_TEST_RPC environment
// variable. Tests that import this module are skipped (not failed) when the
// env var is unset, making them safe to run in CI with no special config.
//
// Usage in a smoke test file:
//
//   import { requireSmokeRpc, SMOKE_RPC } from './helpers/smoke-guard.mjs';
//   const describe = requireSmokeRpc(import.meta.url);
//   // Tests run only when TREBUCHET_SMOKE_TEST_RPC is set.
//
// Environment variable reference:
//   TREBUCHET_SMOKE_TEST_RPC — mainnet RPC URL for smoke tests.
//     e.g. https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
//     If unset, all smoke tests are skipped.

const smokeRpc = process.env.TREBUCHET_SMOKE_TEST_RPC || null;

/**
 * Returns true if smoke tests should run. Prints a clear skip message
 * to stdout when the RPC env var is missing.
 */
export function smokeEnabled() {
  if (!smokeRpc) {
    console.log('[smoke] TREBUCHET_SMOKE_TEST_RPC not set — skipping smoke tests');
    return false;
  }
  console.log(`[smoke] using RPC: ${smokeRpc.slice(0, 50)}...`);
  return true;
}

export const SMOKE_RPC = smokeRpc;
