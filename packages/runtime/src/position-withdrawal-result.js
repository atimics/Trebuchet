import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, unpackMint, unpackAccount } from '@solana/spl-token';
import { PositionInfoLayout } from '@raydium-io/raydium-sdk-v2';
import { inspectSolanaTransaction } from './solana.js';
import { publicJson } from './store.js';

const pk = (value) => new PublicKey(value);
const whole = (value) => Number.isSafeInteger(value) && value >= 0;
const equal = (a, b) => publicJson(a) === publicJson(b);
const fail = (message) => Object.assign(new Error(message), { code: 'CHAIN_STATE_UNAVAILABLE' });
const raw = (value) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 18446744073709551615n) throw fail('Read exact withdrawal token amounts');
  return BigInt(value);
};
const exactNumber = (value) => {
  const result = Number(value);
  if (!whole(result) || BigInt(result) !== BigInt(value)) throw fail('Keep returned withdrawal lamports exact');
  return result;
};

export function withdrawalReceiptWitness(receipt) {
  const { meta, transaction } = receipt, loaded = meta.loadedAddresses;
  return { slot: receipt.slot, message: Buffer.from(transaction.message.serialize()).toString('base64'), signatures: transaction.signatures,
    accountKeys: [...transaction.message.staticAccountKeys, ...(loaded?.writable || []), ...(loaded?.readonly || [])].map((key) => key.toBase58()),
    error: meta.err, feeLamports: meta.fee, preBalances: meta.preBalances, postBalances: meta.postBalances,
    preTokenBalances: meta.preTokenBalances, postTokenBalances: meta.postTokenBalances };
}

