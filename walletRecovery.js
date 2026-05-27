export const SOL_DUST_THRESHOLD = 0.001;

// "Effectively empty" = SOL below a small threshold and every token account
// at zero. NFTs are token accounts with decimals=0, so they are covered here.
export function isWalletEffectivelyEmpty(balance) {
  if (!balance || Number(balance.sol || 0) >= SOL_DUST_THRESHOLD) return false;
  for (const token of Object.values(balance.tokens || {})) {
    if (BigInt(token.amountRaw) > 0n) return false;
  }
  return true;
}
