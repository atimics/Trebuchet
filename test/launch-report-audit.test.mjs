import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const lpSrc = readFileSync(path.join(REPO, 'lpService.js'), 'utf8');
const demoSrc = readFileSync(path.join(REPO, 'demoChainService.js'), 'utf8');

// ---------------------------------------------------------------------------
// Launch-report audit-record regression tests.
//
// The launch report is published permanently to Arweave so third parties can
// audit a launch against the Trebuchet principles (safe token contract,
// locked LP, concentrated LP). These tests pin the data plumbing that makes
// that audit possible:
//
//   1. The Fee Key NFT mint. Verified against the Raydium SDK source
//      (v0.1.144-alpha): lockPosition()'s extInfo carries lockNftMint — the
//      NEW NFT Burn & Earn mints while the position NFT moves into the lock
//      program's escrow. That lock NFT IS the Fee Key. It must be recorded
//      at lock time (it can't be cheaply recovered later) and it must be the
//      mint Phase 4 transfers (the escrowed position NFT is no longer in the
//      wallet).
//
//   2. Position tick ranges and pool parameters, which prove the
//      concentrated-LP shape without an RPC lookup.
//
//   3. The frontend's machine-readable launchData payload (dataVersion 5)
//      carrying per-position records, token-safety facts, airdrop rows, and
//      slice/ladder/support shape fields.
// ---------------------------------------------------------------------------

test('lpService records the Fee Key NFT mint at every lock site', () => {
  assert.ok(
    /function feeKeyMintFromLockResult\(/.test(lpSrc),
    'feeKeyMintFromLockResult helper must exist',
  );
  assert.ok(
    /lockRes\?\.extInfo\?\.lockNftMint/.test(lpSrc),
    'helper must read extInfo.lockNftMint (the SDK field verified against source)',
  );
  // One recording per position type: main (pos), ladder (lp), support (sp),
  // bootstrap (bs).
  // Locks now run through executeSdkTx (in-flight retry). The recording
  // reads the builder result off the retry value; on ADOPTION (a lock that
  // landed on a prior attempt but whose confirmation timed out) the builder
  // result is gone and the label is null — the Fee Key itself still reaches
  // the destination because the sweep enumerates every NFT by address.
  for (const v of ['pos', 'lp', 'sp', 'bs']) {
    assert.ok(
      lpSrc.includes(`${v}.feeKeyNftMint = lockR.skipped`) &&
        new RegExp(`${v}\\.feeKeyNftMint = lockR\\.skipped[\\s\\S]{0,400}\\(lockR\\.value\\.feeKey \\|\\| null\\)[\\s\\S]{0,80}feeKeyMintFromLockResult\\(lockR\\.value\\.res\\)`).test(lpSrc),
      `lock phase must record feeKeyNftMint on '${v}' records`,
    );
  }
});

test('Phase 4 transfers the Fee Key NFT, not the escrowed position NFT', () => {
  // The previous form of this pin asserted `feeKeyNftMint || pos.nftMint` —
  // i.e. it REQUIRED the fallback to the escrowed position NFT that the
  // test's own title says must never be transferred. With lock adoption
  // able to leave feeKeyNftMint null, that fallback became reachable, so
  // Phase 4 now recovers the Fee Key from the lock program and, failing
  // that, records a clear failure instead of attempting a doomed transfer.
  assert.doesNotMatch(lpSrc, /const feeKeyMint = pos\.feeKeyNftMint \|\| pos\.nftMint;/,
    'transferFeeKeys must NEVER fall back to the escrowed position NFT');
  assert.match(lpSrc, /let feeKeyMint = pos\.feeKeyNftMint \|\| null;[\s\S]{0,300}findLockFeeKeyForPosition\(raydium, pos\.nftMint\)/,
    'a missing Fee Key mint is recovered from the lock program before giving up');
  assert.match(lpSrc, /Fee Key mint could not be identified for this locked position/,
    'and an unrecoverable one is recorded as a clear, actionable failure');
  assert.ok(
    /nftMint: feeKeyMint,\r?\n\s*recipient: pos\.recipient,/.test(lpSrc),
    'the transfer call must use the Fee Key mint',
  );
});

test('lpService records concentration-proof fields', () => {
  // Main positions carry their tick range (ladder/support/bootstrap already
  // did or do now).
  assert.ok(
    /tickLower: mainTicks\.tickLower,\r?\n\s*tickUpper: mainTicks\.tickUpper,/.test(lpSrc),
    'main position records must include the tick range',
  );
  assert.ok(
    /tickLower: bsTicks\.tickLower,\r?\n\s*tickUpper: bsTicks\.tickUpper,/.test(lpSrc),
    'bootstrap record must include the tick range',
  );
  // Pool-level parameters on the public result entry.
  assert.ok(
    /tickSpacing,\r?\n\s*initialPrice: initialPrice\.toString\(\),/.test(lpSrc),
    'pool result must expose tickSpacing and initialPrice',
  );
});

test('demo mode mirrors the audit fields (report parity)', () => {
  assert.ok(
    (demoSrc.match(/feeKeyNftMint = demoAddress\(\)/g) || []).length >= 4,
    'demo locks must mint distinct Fee Key NFTs for all four position types',
  );
  assert.ok(
    /const demoFeeKeyMint = pos\.feeKeyNftMint \|\| pos\.nftMint;/.test(demoSrc),
    'demo Phase 4 must remove the Fee Key mint from the wallet',
  );
});

test('the lock retry probe requires POSITIVE on-chain evidence of a lock', () => {
  // Regression pin for the most dangerous failure direction in the launch:
  // inferring "already locked" from the position's ABSENCE in the wallet.
  // Absence also happens when the RPC hasn't indexed the position yet;
  // treating it as locked skips the lock, leaves liquidity unlocked, and
  // reports it locked. The probe must ask the lock program for a lock
  // account naming this position, and adopt only when one exists.
  assert.doesNotMatch(lpSrc, /function positionNoLongerOwned/,
    'the absence-based lock probe must not exist');
  assert.match(lpSrc, /async function positionLockedOnChain\(raydium, nftMint\)[\s\S]{0,400}findLockFeeKeyForPosition\(raydium, nftMint\)/,
    'the lock probe must consult the lock program for positive evidence');
  const probeUses = (lpSrc.match(/alreadyDone: \(\) => positionLockedOnChain\(raydium, \w+\.nftMint\)/g) || []).length;
  assert.equal(probeUses, 4, 'all four lock sites use the positive-evidence probe');
});
