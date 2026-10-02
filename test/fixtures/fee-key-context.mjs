import { tokenTransferChain } from '../../packages/runtime/test/fixtures/token-transfer-chain.mjs';
import { LockClPositionLayoutV2, DEVNET_PROGRAM_ID, getPdaPersonalPositionAddress, getPdaLockClPositionIdV2 } from '@raydium-io/raydium-sdk-v2';
import { Keypair, PublicKey } from '@solana/web3.js';
import { sweepWallet, sweepDestination } from '../../packages/runtime/test/fixtures/sol-sweep-chain.mjs';
import { createProfileJournalStore } from '../../packages/runtime/src/profile-stores.js';
import { createWalletExecutionRuntime } from '../../walletExecution.js';
import { createFeeKeyExecutionRuntime } from '../../feeKeyExecution.js';

const key = (seed) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey.toBase58();
export const feeKeyPlan = { tokenMint: key(40), tokenTotalSupply: 1000, tokenDecimals: 6, targetMarketCapUsd: 10000, lockPositions: true,
  allocations: [{ quoteToken: 'SOL', supplyPercent: 100, distribution: [{ sharePercent: 100, recipient: sweepDestination }] }] };
export const feeKeyRequest = { poolId: key(42), allocationIndex: 0, sliceIndex: 0, positionNftMint: key(41), nftMint: key(34), recipient: sweepDestination };
export const feeKeyPosition = { sliceIndex: 0, nftMint: feeKeyRequest.positionNftMint, feeKeyNftMint: feeKeyRequest.nftMint, recipient: sweepDestination, locked: true,
  transferredTo: null, txIds: { open: 'open-receipt', lock: 'lock-receipt', transfer: null } };
export function feeKeyContext({ owner, connection, recordProgress, network = 'devnet' }) {
  const journal = createProfileJournalStore(owner.profile), walletPublicKey = sweepWallet.publicKey.toBase58();
  if (!journal.activeForWallet(walletPublicKey)) {
    journal.start({ walletPublicKey });
    journal.upsertForWallet(walletPublicKey, { poolPlan: feeKeyPlan, lp: { partialResults: [{ allocationIndex: 0, poolId: key(42), mainPositions: [feeKeyPosition] }] } });
  }
  const events = [];
  const walletExecution = createWalletExecutionRuntime({ owner, getScopeId: (wallet) => journal.activeForWallet(wallet)?.id,
    networkForRequest: () => network, createConnection: () => connection, timeoutMs: 0 });
  const feeKeyExecution = createFeeKeyExecutionRuntime({ owner, walletExecution, getJournal: (wallet) => journal.activeForWallet(wallet),
    getPosition: (wallet, allocation, slice) => {
      const result = journal.activeForWallet(wallet).lp.partialResults.find((item) => item.allocationIndex === allocation);
      return result && { ...result.mainPositions[slice], poolId: result.poolId };
    },
    recordProgress: recordProgress || ((wallet, event) => {
      const saved = journal.activeForWallet(wallet);
      if (saved.lp.operationIds?.includes(event.operationId)) return;
      const result = saved.lp.partialResults[0].mainPositions[0];
      result.transferredTo = event.recipient; result.txIds.transfer = event.txId;
      journal.upsertForWallet(wallet, { lp: { ...saved.lp, operationIds: [...(saved.lp.operationIds || []), event.operationId] } }, event);
      events.push(event);
    }), networkForRequest: () => network, createConnection: () => connection,
  });
  return { journal, walletExecution, feeKeyExecution, events,
    input: { ...feeKeyPlan, tempWalletSecretKey: Array.from(sweepWallet.secretKey) } };
}


export function feeKeyChain() {
  const ledger = tokenTransferChain({ token2022: true, decimals: 0, sourceAmount: 1n, associatedSource: true });
  const lockProgram = DEVNET_PROGRAM_ID.CLMM_LOCK_PROGRAM_ID;
  const lockAddress = getPdaLockClPositionIdV2(lockProgram, ledger.mint).publicKey;
  const data = Buffer.alloc(LockClPositionLayoutV2.span);
  const fields = { ...LockClPositionLayoutV2.decode(data), lockOwner: sweepWallet.publicKey, poolId: new PublicKey(feeKeyRequest.poolId),
    positionId: getPdaPersonalPositionAddress(DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID, new PublicKey(feeKeyRequest.positionNftMint)).publicKey,
    lockNftMint: ledger.mint };
  const locked = { executable: false, rentEpoch: 0, lamports: 3_000_000, owner: lockProgram, data };
  const read = ledger.connection.getMultipleAccountsInfoAndContext;
  ledger.connection.getMultipleAccountsInfoAndContext = async (keys, options) => {
    LockClPositionLayoutV2.encode(fields, data);
    const response = await read(keys, options);
    response.value = response.value.map((value, index) => keys[index].equals(lockAddress) ? locked : value);
    return response;
  };
  return { ...ledger, locked, lockFields: fields };
}