// This witness captures the atomic transaction. Later wallet transfers can
// change current balances while the original withdrawal receipt stays valid.
export function verifyWithdrawalEffects(plan, witness) {
  const keys = plan.accountKeys;
  const template = VersionedTransaction.deserialize(Buffer.from(plan.template, 'base64'));
  if (!witness || !whole(witness.slot) || witness.slot < plan.observedSlot || witness.error !== null || !equal(keys, witness.accountKeys)
      || !whole(witness.feeLamports) || witness.feeLamports > plan.feeCeilingLamports
      || !Array.isArray(witness.preBalances) || !Array.isArray(witness.postBalances)
      || witness.preBalances.length !== keys.length || witness.postBalances.length !== keys.length
      || [...witness.preBalances, ...witness.postBalances].some((n) => !whole(n))) throw fail('Read complete finalized withdrawal balances and fees');
  const index = (address) => {
    const result = keys.indexOf(address);
    if (result <= 0 || !template.message.isAccountWritable(result)) throw fail('Verify every writable withdrawal result account');
    return result;
  };
  const tokenRows = (rows) => {
    if (!Array.isArray(rows) || new Set(rows.map((row) => row.accountIndex)).size !== rows.length) throw fail('Read distinct withdrawal token balance rows');
    const mapped = new Map();
    for (const row of rows) {
      if (!whole(row.accountIndex) || row.accountIndex >= keys.length || !whole(row.uiTokenAmount?.decimals) || row.uiTokenAmount.decimals > 255
          || !row.mint || !row.owner || !row.programId) throw fail('Read complete withdrawal token balance identities');
      mapped.set(row.accountIndex, { ...row, amount: raw(row.uiTokenAmount.amount) });
    }
    return mapped;
  };
  const before = tokenRows(witness.preTokenBalances), after = tokenRows(witness.postTokenBalances);
  const amount = (rows, address, expected, optional = false) => {
    const found = rows.get(index(address));
    if (!found && optional) return 0n;
    if (!found || found.mint !== expected.mint || found.owner !== expected.owner || found.programId !== expected.programId
        || found.uiTokenAmount.decimals !== expected.decimals) throw fail('Verify the withdrawal receipt token identities');
    return found.amount;
  };
  const nft = { mint: plan.nftMint, owner: plan.walletPublicKey, programId: plan.nftProgramId, decimals: 0 };
  if (amount(before, plan.nftAccount, nft) !== 1n || amount(after, plan.nftAccount, nft, true) !== 0n) throw fail('Verify the position NFT burn');
  const closed = [plan.positionAddress, plan.nftAccount, ...(plan.nftProgramId === TOKEN_2022_PROGRAM_ID.toBase58() ? [plan.nftMint] : [])];
  let returnedRent = 0n;
  for (const address of closed) {
    const i = index(address);
    if (witness.preBalances[i] <= 0 || witness.postBalances[i] !== 0) throw fail('Verify the closed position accounts and their returned rent');
    returnedRent += BigInt(witness.preBalances[i]);
  }
  let nativeReceived = 0n, outputRent = 0n, temporaryRent = 0n;
  const received = [];
  for (const token of plan.tokens) {
    const i = index(token.destination), identity = { mint: token.mint, owner: plan.walletPublicKey, programId: token.programId, decimals: token.decimals };
    let receivedRaw;
    if (token.native) {
      if (witness.preBalances[i] !== 0 || witness.postBalances[i] !== 0 || before.has(i) || after.has(i)) throw fail('Verify the temporary SOL account was created and closed');
      receivedRaw = 0n;
      for (const vault of new Set(token.vaults)) {
        const vaultIdentity = { ...identity, owner: plan.poolId }, v = index(vault);
        const delta = amount(before, vault, vaultIdentity) - amount(after, vault, vaultIdentity);
        if (delta < 0n || BigInt(witness.preBalances[v]) - BigInt(witness.postBalances[v]) !== delta) throw fail('Verify the native vault payout in tokens and lamports');
        receivedRaw += delta;
      }
      nativeReceived += receivedRaw; temporaryRent += BigInt(token.rentLamports);
    } else {
      receivedRaw = amount(after, token.destination, identity) - amount(before, token.destination, identity, token.created);
      const rent = BigInt(witness.postBalances[i]) - BigInt(witness.preBalances[i]);
      if (rent < 0n || rent > BigInt(token.created ? token.rentLamports : 0)) throw fail('Verify the approved output account rent');
      outputRent += rent;
    }
    if (receivedRaw < raw(token.minimumRaw)) throw fail('Verify every approved withdrawal minimum');
    received.push({ mint: token.mint, programId: token.programId, decimals: token.decimals, destination: token.native ? plan.walletPublicKey : token.destination,
      native: token.native, receivedRaw: receivedRaw.toString(), minimumRaw: token.minimumRaw });
  }
  const rentLamports = exactNumber(outputRent + temporaryRent), returnedLamports = exactNumber(returnedRent + nativeReceived + temporaryRent);
  const grossDebitLamports = exactNumber(BigInt(witness.feeLamports) + outputRent + temporaryRent);
  if (rentLamports > plan.rentCeilingLamports || grossDebitLamports > plan.maxSpendLamports
      || BigInt(witness.postBalances[0]) - BigInt(witness.preBalances[0]) !== nativeReceived + returnedRent - outputRent - BigInt(witness.feeLamports)) {
    throw fail('Verify the full wallet withdrawal balance, returned rent, and approved cost');
  }
  return { slot: witness.slot, feeLamports: witness.feeLamports, rentLamports, grossDebitLamports, returnedLamports,
    returnedPositionRentLamports: exactNumber(returnedRent), nativeReceivedLamports: exactNumber(nativeReceived),
    spentLamports: grossDebitLamports - returnedLamports, received };
}

