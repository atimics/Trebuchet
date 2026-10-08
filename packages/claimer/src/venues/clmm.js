// Venue adapter: Raydium CLMM fee claiming (Burn & Earn).
//
// The lock program escrows a position NFT and mints a Fee Key NFT. The Fee
// Key holder claims the position's trading fees through the lock program.
// This module finds locks (reusing the identity logic kept in
// clmmLockEvidence.js), decodes them, and builds the harvest transaction.

import { PublicKey } from '@solana/web3.js';
import {
  CLMM_PROGRAM_ID,
  CLMM_LOCK_PROGRAM_ID,
  CLMM_LOCK_AUTH_ID,
  DEVNET_PROGRAM_ID,
  LockClPositionLayoutV2,
  getPdaPersonalPositionAddress,
  getPdaLockClPositionIdV2,
} from '@raydium-io/raydium-sdk-v2';

export function clmmLockPrograms(network = 'mainnet') {
  const ids = network === 'devnet'
    ? DEVNET_PROGRAM_ID
    : { CLMM_PROGRAM_ID, CLMM_LOCK_PROGRAM_ID, CLMM_LOCK_AUTH_ID };
  return {
    programId: ids.CLMM_LOCK_PROGRAM_ID,
    authProgramId: ids.CLMM_LOCK_AUTH_ID,
    poolProgramId: ids.CLMM_PROGRAM_ID,
  };
}

export function decodeClmmLock(entry, network = 'mainnet') {
  const { programId } = clmmLockPrograms(network);
  if (!entry?.account?.owner?.equals(programId)
      || entry.account.data?.length !== LockClPositionLayoutV2.span) return null;
  const lock = LockClPositionLayoutV2.decode(entry.account.data);
  const expected = getPdaLockClPositionIdV2(programId, lock.lockNftMint).publicKey;
  return entry.pubkey.equals(expected) ? lock : null;
}

// Recovery follows the position account, which stays fixed when the Fee Key moves.
export async function findClmmPositionLock(connection, nftMint, network = 'mainnet') {
  const mint = new PublicKey(nftMint);
  const { programId, poolProgramId } = clmmLockPrograms(network);
  const positionId = getPdaPersonalPositionAddress(poolProgramId, mint).publicKey;
  const info = await connection.getAccountInfo(positionId, 'finalized');
  const { PositionInfoLayout } = await import('@raydium-io/raydium-sdk-v2');
  if (!info?.owner?.equals(poolProgramId) || info.data?.length !== PositionInfoLayout.span) return null;
  const position = PositionInfoLayout.decode(info.data);
  if (!position.nftMint.equals(mint)) return null;
  const accounts = await connection.getProgramAccounts(programId, {
    commitment: 'finalized',
    filters: [
      { dataSize: LockClPositionLayoutV2.span },
      { memcmp: { offset: LockClPositionLayoutV2.offsetOf('positionId'), bytes: positionId.toBase58() } },
    ],
  });
  if (!Array.isArray(accounts)) throw new Error('Lock lookup requires a complete chain response');
  for (const entry of accounts) {
    const lock = decodeClmmLock(entry, network);
    if (lock?.positionId.equals(positionId) && lock.poolId.equals(position.poolId)) {
      return { address: entry.pubkey.toBase58(), feeKeyMint: lock.lockNftMint.toBase58(), positionId: positionId.toBase58(), lock };
    }
  }
  return null;
}

/**
 * Build the harvest (Burn & Earn fee claim) transaction for a locked
 * position. `raydium` is a loaded Raydium SDK instance; the harvested fees
 * land in the claimer's wallet. The returned transaction still needs a
 * recent blockhash and the signer's signature before sending.
 */
export async function buildClmmHarvest({ raydium, lockData, feePayer, txVersion }) {
  if (!lockData?.positionId || !lockData?.lockNftMint) {
    throw new Error('CLMM harvest needs a decoded lock (positionId + lockNftMint)');
  }
  return raydium.clmm.harvestLockPosition({
    lockData,
    ...(feePayer ? { feePayer: new PublicKey(feePayer) } : {}),
    ...(txVersion ? { txVersion } : {}),
    associatedOnly: true,
    checkCreateATAOwner: false,
  });
}