// One operation represents one atomic chain transaction. Hosts provide the
// transaction builder, signer, approval check, and chain state checks.
import { publicJson } from './store.js';

const busyOwners = new WeakMap();
const terminal = new Set(['confirmed', 'failed']);
const failure = (code, message) => Object.assign(new Error(message), { code });
const snapshot = (value) => JSON.parse(publicJson(value));
const hasEvidence = (value) => value && typeof value === 'object' && Object.keys(value).length > 0;

export class ExecutionEngine {
  constructor({ store, owner, signer, chain, operations, authorize }) {
    if (!store || !owner || typeof owner.assertActive !== 'function' || store.directory !== owner.profile) {
      throw new TypeError('Execution requires the active owner of its storage profile');
    }
    for (const [host, methods] of [[signer, ['signTransaction']], [chain, ['inspectTransaction', 'readTransaction', 'sendTransaction']]]) {
      if (methods.some((method) => typeof host?.[method] !== 'function')) throw new TypeError('Execution requires signer and chain interfaces');
    }
    if (typeof authorize !== 'function' || !operations) throw new TypeError('Execution requires operation builders and an approval check');
    this.store = store;
    this.owner = owner;
    this.signer = signer;
    this.chain = chain;
    this.operations = operations;
    this.authorize = authorize;
    if (!busyOwners.has(owner)) busyOwners.set(owner, new Set());
  }

  prepare({ launch, kind, index = 0, payload = {} }) {
    this.owner.assertActive();
    this.#handler(kind);
    if (launch.network !== this.chain.network) throw failure('NETWORK_MISMATCH', 'Launch and chain network must agree');
    return this.store.transaction(() => {
      const saved = this.store.saveLaunch(snapshot(launch));
      return this.store.prepareOperation({ launchId: saved.id, kind, index, payload: snapshot(payload) });
    });
  }

  getStatus(operationId) {
    const operation = this.store.getOperation(operationId);
    if (!operation) throw failure('OPERATION_UNKNOWN', 'Prepare the operation before execution');
    return { operation, transactions: this.store.getTransactions(operationId).map(({ wire, ...record }) => record) };
  }

