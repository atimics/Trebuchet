import bs58 from 'bs58';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { inspectSolanaTransaction } from './solana.js';
import { publicJson } from './store.js';
import { buildSupportPositionPlan, readSupportAccounts, supportRaw, supportWhole as whole, supportError as fail } from './support-position-plan.js';

const equal = (a, b) => publicJson(a) === publicJson(b);
const exact = (value) => { const n = Number(value); if (!whole(n) || BigInt(n) !== BigInt(value)) throw fail('Keep support costs exact'); return n; };
export function supportReceiptWitness(receipt) {
  const { meta, transaction } = receipt, loaded = meta.loadedAddresses;
  return { slot: receipt.slot, message: Buffer.from(transaction.message.serialize()).toString('base64'), signatures: transaction.signatures,
    accountKeys: [...transaction.message.staticAccountKeys, ...(loaded?.writable || []), ...(loaded?.readonly || [])].map((key) => key.toBase58()),
    error: meta.err, feeLamports: meta.fee, preBalances: meta.preBalances, postBalances: meta.postBalances,
    preTokenBalances: meta.preTokenBalances, postTokenBalances: meta.postTokenBalances };
}

// The fixed successful CLMM instruction, new position accounts, exact deposit,
// and minted NFT prove this original creation. Later position changes retain
// the original result and its cost.
export function verifySupportEffects(plan, witness) {
  const keys = plan.accountKeys, template = VersionedTransaction.deserialize(Buffer.from(plan.template, 'base64'));
  if (!witness || !whole(witness.slot) || witness.slot < plan.observedSlot || witness.error !== null || !equal(witness.accountKeys, keys)
      || !whole(witness.feeLamports) || witness.feeLamports > plan.feeCeilingLamports
      || !Array.isArray(witness.preBalances) || !Array.isArray(witness.postBalances) || witness.preBalances.length !== keys.length || witness.postBalances.length !== keys.length
      || [...witness.preBalances, ...witness.postBalances].some((value) => !whole(value))) throw fail('Read complete support receipt balances and fees');
  const index = (address) => { const i = keys.indexOf(address); if (i <= 0 || !template.message.isAccountWritable(i)) throw fail('Verify each writable support account'); return i; };
  const rows = (values) => {
    if (!Array.isArray(values) || new Set(values.map((row) => row.accountIndex)).size !== values.length) throw fail('Read distinct support token balances');
    const result = new Map();
    for (const row of values) {
      if (!whole(row.accountIndex) || row.accountIndex >= keys.length || !row.mint || !row.owner || !row.programId || !whole(row.uiTokenAmount?.decimals) || row.uiTokenAmount.decimals > 255) throw fail('Read complete support token identities');
      result.set(row.accountIndex, { ...row, amount: supportRaw(row.uiTokenAmount.amount) });
    }
    return result;
  };
  const before = rows(witness.preTokenBalances), after = rows(witness.postTokenBalances);
  const amount = (values, address, expected, optional = false) => {
    const row = values.get(index(address)); if (!row && optional) return 0n;
    if (!row || row.mint !== expected.mint || row.owner !== expected.owner || row.programId !== expected.programId || row.uiTokenAmount.decimals !== expected.decimals) throw fail('Verify the saved support token identities');
    return row.amount;
  };
  const nft = { mint: plan.nftMint, owner: plan.walletPublicKey, programId: plan.nftProgramId, decimals: 0 };
  if (before.has(index(plan.nftAccount)) || amount(after, plan.nftAccount, nft) !== 1n) throw fail('Verify the new position NFT belongs to the approved wallet');
  for (const address of [plan.nftMint, plan.nftAccount, plan.positionAddress]) {
    const i = index(address); if (witness.preBalances[i] !== 0 || witness.postBalances[i] <= 0) throw fail('Verify every new support position account');
  }
  const temp = index(plan.temporaryAccount);
  if (witness.preBalances[temp] !== 0 || witness.postBalances[temp] !== 0 || before.has(temp) || after.has(temp)) throw fail('Verify the temporary support SOL account was created and closed');
  const native = { mint: NATIVE_MINT.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), owner: plan.poolId, decimals: 9 };
  const deposited = amount(after, plan.nativeVault, native) - amount(before, plan.nativeVault, native), v = index(plan.nativeVault);
  if (deposited !== supportRaw(plan.depositedRaw) || deposited <= 0n || deposited > supportRaw(plan.depositLamports)
      || BigInt(witness.postBalances[v]) - BigInt(witness.preBalances[v]) !== deposited) throw fail('Verify the exact approved SOL deposit into the pool');
  const token = { mint: plan.tokenMint, programId: plan.tokenProgramId, decimals: plan.tokenDecimals };
  const output = plan.rents.find((row) => row.address === plan.tokenAccount);
  if (amount(after, plan.tokenAccount, { ...token, owner: plan.walletPublicKey }) !== amount(before, plan.tokenAccount, { ...token, owner: plan.walletPublicKey }, output.created)
      || amount(after, plan.tokenVault, { ...token, owner: plan.poolId }) !== amount(before, plan.tokenVault, { ...token, owner: plan.poolId })) throw fail('Verify the support transaction preserves the other token');
  let paidRent = 0n;
  const changed = new Set([0, v, temp]);
  for (const row of plan.rents) {
    const i = index(row.address), delta = BigInt(witness.postBalances[i]) - BigInt(witness.preBalances[i]);
    if (delta < 0n || delta > BigInt(row.rentCeilingLamports) || row.type !== 'protocol-position' && witness.postBalances[i] <= 0) throw fail('Verify each approved support account rent');
    paidRent += delta; changed.add(i);
  }
  for (let i = 1; i < keys.length; i++) if (!changed.has(i) && witness.preBalances[i] !== witness.postBalances[i]) throw fail('Verify the full support account balance changes');
  const rentLamports = exact(paidRent + BigInt(plan.temporaryRentLamports));
  const grossDebitLamports = exact(BigInt(plan.depositLamports) + BigInt(witness.feeLamports) + BigInt(rentLamports));
  const returnedLamports = exact(BigInt(plan.temporaryRentLamports) + BigInt(plan.depositLamports) - deposited);
  const spentLamports = grossDebitLamports - returnedLamports;
  if (rentLamports > plan.rentCeilingLamports || grossDebitLamports > plan.maxSpendLamports || witness.preBalances[0] - witness.postBalances[0] !== spentLamports) throw fail('Verify the full wallet support deposit, fee, rent, and returned SOL');
  return { slot: witness.slot, liquidity: plan.liquidity, depositedRaw: deposited.toString(), feeLamports: witness.feeLamports,
    rentLamports, grossDebitLamports, returnedLamports, spentLamports };
}

