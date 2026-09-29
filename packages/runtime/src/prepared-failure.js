import bs58 from 'bs58';
import { VersionedTransaction } from '@solana/web3.js';
import { inspectSolanaTransaction } from './solana.js';
import { publicJson } from './store.js';

const fail = (message) => Object.assign(new Error(message), { code: 'CHAIN_STATE_UNAVAILABLE' });
const whole = (value) => Number.isSafeInteger(value) && value >= 0;
const equal = (a, b) => publicJson(a) === publicJson(b);

// A terminal status identifies the failed signature. This separate witness
// retains its full finalized message, fee, and atomic account effects while
// preserving the original engine operation and status receipt.
export function verifyPreparedFailure(store, operationId, witness) {
  const operation = store.getOperation(operationId), launch = operation && store.getLaunch(operation.launchId);
  const record = operation && store.getTransactions(operationId).find((tx) => tx.signature === operation.evidence?.signature);
  if (operation?.state !== 'failed' || record?.state !== 'failed' || !record.receipt?.error
      || record.receipt.commitment !== 'finalized' || !equal(record.receipt, operation.evidence.receipt)) throw fail('Recover the saved finalized failure identity');
  const signed = inspectSolanaTransaction(record.wire), transaction = VersionedTransaction.deserialize(Buffer.from(record.wire, 'base64'));
  const template = VersionedTransaction.deserialize(Buffer.from(operation.payload.template, 'base64'));
  template.message.recentBlockhash = record.blockhash;
  if (signed.signature !== record.signature || signed.blockhash !== record.blockhash || signed.walletPublicKey !== launch.walletPublicKey
      || !Buffer.from(template.message.serialize()).equals(Buffer.from(transaction.message.serialize()))
      || witness?.message !== Buffer.from(transaction.message.serialize()).toString('base64')
      || !equal(witness.signatures, transaction.signatures.map((bytes) => bs58.encode(bytes)))
      || !equal(witness.accountKeys, operation.payload.accountKeys) || !whole(witness.slot) || witness.slot !== record.receipt.slot
      || !equal(witness.error, record.receipt.error)) throw fail('Verify the failed transaction message, signature, accounts, and slot');
  const { preBalances, postBalances, feeLamports, accountKeys } = witness;
  if (!whole(feeLamports) || feeLamports > operation.payload.feeCeilingLamports || feeLamports > operation.payload.maxSpendLamports
      || !Array.isArray(preBalances) || !Array.isArray(postBalances) || preBalances.length !== accountKeys.length || postBalances.length !== accountKeys.length
      || [...preBalances, ...postBalances].some((n) => !whole(n))
      || preBalances.some((value, index) => value - postBalances[index] !== (index === 0 ? feeLamports : 0))) throw fail('Verify the fee and unchanged accounts of the failed transaction');
  const tokenRows = (rows) => {
    if (!Array.isArray(rows) || new Set(rows.map((row) => row.accountIndex)).size !== rows.length) throw fail('Read complete failed transaction token balances');
    return rows.map((row) => {
      const amount = row.uiTokenAmount?.amount, decimals = row.uiTokenAmount?.decimals;
      if (!whole(row.accountIndex) || row.accountIndex >= accountKeys.length || !row.mint || !row.owner || !row.programId
          || !whole(decimals) || decimals > 255 || typeof amount !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(amount)
          || BigInt(amount) > 18446744073709551615n) throw fail('Verify exact failed transaction token balances');
      return { accountIndex: row.accountIndex, mint: row.mint, owner: row.owner, programId: row.programId, amount, decimals };
    }).sort((a, b) => a.accountIndex - b.accountIndex);
  };
  if (!equal(tokenRows(witness.preTokenBalances), tokenRows(witness.postTokenBalances))) throw fail('Verify unchanged token balances after the failed transaction');
  return { operationId, txId: record.signature, slot: witness.slot, error: witness.error, feeLamports,
    spentLamports: feeLamports, grossDebitLamports: feeLamports, returnedLamports: 0, rentLamports: 0, receivedRaw: '0' };
}

export async function readPreparedFailure({ owner, store, connection, operationId, network, expectedGenesisHash }) {
  owner.assertActive();
  const operation = store.getOperation(operationId), launch = operation && store.getLaunch(operation.launchId);
  if (launch?.network !== network || launch?.config.genesisHash !== expectedGenesisHash || await connection.getGenesisHash() !== expectedGenesisHash) {
    throw Object.assign(new Error('Read the failed transaction from its saved chain'), { code: 'NETWORK_MISMATCH' });
  }
  const receipt = await connection.getTransaction(operation.evidence.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
  if (!receipt?.meta || typeof receipt.transaction?.message?.serialize !== 'function') throw fail('Read the full finalized failure receipt');
  const message = receipt.transaction.message, loaded = receipt.meta.loadedAddresses;
  const witness = { slot: receipt.slot, message: Buffer.from(message.serialize()).toString('base64'), signatures: receipt.transaction.signatures,
    accountKeys: [...message.staticAccountKeys, ...(loaded?.writable || []), ...(loaded?.readonly || [])].map((key) => key.toBase58()),
    error: receipt.meta.err, feeLamports: receipt.meta.fee, preBalances: receipt.meta.preBalances, postBalances: receipt.meta.postBalances,
    preTokenBalances: receipt.meta.preTokenBalances, postTokenBalances: receipt.meta.postTokenBalances };
  const evidence = verifyPreparedFailure(store, operationId, witness);
  owner.assertActive();
  return { ...evidence, witness };
}