  #handler(kind) {
    const handler = Object.hasOwn(this.operations, kind) && this.operations[kind];
    if (typeof handler?.buildTransaction !== 'function' || typeof handler?.checkState !== 'function') {
      throw failure('OPERATION_UNSUPPORTED', 'This host requires a builder and chain check for the operation');
    }
    return handler;
  }

  async #approve(context) {
    this.owner.assertActive();
    if (await this.authorize(context) !== true) throw failure('EXECUTION_APPROVAL_REQUIRED', 'Review and approve this operation before sending');
    this.owner.assertActive();
  }

  async executeNext(operationId) {
    this.owner.assertActive();
    const initial = this.getStatus(operationId).operation;
    const busy = busyOwners.get(this.owner);
    if (busy.has(initial.walletPublicKey)) throw failure('OPERATION_IN_FLIGHT', 'The wallet has an active execution request');
    busy.add(initial.walletPublicKey);
    try {
      return await this.#advance(initial);
    } catch (error) {
      // A failed commit stops the call. A later owner reads the last durable
      // state and reconciles its signed bytes before choosing another action.
      if (error.code !== 'RECOVERY_STORAGE_UNAVAILABLE') {
        this.owner.assertActive();
        const current = this.store.getOperation(operationId);
        if (current && !terminal.has(current.state)) this.store.setOperationState(operationId, 'recovery_required', {
          code: typeof error.code === 'string' ? error.code : 'EXECUTION_INTERRUPTED',
        });
      }
      throw error;
    } finally { busy.delete(initial.walletPublicKey); }
  }

  async resume(operationId) { return this.executeNext(operationId); }

  async #observe(transaction, context) {
    if (['confirmed', 'failed', 'expired'].includes(transaction.state)) return { state: transaction.state, evidence: transaction.receipt };
    const inspected = await this.chain.inspectTransaction(transaction.wire, context);
    if (inspected.walletPublicKey !== context.launch.walletPublicKey || inspected.signature !== transaction.signature || inspected.blockhash !== transaction.blockhash) {
      throw failure('TRANSACTION_INVALID', 'Saved transaction bytes must match the operation wallet and identity');
    }
    const observed = await this.chain.readTransaction(transaction, context);
    this.owner.assertActive();
    if (!['confirmed', 'failed', 'expired', 'pending', 'rebroadcast'].includes(observed?.state) || !hasEvidence(observed.evidence)) {
      throw failure('CHAIN_STATE_UNAVAILABLE', 'The transaction requires a complete chain status response');
    }
    if (['confirmed', 'failed', 'expired'].includes(observed.state)) {
      this.store.recordReceipt(transaction.signature, observed.state, observed.evidence);
    }
    return observed;
  }

  async #advance(operation) {
    if (terminal.has(operation.state)) return this.getStatus(operation.id);
    const launch = this.store.getLaunch(operation.launchId);
    if (launch.network !== this.chain.network) throw failure('NETWORK_MISMATCH', 'Launch and chain network must agree');
    const handler = this.#handler(operation.kind);
    const context = { launch, operation };
    const transactions = this.store.getTransactions(operation.id);
    let pending;
    let failed;
    let confirmed = false;
    let minContextSlot = 0;
    for (const transaction of transactions) {
      const observed = await this.#observe(transaction, context);
      if (observed.state === 'confirmed') confirmed = true;
      if (observed.state === 'failed') failed = { signature: transaction.signature, receipt: observed.evidence };
      if (['pending', 'rebroadcast'].includes(observed.state)) {
        if (pending) throw failure('OPERATION_CONFLICT', 'Recover the wallet transactions before continuing');
        pending = { transaction, observed };
      }
      if (Number.isSafeInteger(observed.evidence?.slot)) minContextSlot = Math.max(minContextSlot, observed.evidence.slot);
    }
    if (pending) {
      if (pending.observed.state === 'rebroadcast') return this.#broadcast(pending.transaction, context, handler);
      return this.#pause(operation.id, 'TRANSACTION_PENDING');
    }
    if (failed) {
      this.store.setOperationState(operation.id, 'failed', failed);
      return this.getStatus(operation.id);
    }
    const checked = await handler.checkState({ ...context, minContextSlot, transactions: this.store.getTransactions(operation.id) });
    this.owner.assertActive();
    if (!['complete', 'ready'].includes(checked?.state) || !hasEvidence(checked.evidence)) {
      throw failure('CHAIN_STATE_UNAVAILABLE', 'Verify the operation result before continuing');
    }
    if (checked.state === 'complete') {
      this.store.setOperationState(operation.id, 'confirmed', { chain: checked.evidence, signatures: this.store.getTransactions(operation.id).filter((tx) => tx.state === 'confirmed').map((tx) => tx.signature) });
      return this.getStatus(operation.id);
    }
    if (confirmed) return this.#pause(operation.id, 'OPERATION_RESULT_PENDING');

    await this.#approve({ ...context, phase: 'build' });
    const built = await handler.buildTransaction(context);
    this.owner.assertActive();
    if (!built?.blockhash || !Number.isSafeInteger(built.lastValidBlockHeight) || built.lastValidBlockHeight < 0) {
      throw failure('TRANSACTION_INVALID', 'The transaction needs a blockhash and expiry');
    }
    const signed = await this.signer.signTransaction({ ...context, transaction: built.transaction });
    this.owner.assertActive();
    const inspected = await this.chain.inspectTransaction(signed, context);
    if (inspected.walletPublicKey !== launch.walletPublicKey || inspected.blockhash !== built.blockhash) {
      throw failure('TRANSACTION_INVALID', 'The signed transaction must match the launch wallet and blockhash');
    }
    const transaction = { ...inspected, operationId: operation.id, lastValidBlockHeight: built.lastValidBlockHeight };
    await this.#approve({ ...context, phase: 'broadcast', transaction });
    this.store.recordSignedTransaction(transaction);
    return this.#broadcast(transaction, context, handler);
  }

  #pause(operationId, code) {
    this.owner.assertActive();
    this.store.setOperationState(operationId, 'recovery_required', { code });
    return this.getStatus(operationId);
  }

  async #broadcast(transaction, context, handler) {
    // Approval is checked again for stored bytes, including after a restart.
    await this.#approve({ ...context, phase: 'broadcast', transaction });
    this.store.setOperationState(context.operation.id, 'submitted');
    const signature = await this.chain.sendTransaction(transaction, context);
    this.owner.assertActive();
    if (signature !== transaction.signature) throw failure('TRANSACTION_ID_MISMATCH', 'The chain must return the saved transaction signature');
    this.store.recordReceipt(transaction.signature, 'submitted', { signature });
    const observed = await this.#observe({ ...transaction, state: 'submitted' }, context);
    if (observed.state === 'failed') {
      this.store.setOperationState(context.operation.id, 'failed', { signature, receipt: observed.evidence });
      return this.getStatus(context.operation.id);
    }
    if (observed.state !== 'confirmed') return this.#pause(context.operation.id, 'TRANSACTION_PENDING');
    const checked = await handler.checkState({ ...context, minContextSlot: observed.evidence.slot || 0, transactions: this.store.getTransactions(context.operation.id) });
    this.owner.assertActive();
    if (checked?.state !== 'complete' || !hasEvidence(checked.evidence)) return this.#pause(context.operation.id, 'OPERATION_RESULT_PENDING');
    this.store.setOperationState(context.operation.id, 'confirmed', { chain: checked.evidence, signatures: [signature] });
    return this.getStatus(context.operation.id);
  }
}
