import { PublicKey } from '@solana/web3.js';
import {
  CLMM_PROGRAM_ID, CLMM_LOCK_PROGRAM_ID, CLMM_LOCK_AUTH_ID,
  DEVNET_PROGRAM_ID, LockClPositionLayoutV2, PositionInfoLayout,
  getPdaPersonalPositionAddress, getPdaLockClPositionIdV2,
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
      return { address: entry.pubkey.toBase58(), feeKeyMint: lock.lockNftMint.toBase58(), positionId: positionId.toBase58() };
    }
  }
  return null;
}
