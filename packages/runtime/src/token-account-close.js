import { createHash } from 'node:crypto';
import { ComputeBudgetProgram, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createCloseAccountInstruction, unpackAccount,
  getExtensionTypes, getTransferFeeAmount, ExtensionType,
} from '@solana/spl-token';
import { ExecutionEngine } from './engine.js';
import { createSolanaChain } from './solana.js';
import { publicJson } from './store.js';

const kind = 'token-account-close';
const failure = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const uncertain = (message) => failure('CHAIN_STATE_UNAVAILABLE', message);
const digest = (value) => createHash('sha256').update(publicJson(value)).digest('hex');
const integer = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw failure('INVALID_INPUT', `${label} requires a nonnegative whole number`);
  return value;
};
const PROGRAMS = [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()];
// Extensions an empty account may carry and still close with one instruction.
const CLOSABLE_EXTENSIONS = new Set([ExtensionType.ImmutableOwner, ExtensionType.TransferFeeAmount]);
export const TOKEN_ACCOUNT_CLOSE_BATCH = 8;

// Whether a token account can be closed by its owner with one instruction: owned by the wallet,
// empty, no other close authority, and no withheld Token-2022 fees.
export function closableTokenAccount(address, info, walletPublicKey) {
  const programId = info?.owner?.toBase58?.();
  if (!PROGRAMS.includes(programId)) return null;
  let account;
  try { account = unpackAccount(new PublicKey(address), info, new PublicKey(programId)); } catch { return null; }
  if (account.owner.toBase58() !== walletPublicKey || account.amount !== 0n || !account.isInitialized) return null;
  if (account.closeAuthority && account.closeAuthority.toBase58() !== walletPublicKey) return null;
  if (programId === PROGRAMS[1]) {
    const extensions = getExtensionTypes(account.tlvData);
    if (extensions.some((type) => !CLOSABLE_EXTENSIONS.has(type))) return null;
    if ((getTransferFeeAmount(account)?.withheldAmount || 0n) !== 0n) return null;
  }
  return { address: new PublicKey(address).toBase58(), programId, lamports: info.lamports };
}