export function verifySavedSupport(store, operationId, plan, witness) {
  const operation = store.getOperation(operationId), launch = operation && store.getLaunch(operation.launchId);
  const record = operation && store.getTransactions(operationId).find((row) => row.signature === operation.evidence?.chain?.signature);
  if (operation?.state !== 'confirmed' || operation.kind !== 'support-position' || record?.state !== 'confirmed'
      || record.receipt?.commitment !== 'finalized' || record.receipt.error !== null || record.receipt.slot !== witness.slot
      || !equal(launch?.config?.plan, plan) || operation.payload.template !== plan.template || !equal(operation.payload.accountKeys, plan.accountKeys)) throw fail('Recover the original finalized support operation');
  const signed = inspectSolanaTransaction(record.wire), transaction = VersionedTransaction.deserialize(Buffer.from(record.wire, 'base64'));
  const template = VersionedTransaction.deserialize(Buffer.from(plan.template, 'base64')); template.message.recentBlockhash = record.blockhash;
  if (signed.signature !== record.signature || signed.blockhash !== record.blockhash || signed.walletPublicKey !== plan.walletPublicKey
      || !Buffer.from(template.message.serialize()).equals(Buffer.from(transaction.message.serialize())) || witness.message !== Buffer.from(transaction.message.serialize()).toString('base64')
      || !equal(witness.signatures, transaction.signatures.map((value) => bs58.encode(value)))) throw fail('Verify the original support signature and exact message');
  return { operationId, txId: record.signature, ...verifySupportEffects(plan, witness) };
}

export async function readSupportState(connection, plan, { minContextSlot = 0 } = {}) {
  const min = Math.max(minContextSlot, plan.observedSlot);
  const identities = await readSupportAccounts(connection, [plan.nftMint, plan.nftAccount, plan.positionAddress], min);
  // Presence holds recovery until the original transaction receipt is found.
  if (identities.value.some(Boolean)) return { state: 'present', slot: identities.context.slot };
  const { plan: fresh } = await buildSupportPositionPlan({ ...plan.request, connection, expectedGenesisHash: plan.genesisHash, minContextSlot: identities.context.slot });
  const fixed = ['network', 'genesisHash', 'walletPublicKey', 'poolId', 'nftMint', 'nftProgramId', 'nftAccount', 'positionAddress', 'programId', 'tokenMint', 'tokenProgramId',
    'tokenDecimals', 'tokenAccount', 'nativeVault', 'tokenVault', 'nativeIsA', 'tickLower', 'tickUpper', 'tickSpacing', 'poolSeedIndex', 'ammConfig', 'liquidity', 'depositLamports', 'depositedRaw', 'temporaryAccount', 'temporaryRentLamports'];
  if (fixed.some((field) => !equal(fresh[field], plan[field])) || fresh.rentCeilingLamports > plan.rentCeilingLamports
      || fresh.rents.some((row) => { const saved = plan.rents.find((item) => item.address === row.address); return !saved || row.rentCeilingLamports > saved.rentCeilingLamports; })) throw fail('Review the changed support accounts and cost', 'SUPPORT_PLAN_CHANGED');
  return { state: 'absent', slot: fresh.observedSlot };
}
