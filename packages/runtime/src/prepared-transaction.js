import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { setTimeout as sleep } from 'node:timers/promises';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { ExecutionEngine } from './engine.js';
import { createSolanaChain } from './solana.js';
import { publicJson } from './store.js';

const hash = (value) => createHash('sha256').update(publicJson(value)).digest('hex');
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const uncertain = (message) => fail('CHAIN_STATE_UNAVAILABLE', message);
const placeholder = new PublicKey(new Uint8Array(32)).toBase58();
const whole = (value) => Number.isSafeInteger(value) && value >= 0;

// The host supplies a reviewed SDK builder and a result check for its known
// operation kind. Store the complete public message and result identities once.
// Expiry changes only the recent blockhash; account identities stay fixed.
export function createPreparedTransactionService({
  owner, store, connection, signer, kind, network, expectedGenesisHash,
  authorize, checkResult, receiptCreditAccount = null, receiptCreditAccounts = null, now = Date.now, timeoutMs = 60_000, pollIntervalMs = 500,
}) {
  if (!kind || typeof authorize !== 'function' || typeof checkResult !== 'function') throw new TypeError('Supply the operation kind, approval, and result checks');
  if (receiptCreditAccount !== null && typeof receiptCreditAccount !== 'string') throw new TypeError('Name the reviewed refund account');
  if (receiptCreditAccounts !== null && (receiptCreditAccount !== null || !Array.isArray(receiptCreditAccounts)
      || receiptCreditAccounts.length > 64 || receiptCreditAccounts.some((value) => typeof value !== 'string' || !value)
      || new Set(receiptCreditAccounts).size !== receiptCreditAccounts.length)) throw new TypeError('Name distinct reviewed refund accounts');
  const creditAccounts = (receiptCreditAccounts ?? (receiptCreditAccount === null ? [] : [receiptCreditAccount])).slice().sort();
  const creditPolicy = creditAccounts.length === 1 ? { receiptCreditAccount: creditAccounts[0] } : { receiptCreditAccounts: creditAccounts };
  const launchFor = ({ scopeId, walletPublicKey, key, plan, workflowId }) => {
    if (![scopeId, walletPublicKey, key].every((value) => typeof value === 'string' && value)) throw new TypeError('A prepared transaction requires launch, wallet, and action identities');
    return { id: hash({ scopeId, walletPublicKey, network, kind, key }), walletPublicKey, network,
      planDigest: hash(plan), config: { scopeId, key, genesisHash: expectedGenesisHash, plan, ...(workflowId ? { workflowId } : {}) } };
  };
  const messageFor = (payload, blockhash) => {
    const tx = VersionedTransaction.deserialize(Buffer.from(payload.template, 'base64'));
    tx.message.recentBlockhash = blockhash;
    return tx;
  };
  const validateWire = (record, operation) => {
    const actual = VersionedTransaction.deserialize(Buffer.from(record.wire, 'base64'));
    const expected = messageFor(operation.payload, record.blockhash);
    if (!Buffer.from(actual.message.serialize()).equals(Buffer.from(expected.message.serialize()))) throw fail('TRANSACTION_INVALID', 'The signed message must match the saved action');
    return actual.message;
  };
  const accountKeys = async (message) => {
    const tables = [];
    for (const lookup of message.addressTableLookups || []) {
      const response = await connection.getAddressLookupTable(lookup.accountKey, { commitment: 'finalized' });
      if (!response?.value) throw uncertain('Read every saved lookup table before execution');
      tables.push(response.value);
    }
    const keys = message.getAccountKeys({ addressLookupTableAccounts: tables });
    return Array.from({ length: keys.length }, (_, index) => keys.get(index).toBase58());
  };
  const creditAccountIndexes = (message, keys) => creditAccounts.map((account) => {
    const index = keys.indexOf(account);
    if (index <= 0 || !message.isAccountWritable(index)) throw uncertain('Use the reviewed writable refund accounts');
    return index;
  });
  const checkFee = async (message, payload) => {
    const quote = await connection.getFeeForMessage(message, 'finalized');
    if (!whole(quote?.context?.slot) || !whole(quote.value)) throw uncertain('Read the complete transaction fee');
    if (quote.value > payload.feeCeilingLamports) throw fail('SPEND_LIMIT_EXCEEDED', 'The transaction fee exceeds the saved ceiling');
    if (publicJson(await accountKeys(message)) !== publicJson(payload.accountKeys)) throw uncertain('Verify the saved lookup table addresses');
    creditAccountIndexes(message, payload.accountKeys);
  };
  const approvalFor = async (approval, operation, launch) => {
    owner.assertActive();
    if (typeof approval?.id !== 'string' || !approval.id || approval.walletPublicKey !== launch.walletPublicKey
        || approval.network !== network || approval.genesisHash !== expectedGenesisHash || approval.scopeId !== launch.config.scopeId
        || approval.planDigest !== launch.planDigest || !whole(approval.expiresAtMs) || approval.expiresAtMs <= now()
        || !whole(approval.maxSpendLamports) || approval.maxSpendLamports < operation.payload.maxSpendLamports
        || await authorize({ approval, operation, launch }) !== true) throw fail('EXECUTION_APPROVAL_REQUIRED', 'Approve the saved launch, wallet, network, expiry, and spending ceiling');
    owner.assertActive();
  };
  const receiptFor = async (record, operation, minContextSlot) => {
    const message = validateWire(record, operation);
    const signatures = VersionedTransaction.deserialize(Buffer.from(record.wire, 'base64')).signatures.map((value) => bs58.encode(value));
    const receipt = await connection.getTransaction(record.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    if (!receipt || !whole(receipt.slot) || receipt.slot < minContextSlot || receipt.meta?.err !== null
        || publicJson(receipt.transaction?.signatures || []) !== publicJson(signatures) || typeof receipt.transaction?.message?.serialize !== 'function'
        || !Buffer.from(receipt.transaction.message.serialize()).equals(Buffer.from(message.serialize()))) throw uncertain('Verify the finalized transaction and its exact message');
    const loaded = receipt.meta.loadedAddresses;
    const keys = [...message.staticAccountKeys, ...(loaded?.writable || []), ...(loaded?.readonly || [])].map((key) => key.toBase58());
    if (publicJson(keys) !== publicJson(operation.payload.accountKeys)) throw uncertain('Verify every account in the finalized receipt');
    const { preBalances, postBalances, fee } = receipt.meta;
    if (!Array.isArray(preBalances) || !Array.isArray(postBalances) || preBalances.length !== keys.length || postBalances.length !== keys.length
        || [...preBalances, ...postBalances, fee].some((value) => !whole(value)) || fee > operation.payload.feeCeilingLamports) throw uncertain('Read complete finalized balances and fees');
    const creditIndexes = creditAccountIndexes(message, keys);
    const creditLimit = creditIndexes.length ? creditIndexes.reduce((sum, index) => sum + preBalances[index], 0) : operation.payload.maxCreditLamports || 0;
    if (!whole(creditLimit)) throw uncertain('Read the exact combined refund balance');
    const spentLamports = preBalances[0] - postBalances[0];
    if (spentLamports < fee - creditLimit || spentLamports > operation.payload.maxSpendLamports) throw uncertain('Verify the finalized payer debit against the saved ceiling');
    return { evidence: { signature: record.signature, slot: receipt.slot, feeLamports: fee, spentLamports }, receipt };
  };
  const handler = {
    async checkState({ operation, launch, transactions, minContextSlot }) {
      const confirmed = transactions.find((record) => record.state === 'confirmed');
      const verified = confirmed ? await receiptFor(confirmed, operation, minContextSlot) : null;
      const receipt = verified?.evidence || null;
      const observed = await checkResult({ operation, launch, minContextSlot: Math.max(minContextSlot, receipt?.slot || 0), confirmed: !!confirmed, receipt: verified?.receipt || null });
      if (!whole(observed?.slot) || observed.slot < Math.max(minContextSlot, receipt?.slot || 0) || !['present', 'absent'].includes(observed.state)) throw uncertain('Read a complete finalized operation result');
      if (observed.state === 'present') {
        if (!confirmed && !operation.payload.allowExisting) throw uncertain('Recover the saved transaction receipt for this account identity');
        return { state: 'complete', evidence: { ...operation.payload.result, ...observed.evidence, ...receipt,
          signature: receipt?.signature || null, slot: observed.slot, adopted: !confirmed, feeLamports: receipt?.feeLamports || 0, spentLamports: receipt?.spentLamports || 0 } };
      }
      if (confirmed) throw uncertain('Verify the saved account identities at the finalized transaction slot');
      return { state: 'ready', evidence: { slot: observed.slot } };
    },
    async buildTransaction({ operation }) {
      const expiry = await connection.getLatestBlockhash('finalized');
      const transaction = messageFor(operation.payload, expiry.blockhash);
      await checkFee(transaction.message, operation.payload);
      return { ...expiry, transaction };
    },
  };
  const run = async (operation, approval) => {
    const savedCredits = operation.payload.receiptCreditAccounts ?? (Object.hasOwn(operation.payload, 'receiptCreditAccount') ? [operation.payload.receiptCreditAccount] : null);
    if (savedCredits !== null && publicJson(savedCredits) !== publicJson(creditAccounts)) {
      throw fail('OPERATION_CONFLICT', 'Recover the action with its saved refund account');
    }
    const launch = store.getLaunch(operation.launchId);
    if (launch.network !== network || launch.config.genesisHash !== expectedGenesisHash) {
      throw fail('NETWORK_MISMATCH', 'Recover this operation on its saved network and genesis hash', { operationId: operation.id });
    }
    const chain = createSolanaChain({ connection, network, expectedGenesisHash,
      beforeSend: async (_transaction, context) => approvalFor(approval, context.operation, context.launch) });
    const engine = new ExecutionEngine({ owner, store, chain, signer, operations: { [kind]: handler }, authorize: async (context) => {
      await approvalFor(approval, context.operation, context.launch);
      store.recordOperationApproval(context.operation.id, { ...approval, requestId: approval.id, id: hash({ operationId: context.operation.id, requestId: approval.id }) });
      if (context.transaction) await checkFee(validateWire(context.transaction, context.operation), context.operation.payload);
      await approvalFor(approval, context.operation, context.launch);
      return true;
    } });
    const deadline = now() + timeoutMs;
    while (true) {
      let status;
      try {
        // A saved finalized status can skip the chain adapter's status read.
        // Check the RPC before reading the full receipt and account results.
        if (!['confirmed', 'failed'].includes(store.getOperation(operation.id).state)
            && await connection.getGenesisHash() !== expectedGenesisHash) throw fail('NETWORK_MISMATCH', 'Read recovery evidence from the saved chain');
        status = await engine.resume(operation.id);
      } catch (cause) { cause.operationId = operation.id; throw cause; }
      if (status.operation.state === 'confirmed') return { ...status.operation.evidence.chain, operationId: operation.id, txId: status.operation.evidence.chain.signature };
      if (status.operation.state === 'failed') throw fail('TRANSACTION_FAILED', 'Review the failed transaction before continuing the launch', { operationId: operation.id });
      if (now() >= deadline) throw uncertain('Resume the operation when its finalized result is available');
      await sleep(pollIntervalMs);
    }
  };
  return {
    async execute({ scopeId, walletPublicKey, key, plan, approval, build, workflowId }) {
      owner.assertActive();
      const launch = launchFor({ scopeId, walletPublicKey, key, plan, workflowId });
      const existingLaunch = store.getLaunch(launch.id);
      if (existingLaunch && publicJson(existingLaunch.config) !== publicJson(launch.config)) throw fail('OPERATION_CONFLICT', 'Use the saved launch plan when recovering this action');
      const active = store.getActiveOperation(walletPublicKey);
      if (active && active.launchId !== launch.id) throw fail('OPERATION_IN_FLIGHT', 'Recover the saved wallet operation first', { operationId: active.id });
      const existing = store.listOperations(launch.id)[0];
      if (existing) return run(existing, approval);
      if (await connection.getGenesisHash() !== expectedGenesisHash) throw fail('NETWORK_MISMATCH', 'The RPC must match the approved network');
      const prepared = await build();
      owner.assertActive();
      const unsigned = new VersionedTransaction(prepared.transaction.message);
      unsigned.message.recentBlockhash = placeholder;
      const template = Buffer.from(unsigned.serialize()).toString('base64');
      if (Buffer.from(template, 'base64').length > 1232 || unsigned.message.staticAccountKeys[0]?.toBase58() !== walletPublicKey) throw fail('TRANSACTION_INVALID', 'Use a complete transaction for the approved wallet');
      if (!whole(prepared.feeCeilingLamports) || !whole(prepared.maxSpendLamports) || prepared.maxSpendLamports < prepared.feeCeilingLamports) throw new TypeError('Save complete fee and spending ceilings');
      const resolvedKeys = await accountKeys(unsigned.message);
      creditAccountIndexes(unsigned.message, resolvedKeys);
      if (prepared.accountKeys && publicJson(prepared.accountKeys) !== publicJson(resolvedKeys)) throw uncertain('Keep the account addresses from the reviewed transaction');
      if (prepared.maxCreditLamports !== undefined && !whole(prepared.maxCreditLamports)) throw new TypeError('Save an exact bound for returned wallet funds');
      const payload = { key, template, accountKeys: resolvedKeys, result: prepared.result,
        ...creditPolicy,
        allowExisting: prepared.allowExisting === true, feeCeilingLamports: prepared.feeCeilingLamports, maxSpendLamports: prepared.maxSpendLamports,
        ...(prepared.maxCreditLamports === undefined ? {} : { maxCreditLamports: prepared.maxCreditLamports }) };
      const candidate = { kind, payload };
      await approvalFor(approval, candidate, launch);
      const operation = store.transaction(() => {
        store.saveLaunch(launch);
        const saved = store.prepareOperation({ launchId: launch.id, kind, payload });
        store.recordOperationApproval(saved.id, { ...approval, requestId: approval.id, id: hash({ operationId: saved.id, requestId: approval.id }) });
        return saved;
      });
      return run(operation, approval);
    },
    async recover({ walletPublicKey, approval }) {
      owner.assertActive();
      const operation = store.getActiveOperation(walletPublicKey);
      if (!operation) return null;
      if (operation.kind !== kind) throw fail('OPERATION_IN_FLIGHT', 'Use the adapter for the saved wallet operation', { operationId: operation.id });
      return run(operation, approval);
    },
  };
}
