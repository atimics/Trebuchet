import { createHash } from 'node:crypto';
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js';
import { ExecutionEngine } from './engine.js';
import { createSolanaChain } from './solana.js';
import { publicJson } from './store.js';

const kind = 'sol-sweep';
const error = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const uncertain = (message) => error('CHAIN_STATE_UNAVAILABLE', message);
const integer = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) throw error('INVALID_INPUT', `${name} requires a whole number of lamports`);
  return value;
};
const digest = (value) => createHash('sha256').update(publicJson(value)).digest('hex');
const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// This operation sends one approved native SOL transfer. Hosts provide custody,
// approval verification, fee policy, and the active profile owner.
export function createSolSweepService({
  owner, store, connection, signer, network, expectedGenesisHash, authorize, feePolicy,
  now = Date.now, sleep = sleepDefault, pollIntervalMs = 1000, timeoutMs = 60_000,
}) {
  if (typeof authorize !== 'function' || typeof feePolicy !== 'function') throw new TypeError('SOL sweep requires approval and fee policy interfaces');
  const checkNetwork = async () => {
    owner.assertActive();
    if (await connection.getGenesisHash() !== expectedGenesisHash) throw error('NETWORK_MISMATCH', 'The RPC must match the approved Solana network');
    owner.assertActive();
  };
  const balance = async (wallet, minContextSlot = 0) => {
    const value = await connection.getBalanceAndContext(new PublicKey(wallet), { commitment: 'finalized', minContextSlot });
    if (!Number.isSafeInteger(value?.context?.slot) || value.context.slot < minContextSlot || !Number.isSafeInteger(value.value) || value.value < 0) throw uncertain('Read a complete finalized wallet balance before continuing');
    return { lamports: value.value, slot: value.context.slot };
  };
  const transactionFor = (payload, walletPublicKey, blockhash) => new Transaction({
    feePayer: new PublicKey(walletPublicKey), recentBlockhash: blockhash,
  }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: payload.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: payload.microLamports }),
    SystemProgram.transfer({ fromPubkey: new PublicKey(walletPublicKey), toPubkey: new PublicKey(payload.destinationWallet), lamports: payload.amountLamports }),
  );
  const validateWire = (transaction, operation, launch) => {
    const signed = VersionedTransaction.deserialize(Buffer.from(transaction.wire, 'base64'));
    const expected = transactionFor(operation.payload, launch.walletPublicKey, transaction.blockhash).compileMessage();
    if (!Buffer.from(signed.message.serialize()).equals(Buffer.from(expected.serialize()))) throw error('TRANSACTION_INVALID', 'The signed transfer must match the approved amount, fee, and destination');
    return signed.message;
  };
  const fee = async (message, payload) => {
    const quoted = await connection.getFeeForMessage(message, 'finalized');
    if (!Number.isSafeInteger(quoted?.context?.slot) || quoted.context.slot < 0 || !Number.isSafeInteger(quoted.value) || quoted.value < 0) throw uncertain('Read the transfer fee before signing or sending');
    if (quoted.value > payload.feeCeilingLamports) throw error('SPEND_LIMIT_EXCEEDED', 'The transfer fee exceeds its saved limit');
    return quoted.value;
  };
  const operationHandler = {
    async checkState({ operation, launch, transactions, minContextSlot }) {
      await checkNetwork();
      const completed = transactions.find((tx) => tx.state === 'confirmed');
      if (completed) {
        const wire = VersionedTransaction.deserialize(Buffer.from(completed.wire, 'base64'));
        const receipt = await connection.getTransaction(completed.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
        if (!receipt || !Number.isSafeInteger(receipt.slot) || receipt.slot < minContextSlot || receipt.meta?.err !== null
            || receipt.transaction?.signatures?.[0] !== completed.signature
            || typeof receipt.transaction?.message?.serialize !== 'function'
            || !Buffer.from(receipt.transaction.message.serialize()).equals(Buffer.from(wire.message.serialize()))) {
          throw uncertain('Verify the finalized transfer and its transaction bytes');
        }
        validateWire(completed, operation, launch);
        const keys = wire.message.staticAccountKeys;
        const destinationIndex = keys.findIndex((key) => key.toBase58() === operation.payload.destinationWallet);
        const pre = receipt.meta.preBalances, post = receipt.meta.postBalances;
        if (destinationIndex < 1 || !Array.isArray(pre) || !Array.isArray(post) || pre.length !== keys.length || post.length !== keys.length
            || [...pre, ...post, receipt.meta.fee].some((value) => !Number.isSafeInteger(value) || value < 0)
            || post[destinationIndex] - pre[destinationIndex] !== operation.payload.amountLamports
            || pre[0] - post[0] !== operation.payload.amountLamports + receipt.meta.fee
            || receipt.meta.fee > operation.payload.feeCeilingLamports) {
          throw uncertain('Verify the transfer amount and fee in the finalized receipt');
        }
        return { state: 'complete', evidence: { signature: completed.signature, slot: receipt.slot, destinationWallet: operation.payload.destinationWallet, amountLamports: operation.payload.amountLamports, feeLamports: receipt.meta.fee } };
      }
      const current = await balance(launch.walletPublicKey, minContextSlot);
      const needed = operation.payload.amountLamports + operation.payload.feeCeilingLamports + operation.payload.reserveLamports;
      if (current.lamports < needed) throw error('CHAIN_STATE_UNAVAILABLE', 'The saved transfer needs its approved balance before it can continue');
      return { state: 'ready', evidence: current };
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
    if (!approval || typeof approval.id !== 'string' || !approval.id || approval.walletPublicKey !== launch.walletPublicKey
        || approval.network !== network || approval.genesisHash !== expectedGenesisHash
        || approval.destinationWallet !== operation.payload.destinationWallet || !Number.isSafeInteger(approval.expiresAtMs)
        || approval.expiresAtMs <= now() || !Number.isSafeInteger(approval.maxSpendLamports)
        || approval.maxSpendLamports < operation.payload.amountLamports + operation.payload.feeCeilingLamports
        || await authorize({ approval, operation, launch }) !== true) {
      throw error('EXECUTION_APPROVAL_REQUIRED', 'Approve this wallet, destination, network, and spending limit before sending');
    }
    owner.assertActive();
  };
  const run = async (operation, approval) => {
    const chain = createSolanaChain({ connection, network, expectedGenesisHash,
      beforeSend: async (_transaction, context) => validateApproval(approval, context.operation, context.launch),
    });
    const engine = new ExecutionEngine({ owner, store, signer, chain, operations: { [kind]: operationHandler },
      authorize: async (context) => {
        await validateApproval(approval, context.operation, context.launch);
        store.recordOperationApproval(context.operation.id, { ...approval, requestId: approval.id, id: digest({ requestId: approval.id, operationId: context.operation.id }) });
        await checkNetwork();
        if (context.transaction) await fee(validateWire(context.transaction, context.operation, context.launch), context.operation.payload);
        await validateApproval(approval, context.operation, context.launch);
        return true;
      },
    });
    const deadline = now() + timeoutMs;
    while (true) {
      let status;
      try { status = await engine.resume(operation.id); }
      catch (cause) { cause.operationId = operation.id; throw cause; }
      if (status.operation.state === 'confirmed') return result(status.operation);
      if (status.operation.state === 'failed') throw error('TRANSACTION_FAILED', 'The SOL transfer failed on chain. Review its receipt before another transfer.', { operationId: operation.id });
      if (now() >= deadline) throw error('CHAIN_STATE_UNAVAILABLE', 'The saved SOL transfer is waiting for a finalized receipt. Resume this transfer to continue.', { operationId: operation.id });
      await sleep(pollIntervalMs);
    }
  };
  const result = (operation) => ({
    solTransferred: operation.payload.amountLamports / 1e9,
    txId: operation.evidence?.chain?.signature,
    operationId: operation.id,
  });
  const activeFor = (walletPublicKey, destinationWallet) => {
    owner.assertActive();
    const active = store.getActiveOperation(walletPublicKey);
    if (active && (active.kind !== kind || active.payload.destinationWallet !== destinationWallet || store.getLaunch(active.launchId)?.network !== network)) {
      throw error('OPERATION_IN_FLIGHT', 'Recover the wallet operation with its saved destination and network first', { operationId: active.id });
    }
    return active;
  };
  return {
    async recover({ walletPublicKey, destinationWallet, approval }) {
      const active = activeFor(walletPublicKey, destinationWallet);
      return active ? run(active, approval) : null;
    },
    async sweep({ scopeId, walletPublicKey, destinationWallet, approval }) {
      await checkNetwork();
      const wallet = new PublicKey(walletPublicKey).toBase58(), destination = new PublicKey(destinationWallet).toBase58();
      if (!scopeId || wallet === destination || destination === SystemProgram.programId.toBase58()) throw error('INVALID_INPUT', 'Use a saved launch and a separate return wallet');
      const active = activeFor(wallet, destination);
      if (active) return run(active, approval);
      const config = { scopeId, purpose: kind, walletPublicKey: wallet, network, genesisHash: expectedGenesisHash };
      const planDigest = digest(config);
      const launch = { id: `sol-sweep-${planDigest}`, walletPublicKey: wallet, network, planDigest, config };
      const prior = store.listOperations(launch.id);
      const current = await balance(wallet);
      const policy = await feePolicy({ connection, walletPublicKey: wallet, balanceLamports: current.lamports });
      const reserveLamports = integer(policy.reserveLamports, 'Reserve'), feeCeilingLamports = integer(policy.feeCeilingLamports, 'Fee limit');
      const microLamports = integer(policy.microLamports, 'Priority fee'), computeUnitLimit = integer(policy.computeUnitLimit, 'Compute limit');
      if (computeUnitLimit === 0 || computeUnitLimit > 1_400_000 || !Number.isSafeInteger(reserveLamports + feeCeilingLamports)) throw error('INVALID_INPUT', 'Use a bounded SOL transfer fee policy');
      const amountLamports = current.lamports - reserveLamports - feeCeilingLamports;
      if (amountLamports <= 0) {
        const completed = prior.findLast((operation) => operation.state === 'confirmed' && operation.payload.destinationWallet === destination);
        return completed ? result(completed) : { solTransferred: 0 };
      }
      const payload = { destinationWallet: destination, amountLamports, reserveLamports, feeCeilingLamports, microLamports, computeUnitLimit };
      await validateApproval(approval, { payload }, launch);
      const operation = store.transaction(() => {
        store.saveLaunch(launch);
        const prepared = store.prepareOperation({ launchId: launch.id, kind, index: prior.length, payload });
        store.recordOperationApproval(prepared.id, { ...approval, requestId: approval.id, id: digest({ requestId: approval.id, operationId: prepared.id }) });
        return prepared;
      });
      return run(operation, approval);
    },
  };
}
