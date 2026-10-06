import { createHash } from 'node:crypto';
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  createTransferCheckedWithFeeInstruction, unpackAccount, unpackMint,
  getTransferFeeConfig, calculateEpochFee, getExtensionTypes, getAccountTypeOfMintType,
  getAccountLen, ExtensionType,
} from '@solana/spl-token';
import { ExecutionEngine } from './engine.js';
import { createSolanaChain } from './solana.js';
import { publicJson } from './store.js';

// Several transfers of one token from one wallet, in one transaction: each recipient's token
// account is created when it is missing, then credited. The transaction lands whole or not at
// all, and its finalized receipt is checked recipient by recipient, exactly as a single
// transfer is. One transaction is in flight for the wallet at a time, as for every operation.
export const TOKEN_TRANSFER_BATCH_MAX = 5;

const kind = 'token-transfer-batch';
const failure = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const uncertain = (message) => failure('CHAIN_STATE_UNAVAILABLE', message);
const digest = (value) => createHash('sha256').update(publicJson(value)).digest('hex');
const integer = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw failure('INVALID_INPUT', `${label} requires a nonnegative whole number`);
  return value;
};
const amount = (value) => {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text) || text.length > 20 || BigInt(text) > 18446744073709551615n) throw failure('INVALID_INPUT', 'Use an exact unsigned 64-bit token amount');
  return BigInt(text);
};
const address = (value) => new PublicKey(value).toBase58();
const publicKey = (value) => new PublicKey(value);

