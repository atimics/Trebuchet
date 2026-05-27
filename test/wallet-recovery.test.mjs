import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isWalletEffectivelyEmpty,
  SOL_DUST_THRESHOLD,
} from '../walletRecovery.js';

test('treats a wallet below SOL dust and with no tokens as effectively empty', () => {
  assert.equal(isWalletEffectivelyEmpty({ sol: SOL_DUST_THRESHOLD - 0.000001, tokens: {} }), true);
  assert.equal(isWalletEffectivelyEmpty({ sol: 0, tokens: undefined }), true);
});

test('keeps recovery entry when SOL is at or above the dust threshold', () => {
  assert.equal(isWalletEffectivelyEmpty({ sol: SOL_DUST_THRESHOLD, tokens: {} }), false);
  assert.equal(isWalletEffectivelyEmpty({ sol: 1, tokens: {} }), false);
});

test('keeps recovery entry when any token or NFT account has a balance', () => {
  assert.equal(
    isWalletEffectivelyEmpty({
      sol: 0,
      tokens: {
        token: { amountRaw: '1' },
      },
    }),
    false,
  );

  assert.equal(
    isWalletEffectivelyEmpty({
      sol: 0,
      tokens: {
        nft: { amountRaw: '1', decimals: 0 },
      },
    }),
    false,
  );
});

test('ignores zero-balance token accounts when deciding recovery cleanup', () => {
  assert.equal(
    isWalletEffectivelyEmpty({
      sol: 0,
      tokens: {
        tokenA: { amountRaw: '0' },
        tokenB: { amountRaw: 0 },
      },
    }),
    true,
  );
});

test('does not treat missing balance data as empty', () => {
  assert.equal(isWalletEffectivelyEmpty(null), false);
  assert.equal(isWalletEffectivelyEmpty(undefined), false);
});
