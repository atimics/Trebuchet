import { ComputeBudgetInstruction, ComputeBudgetProgram, PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, NATIVE_MINT } from '@solana/spl-token';
import { inspectSolanaTransaction } from './solana.js';

const paused = (message) => Object.assign(new Error(message), { code: 'CHAIN_STATE_UNAVAILABLE' });
const raw = (value) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 20 || BigInt(value) > (1n << 64n) - 1n) throw paused('Read exact token balances from the saved receipt');
  return BigInt(value);
};

// Read and verify a transfer made by the earlier airdrop sender. Its original
// signed message and finalized balance changes form the migration evidence.
export async function readObservedAirdrop({ connection, expectedGenesisHash, walletPublicKey, tokenMint, programId, decimals, recipient, amountRaw, signature }) {
  if (await connection.getGenesisHash() !== expectedGenesisHash) throw paused('Use the saved airdrop network');
  const response = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  const status = response?.value?.[0];
  if (!Number.isSafeInteger(response?.context?.slot) || !Array.isArray(response.value) || response.value.length !== 1
      || status?.confirmationStatus !== 'finalized' || status.err !== null || !Number.isSafeInteger(status.slot) || status.slot < 0 || response.context.slot < status.slot) throw paused('Read the finalized saved airdrop signature');
  const receipt = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
  if (!receipt || receipt.slot !== status.slot || receipt.meta?.err !== null || receipt.transaction?.signatures?.[0] !== signature
      || receipt.transaction.message?.version !== 'legacy') throw paused('Read the complete original airdrop transaction');
  const message = receipt.transaction.message, transaction = Transaction.populate(message, receipt.transaction.signatures);
  const inspected = inspectSolanaTransaction(transaction.serialize());
  if (inspected.signature !== signature || inspected.walletPublicKey !== walletPublicKey || transaction.instructions.length !== 4) throw paused('Verify the original airdrop signer and instructions');
  const wallet = new PublicKey(walletPublicKey), mint = new PublicKey(tokenMint), program = new PublicKey(programId), destinationWallet = new PublicKey(recipient);
  const source = getAssociatedTokenAddressSync(mint, wallet, false, program), destination = getAssociatedTokenAddressSync(mint, destinationWallet, false, program);
  let units, microLamports;
  try {
    units = ComputeBudgetInstruction.decodeSetComputeUnitLimit(transaction.instructions[0]).units;
    microLamports = ComputeBudgetInstruction.decodeSetComputeUnitPrice(transaction.instructions[1]).microLamports;
  } catch { throw paused('Verify the original airdrop fee instructions'); }
  const expected = new Transaction({ feePayer: wallet, recentBlockhash: message.recentBlockhash }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    createAssociatedTokenAccountIdempotentInstruction(wallet, destination, destinationWallet, mint, program),
    createTransferCheckedInstruction(source, mint, destination, wallet, raw(amountRaw), decimals, [], program),
  );
  if (!Buffer.from(message.serialize()).equals(Buffer.from(expected.compileMessage().serialize()))) throw paused('Match the saved airdrop signature to its exact recipient and amount');
  const keys = message.staticAccountKeys.map((key) => key.toBase58()), sourceIndex = keys.indexOf(source.toBase58()), destinationIndex = keys.indexOf(destination.toBase58()), meta = receipt.meta;
  if (sourceIndex < 1 || destinationIndex < 1 || !Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances)
      || meta.preBalances.length !== keys.length || meta.postBalances.length !== keys.length
      || [...meta.preBalances, ...meta.postBalances, meta.fee].some((value) => !Number.isSafeInteger(value) || value < 0)) throw paused('Read complete airdrop lamport balances');
  const balance = (rows, index, owner, optional = false) => {
    if (!Array.isArray(rows)) throw paused('Read complete airdrop token balances');
    const matches = rows.filter((entry) => entry.accountIndex === index);
    if (!matches.length && optional) return 0n;
    const entry = matches[0];
    if (matches.length !== 1 || entry.mint !== tokenMint || entry.uiTokenAmount?.decimals !== decimals
        || (entry.owner !== undefined && entry.owner !== owner) || (entry.programId !== undefined && entry.programId !== programId)) throw paused('Verify the saved airdrop token identities');
    return raw(entry.uiTokenAmount.amount);
  };
  const sent = balance(meta.preTokenBalances, sourceIndex, walletPublicKey) - balance(meta.postTokenBalances, sourceIndex, walletPublicKey);
  const received = balance(meta.postTokenBalances, destinationIndex, recipient) - balance(meta.preTokenBalances, destinationIndex, recipient, true);
  const rent = meta.preBalances[0] - meta.postBalances[0] - meta.fee, nativeAmount = mint.equals(NATIVE_MINT) ? sent : 0n;
  if (sent !== raw(amountRaw) || received < 0n || received > sent || rent < 0
      || BigInt(meta.postBalances[destinationIndex]) - BigInt(meta.preBalances[destinationIndex]) !== BigInt(rent) + nativeAmount
      || BigInt(meta.preBalances[sourceIndex]) - BigInt(meta.postBalances[sourceIndex]) !== nativeAmount) throw paused('Verify the saved airdrop debit, credit, fee, and account rent');
  if (await connection.getGenesisHash() !== expectedGenesisHash) throw paused('Keep the saved airdrop network during receipt verification');
  return { signature, txId: signature, slot: receipt.slot, wire: inspected.wire, walletPublicKey, tokenMint, programId, decimals,
    recipient, amountRaw, receivedRaw: received.toString(), transferFeeRaw: (sent - received).toString(), feeLamports: meta.fee, rentLamports: rent };
}