// Closes empty token accounts of a launch wallet and returns their rent to that wallet. Each
// batch is one operation: its accounts and their rent are saved before signing, and the
// finalized receipt must show every account emptied into the wallet before it counts as done.
export function createTokenAccountCloseService({
  owner, store, connection, signer, network, expectedGenesisHash, authorize, feePolicy,
  now = Date.now, timeoutMs = 60_000, pollIntervalMs = 1000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (typeof authorize !== 'function' || typeof feePolicy !== 'function') throw new TypeError('Closing token accounts requires approval and fee policy interfaces');
  const checkNetwork = async () => {
    owner.assertActive();
    if (await connection.getGenesisHash() !== expectedGenesisHash) throw failure('NETWORK_MISMATCH', 'Use the approved Solana network');
    owner.assertActive();
  };
  const transactionFor = (payload, walletPublicKey, blockhash) => {
    const wallet = new PublicKey(walletPublicKey);
    return new Transaction({ feePayer: wallet, recentBlockhash: blockhash }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: payload.computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: payload.microLamports }),
      ...payload.accounts.map((account) => createCloseAccountInstruction(new PublicKey(account.address), wallet, wallet, [], new PublicKey(account.programId))),
    );
  };
  const validateWire = (transaction, operation, launch) => {
    const signed = VersionedTransaction.deserialize(Buffer.from(transaction.wire, 'base64'));
    const expected = transactionFor(operation.payload, launch.walletPublicKey, transaction.blockhash).compileMessage();
    if (!Buffer.from(signed.message.serialize()).equals(Buffer.from(expected.serialize()))) throw failure('TRANSACTION_INVALID', 'The signed close must match the saved accounts and fee');
    return signed.message;
  };
  const fee = async (message, payload) => {
    const quoted = await connection.getFeeForMessage(message, 'finalized');
    if (!Number.isSafeInteger(quoted?.context?.slot) || quoted.context.slot < 0 || !Number.isSafeInteger(quoted.value) || quoted.value < 0) throw uncertain('Read the close fee before signing or sending');
    if (quoted.value > payload.feeCeilingLamports) throw failure('SPEND_LIMIT_EXCEEDED', 'The close fee exceeds its saved limit');
    return quoted.value;
  };
  const read = async (payload, walletPublicKey, minContextSlot = 0) => {
    await checkNetwork();
    const keys = [walletPublicKey, ...payload.accounts.map((account) => account.address)].map((value) => new PublicKey(value));
    const response = await connection.getMultipleAccountsInfoAndContext(keys, { commitment: 'finalized', minContextSlot });
    if (!Number.isSafeInteger(response?.context?.slot) || response.context.slot < minContextSlot || !Array.isArray(response.value) || response.value.length !== keys.length) {
      throw uncertain('Read complete finalized token accounts');
    }
    return { slot: response.context.slot, wallet: response.value[0], accounts: response.value.slice(1) };
  };
  const operationHandler = {
    async checkState({ operation, launch, transactions, minContextSlot }) {
      const { payload } = operation;
      const completed = transactions.find((tx) => tx.state === 'confirmed');
      if (completed) {
        await checkNetwork();
        const wire = VersionedTransaction.deserialize(Buffer.from(completed.wire, 'base64'));
        const receipt = await connection.getTransaction(completed.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
        if (!receipt || !Number.isSafeInteger(receipt.slot) || receipt.slot < minContextSlot || receipt.meta?.err !== null
            || receipt.transaction?.signatures?.[0] !== completed.signature || typeof receipt.transaction?.message?.serialize !== 'function'
            || !Buffer.from(receipt.transaction.message.serialize()).equals(Buffer.from(wire.message.serialize()))) {
          throw uncertain('Verify the finalized close and its transaction bytes');
        }
        validateWire(completed, operation, launch);
        const keys = wire.message.staticAccountKeys.map((key) => key.toBase58());
        const pre = receipt.meta.preBalances, post = receipt.meta.postBalances, paid = receipt.meta.fee;
        const reclaimed = payload.accounts.reduce((sum, account) => sum + account.lamports, 0);
        if (keys[0] !== launch.walletPublicKey || !Array.isArray(pre) || !Array.isArray(post) || pre.length !== keys.length || post.length !== keys.length
            || [...pre, ...post, paid].some((value) => !Number.isSafeInteger(value) || value < 0) || paid > payload.feeCeilingLamports
            || payload.accounts.some((account) => { const index = keys.indexOf(account.address); return index < 1 || pre[index] !== account.lamports || post[index] !== 0; })
            || post[0] - pre[0] !== reclaimed - paid) {
          throw uncertain('Verify every closed account and the rent returned in the finalized receipt');
        }
        return { state: 'complete', evidence: { signature: completed.signature, slot: receipt.slot, accounts: payload.accounts.map((account) => account.address), reclaimedLamports: reclaimed, feeLamports: paid } };
      }
      const current = await read(payload, launch.walletPublicKey, minContextSlot);
      payload.accounts.forEach((account, index) => {
        const now = current.accounts[index] ? closableTokenAccount(account.address, current.accounts[index], launch.walletPublicKey) : null;
        if (!now || now.programId !== account.programId || now.lamports !== account.lamports) throw uncertain('Each saved account must still be empty, owned by the wallet, and hold its saved rent');
      });
      if (!current.wallet || !Number.isSafeInteger(current.wallet.lamports) || current.wallet.lamports < payload.feeCeilingLamports) throw failure('INSUFFICIENT_FUNDS', 'The launch wallet needs SOL for the close fee');
      return { state: 'ready', evidence: { slot: current.slot } };
    },
    async buildTransaction({ operation, launch }) {
      await checkNetwork();
      const expiry = await connection.getLatestBlockhash('finalized');
      const transaction = transactionFor(operation.payload, launch.walletPublicKey, expiry.blockhash);
      await fee(transaction.compileMessage(), operation.payload);
      return { ...expiry, transaction };
    },
  };
  const validateApproval = async (approval, operation, launch) => {
    owner.assertActive();
    const addresses = operation.payload.accounts.map((account) => account.address);
    if (!approval || typeof approval.id !== 'string' || !approval.id || approval.walletPublicKey !== launch.walletPublicKey
        || approval.network !== network || approval.genesisHash !== expectedGenesisHash || !Number.isSafeInteger(approval.expiresAtMs)
        || approval.expiresAtMs <= now() || !Number.isSafeInteger(approval.maxSpendLamports) || approval.maxSpendLamports < operation.payload.feeCeilingLamports
        || publicJson(approval.close?.accounts || []) !== publicJson(addresses)
        || await authorize({ approval, operation, launch }) !== true) {
      throw failure('EXECUTION_APPROVAL_REQUIRED', 'Approve closing exactly these token accounts on this network');
    }
    owner.assertActive();
  };
  const result = (operation) => ({ closed: operation.payload.accounts.map((account) => account.address), reclaimedLamports: operation.evidence?.chain?.reclaimedLamports ?? 0,
    txId: operation.evidence?.chain?.signature, operationId: operation.id });
  const run = async (operation, approval) => {
    const chain = createSolanaChain({ connection, network, expectedGenesisHash, beforeSend: async (_transaction, context) => validateApproval(approval, context.operation, context.launch) });
    const engine = new ExecutionEngine({ owner, store, signer, chain, operations: { [kind]: operationHandler }, authorize: async (context) => {
      await validateApproval(approval, context.operation, context.launch);
      store.recordOperationApproval(context.operation.id, { ...approval, requestId: approval.id, id: digest({ requestId: approval.id, operationId: context.operation.id }) });
      await checkNetwork();
      if (context.transaction) await fee(validateWire(context.transaction, context.operation, context.launch), context.operation.payload);
      await validateApproval(approval, context.operation, context.launch);
      return true;
    } });
    const deadline = now() + timeoutMs;
    while (true) {
      let status;
      try { status = await engine.resume(operation.id); } catch (cause) { cause.operationId = operation.id; throw cause; }
      if (status.operation.state === 'confirmed') return result(status.operation);
      if (status.operation.state === 'failed') throw failure('TRANSACTION_FAILED', 'The token account close failed on chain', { operationId: operation.id });
      if (now() >= deadline) throw Object.assign(uncertain('The saved close is waiting for a finalized receipt'), { operationId: operation.id });
      await sleep(pollIntervalMs);
    }
  };
  const activeFor = (walletPublicKey) => {
    owner.assertActive();
    const active = store.getActiveOperation(walletPublicKey);
    if (active && (active.kind !== kind || store.getLaunch(active.launchId)?.network !== network)) throw failure('OPERATION_IN_FLIGHT', 'Recover the saved wallet operation first', { operationId: active.id });
    return active;
  };
  return {
    async recover({ walletPublicKey, approval }) {
      const operation = activeFor(new PublicKey(walletPublicKey).toBase58());
      return operation ? run(operation, approval) : null;
    },
    async close({ scopeId, walletPublicKey, accounts, approval }) {
      const wallet = new PublicKey(walletPublicKey).toBase58();
      if (!scopeId || !Array.isArray(accounts) || !accounts.length || accounts.length > TOKEN_ACCOUNT_CLOSE_BATCH) throw failure('INVALID_INPUT', `Close between 1 and ${TOKEN_ACCOUNT_CLOSE_BATCH} accounts of a saved launch`);
      const pending = activeFor(wallet);
      if (pending) return run(pending, approval);
      const addresses = [...new Set(accounts.map((value) => new PublicKey(value).toBase58()))].sort();
      if (addresses.length !== accounts.length) throw failure('INVALID_INPUT', 'Name each token account once');
      const config = { scopeId, purpose: kind, walletPublicKey: wallet, network, genesisHash: expectedGenesisHash, accounts: addresses };
      const planDigest = digest(config), launch = { id: `${kind}-${planDigest}`, walletPublicKey: wallet, network, planDigest, config };
      const saved = store.listOperations(launch.id).find((operation) => operation.state === 'confirmed');
      if (saved) return result(saved);
      const current = await read({ accounts: addresses.map((address) => ({ address })) }, wallet);
      const rows = addresses.map((address, index) => {
        const row = current.accounts[index] ? closableTokenAccount(address, current.accounts[index], wallet) : null;
        if (!row) throw failure('INVALID_INPUT', 'Close only empty token accounts the launch wallet owns');
        return row;
      });
      const policy = await feePolicy({ connection, walletPublicKey: wallet, accountCount: rows.length });
      const computeUnitLimit = integer(policy.computeUnitLimit, 'Compute limit'), microLamports = integer(policy.microLamports, 'Priority fee'), feeCeilingLamports = integer(policy.feeCeilingLamports, 'Fee limit');
      if (!computeUnitLimit || computeUnitLimit > 1_400_000) throw failure('INVALID_INPUT', 'Use a bounded close compute limit');
      const payload = { accounts: rows, feeCeilingLamports, microLamports, computeUnitLimit };
      await validateApproval(approval, { payload }, launch);
      const operation = store.transaction(() => {
        store.saveLaunch(launch);
        const prepared = store.prepareOperation({ launchId: launch.id, kind, index: store.listOperations(launch.id).length, payload });
        store.recordOperationApproval(prepared.id, { ...approval, requestId: approval.id, id: digest({ requestId: approval.id, operationId: prepared.id }) });
        return prepared;
      });
      return run(operation, approval);
    },
  };
}
