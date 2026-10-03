import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { AccountLayout, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { CpAmm, CollectFeeMode, deriveCustomizablePoolAddress, derivePositionAddress } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import { dammV2PriceRange, verifyLockedPool } from '../dammV2Service.js';

function fixture(t) {
  const mint = Keypair.generate().publicKey, nft = Keypair.generate().publicKey;
  const pool = deriveCustomizablePoolAddress(mint, NATIVE_MINT), position = derivePositionAddress(nft);
  const vault = Keypair.generate().publicKey;
  const supplyRaw = 10n ** 18n, startingMarketCapLamports = 2_000n * 10n ** 9n, rangeMultiple = 1000;
  const range = dammV2PriceRange({ supplyRaw, startingMarketCapLamports, rangeMultiple });
  const expected = new CpAmm({}).preparePoolCreationSingleSide({ tokenAAmount: new BN(supplyRaw.toString()),
    minSqrtPrice: range.sqrtMinPrice, maxSqrtPrice: range.sqrtMaxPrice, initSqrtPrice: range.initSqrtPrice, collectFeeMode: CollectFeeMode.OnlyB });
  const poolState = { tokenAMint: mint, tokenBMint: NATIVE_MINT, tokenAVault: vault,
    collectFeeMode: CollectFeeMode.OnlyB, sqrtMinPrice: range.sqrtMinPrice, sqrtMaxPrice: range.sqrtMaxPrice };
  const positionState = { pool, nftMint: nft, unlockedLiquidity: new BN(0), permanentLockedLiquidity: expected };
  t.mock.method(CpAmm.prototype, 'fetchPoolState', async () => poolState);
  t.mock.method(CpAmm.prototype, 'fetchPositionState', async () => positionState);
  let amount = supplyRaw;
  const connection = { getAccountInfo: async (key) => {
    const data = Buffer.alloc(AccountLayout.span);
    if (key.equals(vault)) AccountLayout.encode({ mint, owner: pool, amount, delegateOption: 0,
      delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n,
      delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
    return { data, owner: TOKEN_2022_PROGRAM_ID };
  } };
  const input = { connection, pool, position, mint, positionNft: nft, supplyRaw, startingMarketCapLamports, rangeMultiple, recovery: true };
  return { input, positionState, poolState, buy: () => { amount -= 1n; } };
}

test('a buy preserves recovery of the original permanently locked position', async (t) => {
  const f = fixture(t);
  assert.equal((await verifyLockedPool(f.input)).passed, true);
  f.buy();
  const result = await verifyLockedPool(f.input);
  assert.equal(result.vaultHoldsSupply, false);
  assert.equal(result.lockedSupply, true);
  assert.equal(result.passed, true);
});

test('recovery checks the saved position, range, and original locked liquidity', async (t) => {
  const f = fixture(t);
  f.positionState.permanentLockedLiquidity = f.positionState.permanentLockedLiquidity.subn(1);
  assert.equal((await verifyLockedPool(f.input)).passed, false);
  f.positionState.permanentLockedLiquidity = f.positionState.permanentLockedLiquidity.addn(1);
  f.positionState.nftMint = Keypair.generate().publicKey;
  assert.equal((await verifyLockedPool(f.input)).passed, false);
  f.positionState.nftMint = f.input.positionNft;
  f.poolState.sqrtMinPrice = f.poolState.sqrtMinPrice.addn(1);
  assert.equal((await verifyLockedPool(f.input)).passed, false);
});