export function createTokenTransferBatchService({
  owner, store, connection, signer, network, expectedGenesisHash, authorize, feePolicy,
  now = Date.now, timeoutMs = 90_000, pollIntervalMs = 1000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (typeof authorize !== 'function' || typeof feePolicy !== 'function') throw new TypeError('Token transfers require approval and fee policy interfaces');
  const checkNetwork = async () => {
    owner.assertActive();
    if (await connection.getGenesisHash() !== expectedGenesisHash) throw failure('NETWORK_MISMATCH', 'Use the approved Solana network');
    owner.assertActive();
  };
  const snapshot = async (payload, walletPublicKey, minContextSlot = 0) => {
    await checkNetwork();
    const keys = [walletPublicKey, payload.mint, payload.sourceTokenAccount, ...payload.recipients.map((row) => row.destinationTokenAccount)].map(publicKey);
    const response = await connection.getMultipleAccountsInfoAndContext(keys, { commitment: 'finalized', minContextSlot });
    if (!Number.isSafeInteger(response?.context?.slot) || response.context.slot < minContextSlot || !Array.isArray(response.value) || response.value.length !== keys.length) throw uncertain('Read complete finalized transfer accounts');
    const [walletInfo, mintInfo, sourceInfo, ...destinationInfos] = response.value;
    const program = publicKey(payload.programId);
    if (mintInfo && !mintInfo.owner.equals(program)) throw failure('TOKEN_PROGRAM_MISMATCH', 'The coin belongs to a different token program than this transfer names');
    let mint, source;
    const destinations = [];
    try {
      mint = unpackMint(keys[1], mintInfo, program);
      source = unpackAccount(keys[2], sourceInfo, program);
      destinationInfos.forEach((info, index) => {
        destinations.push(info && !(info.owner.equals(SystemProgram.programId) && info.data.length === 0) ? unpackAccount(keys[3 + index], info, program) : null);
      });
    } catch (cause) { throw uncertain(`Verify the mint and token accounts: ${cause.message || cause.name}`); }
    if (!walletInfo || !walletInfo.owner.equals(SystemProgram.programId) || !Number.isSafeInteger(walletInfo.lamports) || walletInfo.lamports < 0
        || !mint.isInitialized || mint.decimals !== payload.decimals || !source.isInitialized || source.isFrozen || source.isNative
        || source.owner.toBase58() !== walletPublicKey || source.mint.toBase58() !== payload.mint
        || destinations.some((destination, index) => destination && (!destination.isInitialized || destination.isFrozen
          || destination.owner.toBase58() !== payload.recipients[index].destinationWallet || destination.mint.toBase58() !== payload.mint))) {
      throw uncertain('Verify the transfer wallet, mint, decimals, and token account owners');
    }
    const extensions = getExtensionTypes(mint.tlvData);
    if (extensions.includes(ExtensionType.TransferHook) || extensions.includes(ExtensionType.NonTransferable) || extensions.includes(ExtensionType.ConfidentialTransferMint)) {
      throw failure('TOKEN_EXTENSION_REQUIRES_REVIEW', 'This token extension needs a dedicated transfer adapter');
    }
    return { slot: response.context.slot, walletLamports: walletInfo.lamports, mint, source, destinations, extensions };
  };
  const transactionFor = (payload, walletPublicKey, blockhash) => {
    const wallet = publicKey(walletPublicKey), program = publicKey(payload.programId), mint = publicKey(payload.mint), source = publicKey(payload.sourceTokenAccount);
    const tx = new Transaction({ feePayer: wallet, recentBlockhash: blockhash }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: payload.computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: payload.microLamports }),
    );
    for (const row of payload.recipients) {
      const destination = publicKey(row.destinationTokenAccount);
      if (row.createDestination) tx.add(createAssociatedTokenAccountIdempotentInstruction(wallet, destination, publicKey(row.destinationWallet), mint, program));
      tx.add(payload.hasTransferFee
        ? createTransferCheckedWithFeeInstruction(source, mint, destination, wallet, amount(row.amountRaw), payload.decimals, amount(row.transferFeeRaw), [], program)
        : createTransferCheckedInstruction(source, mint, destination, wallet, amount(row.amountRaw), payload.decimals, [], program));
    }
    return tx;
  };
  const validateWire = (transaction, operation, launch) => {
    const signed = VersionedTransaction.deserialize(Buffer.from(transaction.wire, 'base64'));
    const expected = transactionFor(operation.payload, launch.walletPublicKey, transaction.blockhash).compileMessage();
    if (!Buffer.from(signed.message.serialize()).equals(Buffer.from(expected.serialize()))) throw failure('TRANSACTION_INVALID', 'The signed token transfers must match the saved intent');
    return signed.message;
  };
  const checkFee = async (message, payload) => {
    const quote = await connection.getFeeForMessage(message, 'finalized');
    if (!Number.isSafeInteger(quote?.context?.slot) || quote.context.slot < 0 || !Number.isSafeInteger(quote.value) || quote.value < 0) throw uncertain('Read the token transfer fee before sending');
    if (quote.value > payload.feeCeilingLamports) throw failure('SPEND_LIMIT_EXCEEDED', 'The transfer fee exceeds its saved limit');
  };
  const tokenBalance = (rows, index, payload, wallet, optional = false) => {
    if (!Array.isArray(rows)) throw uncertain('Read complete token balance changes in the receipt');
    const matches = rows.filter((entry) => entry.accountIndex === index);
    if (optional && matches.length === 0) return 0n;
    if (matches.length !== 1) throw uncertain('Read a single token balance for each transfer account');
    const entry = matches[0];
    if (entry.mint !== payload.mint || (entry.owner !== undefined && entry.owner !== wallet)
        || (entry.programId !== undefined && entry.programId !== payload.programId) || entry.uiTokenAmount?.decimals !== payload.decimals) throw uncertain('Verify the receipt token identity and owner');
    try { return amount(entry.uiTokenAmount.amount); } catch { throw uncertain('Read an exact token amount from the receipt'); }
  };
  const total = (payload) => payload.recipients.reduce((sum, row) => sum + amount(row.amountRaw), 0n);
  const handler = {
    async checkState({ operation, launch, transactions, minContextSlot }) {
      await checkNetwork();
      const payload = operation.payload;
      const confirmed = transactions.find((tx) => tx.state === 'confirmed');
      if (confirmed) {
        const message = validateWire(confirmed, operation, launch);
        const receipt = await connection.getTransaction(confirmed.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
        if (!receipt || !Number.isSafeInteger(receipt.slot) || receipt.slot < minContextSlot || receipt.meta?.err !== null
            || receipt.transaction?.signatures?.[0] !== confirmed.signature || typeof receipt.transaction?.message?.serialize !== 'function'
            || !Buffer.from(receipt.transaction.message.serialize()).equals(Buffer.from(message.serialize()))) throw uncertain('Verify the finalized token transfers and their message');
        const keys = message.staticAccountKeys.map((key) => key.toBase58());
        const meta = receipt.meta;
        if (!Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances) || meta.preBalances.length !== keys.length || meta.postBalances.length !== keys.length
            || [...meta.preBalances, ...meta.postBalances, meta.fee].some((value) => !Number.isSafeInteger(value) || value < 0)) throw uncertain('Read complete lamport balances for the token transfers');
        const sourceIndex = keys.indexOf(payload.sourceTokenAccount);
        if (sourceIndex < 1) throw uncertain('Find the source token account in the receipt');
        // Rent paid by the wallet goes only to the token accounts this batch created.
        const rent = meta.preBalances[0] - meta.postBalances[0] - meta.fee;
        if (meta.fee > payload.feeCeilingLamports || rent < 0 || rent > payload.rentCeilingLamports
            || meta.preBalances[sourceIndex] !== meta.postBalances[sourceIndex]) throw uncertain('Verify the transfer account rent and fee');
        let credited = 0;
        const recipients = [];
        for (const row of payload.recipients) {
          const index = keys.indexOf(row.destinationTokenAccount);
          if (index < 1) throw uncertain('Find each recipient token account in the receipt');
          credited += meta.postBalances[index] - meta.preBalances[index];
          const before = tokenBalance(meta.preTokenBalances, index, payload, row.destinationWallet, row.createDestination);
          const after = tokenBalance(meta.postTokenBalances, index, payload, row.destinationWallet);
          const received = amount(row.amountRaw) - amount(row.transferFeeRaw);
          if (after - before !== received) throw uncertain('Verify each recipient\'s exact token credit');
          recipients.push({ destinationWallet: row.destinationWallet, destinationTokenAccount: row.destinationTokenAccount,
            amountRaw: row.amountRaw, receivedRaw: received.toString(), transferFeeRaw: row.transferFeeRaw });
        }
        if (credited !== rent) throw uncertain('Verify the rent paid into new recipient accounts');
        const sourceBefore = tokenBalance(meta.preTokenBalances, sourceIndex, payload, launch.walletPublicKey);
        const sourceAfter = tokenBalance(meta.postTokenBalances, sourceIndex, payload, launch.walletPublicKey);
        if (sourceBefore - sourceAfter !== total(payload)) throw uncertain('Verify the exact token debit');
        return { state: 'complete', evidence: { signature: confirmed.signature, slot: receipt.slot, mint: payload.mint, programId: payload.programId, decimals: payload.decimals,
          sourceTokenAccount: payload.sourceTokenAccount, recipients, feeLamports: meta.fee, rentLamports: rent } };
      }
      const current = await snapshot(payload, launch.walletPublicKey, minContextSlot);
      const missing = payload.recipients.some((row, index) => !current.destinations[index] && !row.createDestination);
      if (current.source.amount < total(payload) || current.walletLamports < payload.feeCeilingLamports + payload.rentCeilingLamports || missing) {
        throw uncertain('Recover the saved token amount and fee balance before continuing');
      }
      return { state: 'ready', evidence: { slot: current.slot, sourceAmountRaw: current.source.amount.toString(), walletLamports: current.walletLamports } };
    },
    async buildTransaction({ operation, launch }) {
      await checkNetwork();
      const expiry = await connection.getLatestBlockhash('finalized');
      const transaction = transactionFor(operation.payload, launch.walletPublicKey, expiry.blockhash);
      await checkFee(transaction.compileMessage(), operation.payload);
      return { ...expiry, transaction };
    },
  };
  const validateApproval = async (approval, operation, launch) => {
    owner.assertActive();
    const batch = approval?.batch;
    const payload = operation.payload;
    const approvedRows = Array.isArray(batch?.recipients) ? batch.recipients.map((row) => `${row.destinationWallet}:${row.amountRaw}`) : [];
    const savedRows = payload.recipients.map((row) => `${row.destinationWallet}:${row.amountRaw}`);
    if (!approval || typeof approval.id !== 'string' || !approval.id || approval.walletPublicKey !== launch.walletPublicKey
        || approval.network !== network || approval.genesisHash !== expectedGenesisHash || !Number.isSafeInteger(approval.expiresAtMs) || approval.expiresAtMs <= now()
        || !Number.isSafeInteger(approval.maxSpendLamports) || approval.maxSpendLamports < payload.feeCeilingLamports + payload.rentCeilingLamports
        || !batch || batch.mint !== payload.mint || batch.programId !== payload.programId || batch.sourceTokenAccount !== payload.sourceTokenAccount
        || batch.decimals !== payload.decimals || publicJson(approvedRows) !== publicJson(savedRows)
        || (launch.config.action && (approval.scopeId !== launch.config.scopeId || publicJson(approval.action || null) !== publicJson(launch.config.action))) || await authorize({ approval, operation, launch }) !== true) {
      throw failure('EXECUTION_APPROVAL_REQUIRED', 'Approve the exact token, source, recipients, amounts, network, and fee limit');
    }
    owner.assertActive();
  };
  const recordApproval = (operation, approval) => store.recordOperationApproval(operation.id, { ...approval, requestId: approval.id, id: digest({ requestId: approval.id, operationId: operation.id }) });
  const run = async (operation, approval) => {
    const chain = createSolanaChain({ connection, network, expectedGenesisHash, beforeSend: async (_transaction, context) => validateApproval(approval, context.operation, context.launch) });
    const engine = new ExecutionEngine({ owner, store, signer, chain, operations: { [kind]: handler }, authorize: async (context) => {
      await validateApproval(approval, context.operation, context.launch);
      recordApproval(context.operation, approval);
      await checkNetwork();
      if (context.transaction) await checkFee(validateWire(context.transaction, context.operation, context.launch), context.operation.payload);
      await validateApproval(approval, context.operation, context.launch);
      return true;
    } });
    const deadline = now() + timeoutMs;
    while (true) {
      let status;
      try { status = await engine.resume(operation.id); } catch (cause) { cause.operationId = operation.id; throw cause; }
      if (status.operation.state === 'confirmed') return { operationId: operation.id, txId: status.operation.evidence.chain.signature, ...status.operation.evidence.chain };
      if (status.operation.state === 'failed') throw failure('TRANSACTION_FAILED', 'Review the failed token transfer receipt before starting another transfer', { operationId: operation.id });
      if (now() >= deadline) throw Object.assign(uncertain('Resume the saved token transfers when their finalized receipt is available'), { operationId: operation.id });
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
    async recover({ scopeId, walletPublicKey, approval }) {
      const operation = activeFor(walletPublicKey);
      if (operation && scopeId && store.getLaunch(operation.launchId).config.scopeId !== scopeId) throw failure('OPERATION_IN_FLIGHT', 'Resume the saved launch scope', { operationId: operation.id });
      return operation ? run(operation, approval) : null;
    },
    async transferBatch({ scopeId, walletPublicKey, mint, programId, sourceTokenAccount, decimals, recipients, action, approval }) {
      const wallet = address(walletPublicKey), tokenMint = address(mint), program = address(programId);
      if (!scopeId || ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(program)
          || !Number.isInteger(decimals) || decimals < 0 || decimals > 255
          || !Array.isArray(recipients) || recipients.length === 0 || recipients.length > TOKEN_TRANSFER_BATCH_MAX) {
        throw failure('INVALID_INPUT', `Use a saved launch, token program, decimals, and 1 to ${TOKEN_TRANSFER_BATCH_MAX} recipients`);
      }
      const rows = recipients.map((row) => {
        const destinationWallet = address(row.destinationWallet);
        if (destinationWallet === wallet || destinationWallet === SystemProgram.programId.toBase58() || amount(row.amountRaw) === 0n) throw failure('INVALID_INPUT', 'Use exact amounts and recipients separate from the wallet');
        return { destinationWallet, amountRaw: amount(row.amountRaw).toString(),
          destinationTokenAccount: getAssociatedTokenAddressSync(publicKey(tokenMint), publicKey(destinationWallet), false, publicKey(program)).toBase58() };
      });
      if (new Set(rows.map((row) => row.destinationWallet)).size !== rows.length) throw failure('INVALID_INPUT', 'Each recipient appears once in a batch');
      const source = sourceTokenAccount ? address(sourceTokenAccount) : getAssociatedTokenAddressSync(publicKey(tokenMint), publicKey(wallet), false, publicKey(program)).toBase58();
      const intent = { mint: tokenMint, programId: program, sourceTokenAccount: source, decimals,
        recipients: rows.map(({ destinationWallet, destinationTokenAccount, amountRaw }) => ({ destinationWallet, destinationTokenAccount, amountRaw })) };
      if (!action || typeof action.key !== 'string' || !action.key || action.key.length > 256) throw failure('INVALID_INPUT', 'Use a stable transfer action key');
      const config = { scopeId, purpose: kind, walletPublicKey: wallet, network, genesisHash: expectedGenesisHash, action: JSON.parse(publicJson(action)) };
      const planDigest = digest(config), launch = { id: `${kind}-${digest({ scopeId, walletPublicKey: wallet, network, actionKey: action.key })}`, walletPublicKey: wallet, network, planDigest, config };
      const savedLaunch = store.getLaunch(launch.id);
      if (savedLaunch && savedLaunch.planDigest !== planDigest) throw failure('OPERATION_CONFLICT', 'Use the original transfer action and launch plan');
      const sameIntent = (payload) => publicJson({ mint: payload.mint, programId: payload.programId, sourceTokenAccount: payload.sourceTokenAccount, decimals: payload.decimals,
        recipients: payload.recipients.map(({ destinationWallet, destinationTokenAccount, amountRaw }) => ({ destinationWallet, destinationTokenAccount, amountRaw })) }) === publicJson(intent);
      const pending = activeFor(wallet);
      if (pending) {
        if (pending.launchId !== launch.id || !sameIntent(pending.payload)) throw failure('OPERATION_IN_FLIGHT', 'Recover the exact saved token transfers first', { operationId: pending.id });
        return run(pending, approval);
      }
      const saved = store.listOperations(launch.id)[0];
      if (saved) {
        if (!sameIntent(saved.payload)) throw failure('OPERATION_CONFLICT', 'Use the original token, amounts, source, and recipients', { operationId: saved.id });
        return run(saved, approval);
      }
      const current = await snapshot({ ...intent, recipients: rows }, wallet);
      const policy = await feePolicy({ connection, walletPublicKey: wallet, recipientCount: rows.length });
      const computeUnitLimit = integer(policy.computeUnitLimit, 'Compute limit'), microLamports = integer(policy.microLamports, 'Priority fee'), feeCeilingLamports = integer(policy.feeCeilingLamports, 'Fee limit');
      if (!computeUnitLimit || computeUnitLimit > 1_400_000) throw failure('INVALID_INPUT', 'Use a bounded token transfer compute limit');
      const accountExtensions = program === TOKEN_2022_PROGRAM_ID.toBase58()
        ? [ExtensionType.ImmutableOwner, ...current.extensions.map(getAccountTypeOfMintType).filter((type) => type !== ExtensionType.Uninitialized)] : [];
      const accountRent = integer(await connection.getMinimumBalanceForRentExemption(getAccountLen(accountExtensions), 'finalized'), 'Account rent');
      const transferFee = getTransferFeeConfig(current.mint);
      let epoch = null;
      if (transferFee) {
        epoch = await connection.getEpochInfo('finalized');
        if (!Number.isSafeInteger(epoch?.epoch) || epoch.epoch < 0 || !Number.isSafeInteger(epoch.absoluteSlot) || epoch.absoluteSlot < current.slot) throw uncertain('Read the current finalized epoch for the token fee');
      }
      const payloadRows = rows.map((row, index) => ({
        ...row,
        createDestination: !current.destinations[index],
        transferFeeRaw: transferFee ? calculateEpochFee(transferFee, BigInt(epoch.epoch), amount(row.amountRaw)).toString() : '0',
      }));
      const rentCeilingLamports = accountRent * payloadRows.filter((row) => row.createDestination).length;
      if (!Number.isSafeInteger(rentCeilingLamports + feeCeilingLamports)) throw failure('INVALID_INPUT', 'Use a safe integer spending ceiling');
      const payload = { mint: tokenMint, programId: program, sourceTokenAccount: source, decimals, hasTransferFee: !!transferFee,
        recipients: payloadRows, rentCeilingLamports, feeCeilingLamports, computeUnitLimit, microLamports };
      await validateApproval(approval, { payload }, launch);
      const operation = store.transaction(() => {
        store.saveLaunch(launch);
        const prepared = store.prepareOperation({ launchId: launch.id, kind, index: 0, payload });
        recordApproval(prepared, approval);
        return prepared;
      });
      return run(operation, approval);
    },
  };
}