export function verifySavedWithdrawal(store, operationId, plan, witness) {
  const operation = store.getOperation(operationId), launch = operation && store.getLaunch(operation.launchId);
  const record = operation && store.getTransactions(operationId).find((row) => row.signature === operation.evidence?.chain?.signature);
  if (operation?.state !== 'confirmed' || operation.kind !== 'position-withdrawal' || record?.state !== 'confirmed'
      || record.receipt?.commitment !== 'finalized' || record.receipt.error !== null || record.receipt.slot !== witness.slot
      || !equal(launch?.config?.plan, plan) || operation.payload.template !== plan.template || !equal(operation.payload.accountKeys, plan.accountKeys)) {
    throw fail('Recover the original finalized withdrawal operation');
  }
  const signed = inspectSolanaTransaction(record.wire), transaction = VersionedTransaction.deserialize(Buffer.from(record.wire, 'base64'));
  const template = VersionedTransaction.deserialize(Buffer.from(plan.template, 'base64')); template.message.recentBlockhash = record.blockhash;
  if (signed.signature !== record.signature || signed.blockhash !== record.blockhash || signed.walletPublicKey !== plan.walletPublicKey
      || !Buffer.from(template.message.serialize()).equals(Buffer.from(transaction.message.serialize()))
      || witness.message !== Buffer.from(transaction.message.serialize()).toString('base64')
      || !equal(witness.signatures, transaction.signatures.map((bytes) => bs58.encode(bytes)))) throw fail('Verify the original withdrawal signature and exact message');
  return { operationId, txId: record.signature, ...verifyWithdrawalEffects(plan, witness) };
}

export async function readWithdrawalPosition(connection, plan, { minContextSlot = 0, closed = false } = {}) {
  const keys = [plan.positionAddress, plan.nftAccount, plan.nftMint];
  const result = await connection.getMultipleAccountsInfoAndContext(keys.map(pk), { commitment: 'finalized', minContextSlot: Math.max(minContextSlot, plan.observedSlot) });
  if (!whole(result?.context?.slot) || result.context.slot < Math.max(minContextSlot, plan.observedSlot) || !Array.isArray(result.value) || result.value.length !== keys.length) throw fail('Read complete finalized position identities');
  const [position, holding, mint] = result.value;
  if (closed) {
    if (position || holding || plan.nftProgramId === TOKEN_2022_PROGRAM_ID.toBase58() && mint) throw fail('Verify the withdrawal position and NFT accounts are closed');
    if (plan.nftProgramId !== TOKEN_2022_PROGRAM_ID.toBase58()) {
      if (!mint || mint.executable || !whole(mint.lamports) || unpackMint(pk(plan.nftMint), mint, pk(plan.nftProgramId)).supply !== 0n) throw fail('Verify the position NFT supply after burning');
    }
    return result.context.slot;
  }
  const discriminator = createHash('sha256').update('account:PersonalPositionState').digest().subarray(0, 8);
  if (!position || position.executable || !position.owner.equals(pk(plan.programId)) || position.data.length !== PositionInfoLayout.span
      || !position.data.subarray(0, 8).equals(discriminator) || !holding || !mint) throw fail('Recover the saved receipt before treating a missing position as complete');
  const data = PositionInfoLayout.decode(position.data), nft = unpackAccount(pk(plan.nftAccount), holding, pk(plan.nftProgramId)), nftMint = unpackMint(pk(plan.nftMint), mint, pk(plan.nftProgramId));
  if (data.poolId.toBase58() !== plan.poolId || data.nftMint.toBase58() !== plan.nftMint || data.liquidity.toString() !== plan.liquidity
      || data.tickLower !== plan.tickLower || data.tickUpper !== plan.tickUpper || !nft.isInitialized || nft.isNative || nft.amount !== 1n || nft.owner.toBase58() !== plan.walletPublicKey
      || nft.mint.toBase58() !== plan.nftMint || nft.delegate || nft.closeAuthority && nft.closeAuthority.toBase58() !== plan.walletPublicKey
      || !nftMint.isInitialized || nftMint.supply !== 1n || nftMint.decimals !== 0 || nftMint.mintAuthority
      || nftMint.freezeAuthority && nftMint.freezeAuthority.toBase58() !== plan.poolId || nft.isFrozen && nftMint.freezeAuthority?.toBase58() !== plan.poolId) {
    throw Object.assign(new Error('Review the changed position before withdrawing'), { code: 'POSITION_CHANGED' });
  }
  return result.context.slot;
}
