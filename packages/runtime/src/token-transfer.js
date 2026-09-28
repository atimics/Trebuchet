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

const kind = 'token-transfer';
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

// One token transfer, including a destination token account when it is needed.
// NFTs use the same operation with a whole-token amount and zero decimals.
export function createTokenTransferService({
  owner, store, connection, signer, network, expectedGenesisHash, authorize, feePolicy,
  now = Date.now, timeoutMs = 60_000, pollIntervalMs = 1000,
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
    const keys = [walletPublicKey, payload.mint, payload.sourceTokenAccount, payload.destinationTokenAccount].map(publicKey);
    const response = await connection.getMultipleAccountsInfoAndContext(keys, { commitment: 'finalized', minContextSlot });
    if (!Number.isSafeInteger(response?.context?.slot) || response.context.slot < minContextSlot || !Array.isArray(response.value) || response.value.length !== keys.length) throw uncertain('Read complete finalized transfer accounts');
    const [walletInfo, mintInfo, sourceInfo, destinationInfo] = response.value;
    const program = publicKey(payload.programId);
    let mint, source, destination = null;
    try {
      mint = unpackMint(keys[1], mintInfo, program);
      source = unpackAccount(keys[2], sourceInfo, program);
      if (destinationInfo && !(destinationInfo.owner.equals(SystemProgram.programId) && destinationInfo.data.length === 0)) destination = unpackAccount(keys[3], destinationInfo, program);
    } catch (cause) { throw uncertain(`Verify the mint and token accounts: ${cause.message || cause.name}`); }
    if (!walletInfo || !walletInfo.owner.equals(SystemProgram.programId) || !Number.isSafeInteger(walletInfo.lamports) || walletInfo.lamports < 0
        || !mint.isInitialized || mint.decimals !== payload.decimals || !source.isInitialized || source.isFrozen
        || source.owner.toBase58() !== walletPublicKey || source.mint.toBase58() !== payload.mint
        || (destination && (!destination.isInitialized || destination.isFrozen || destination.owner.toBase58() !== payload.destinationWallet || destination.mint.toBase58() !== payload.mint))) {
      throw uncertain('Verify the transfer wallet, mint, decimals, and token account owners');
    }
    const extensions = getExtensionTypes(mint.tlvData);
    if (extensions.includes(ExtensionType.TransferHook) || extensions.includes(ExtensionType.NonTransferable) || extensions.includes(ExtensionType.ConfidentialTransferMint)) {
      throw failure('TOKEN_EXTENSION_REQUIRES_REVIEW', 'This token extension needs a dedicated transfer adapter');
    }
    return { slot: response.context.slot, walletLamports: walletInfo.lamports, mint, source, destination, destinationLamports: destinationInfo?.lamports || 0, extensions };
  };
  const transactionFor = (payload, walletPublicKey, blockhash) => {
    const wallet = publicKey(walletPublicKey), program = publicKey(payload.programId), mint = publicKey(payload.mint);
    const source = publicKey(payload.sourceTokenAccount), destination = publicKey(payload.destinationTokenAccount);
    const tx = new Transaction({ feePayer: wallet, recentBlockhash: blockhash }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: payload.computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: payload.microLamports }),
    );
    if (payload.createDestination) tx.add(createAssociatedTokenAccountIdempotentInstruction(wallet, destination, publicKey(payload.destinationWallet), mint, program));
    tx.add(payload.hasTransferFee
      ? createTransferCheckedWithFeeInstruction(source, mint, destination, wallet, amount(payload.amountRaw), payload.decimals, amount(payload.transferFeeRaw), [], program)
      : createTransferCheckedInstruction(source, mint, destination, wallet, amount(payload.amountRaw), payload.decimals, [], program));
    return tx;
  };
  const validateWire = (transaction, operation, launch) => {
    const signed = VersionedTransaction.deserialize(Buffer.from(transaction.wire, 'base64'));
    const expected = transactionFor(operation.payload, launch.walletPublicKey, transaction.blockhash).compileMessage();
    if (!Buffer.from(signed.message.serialize()).equals(Buffer.from(expected.serialize()))) throw failure('TRANSACTION_INVALID', 'The signed token transfer must match the saved intent');
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
            || !Buffer.from(receipt.transaction.message.serialize()).equals(Buffer.from(message.serialize()))) throw uncertain('Verify the finalized token transfer and its message');
        const keys = message.staticAccountKeys.map((key) => key.toBase58());
        const sourceIndex = keys.indexOf(payload.sourceTokenAccount), destinationIndex = keys.indexOf(payload.destinationTokenAccount);
        const meta = receipt.meta;
        if (sourceIndex < 1 || destinationIndex < 1 || !Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances)
            || meta.preBalances.length !== keys.length || meta.postBalances.length !== keys.length
            || [...meta.preBalances, ...meta.postBalances, meta.fee].some((value) => !Number.isSafeInteger(value) || value < 0)) throw uncertain('Read complete lamport balances for the token transfer');
        const rent = meta.preBalances[0] - meta.postBalances[0] - meta.fee;
        const movedNative = payload.isNative ? amount(payload.amountRaw) : 0n;
        if (meta.fee > payload.feeCeilingLamports || rent < 0 || rent > payload.rentCeilingLamports
            || BigInt(meta.postBalances[destinationIndex]) - BigInt(meta.preBalances[destinationIndex]) !== BigInt(rent) + movedNative
            || BigInt(meta.preBalances[sourceIndex]) - BigInt(meta.postBalances[sourceIndex]) !== movedNative) throw uncertain('Verify the transfer account rent and fee');
        const sourceBefore = tokenBalance(meta.preTokenBalances, sourceIndex, payload, launch.walletPublicKey);
        const sourceAfter = tokenBalance(meta.postTokenBalances, sourceIndex, payload, launch.walletPublicKey);
        const destinationBefore = tokenBalance(meta.preTokenBalances, destinationIndex, payload, payload.destinationWallet, payload.createDestination);
        const destinationAfter = tokenBalance(meta.postTokenBalances, destinationIndex, payload, payload.destinationWallet);
        const sent = amount(payload.amountRaw), received = sent - amount(payload.transferFeeRaw);
        if (sourceBefore - sourceAfter !== sent || destinationAfter - destinationBefore !== received) throw uncertain('Verify the exact token debit, credit, and transfer fee');
        return { state: 'complete', evidence: { signature: confirmed.signature, slot: receipt.slot, mint: payload.mint, programId: payload.programId, decimals: payload.decimals, sourceTokenAccount: payload.sourceTokenAccount,
          destinationWallet: payload.destinationWallet, destinationTokenAccount: payload.destinationTokenAccount, amountRaw: payload.amountRaw, receivedRaw: received.toString(), transferFeeRaw: payload.transferFeeRaw, feeLamports: meta.fee, rentLamports: rent } };
      }
      const current = await snapshot(payload, launch.walletPublicKey, minContextSlot);
      if (current.source.amount < amount(payload.amountRaw) || current.walletLamports < payload.feeCeilingLamports + (current.destination ? 0 : payload.rentCeilingLamports)
          || (!current.destination && !payload.createDestination)) throw uncertain('Recover the saved token amount and fee balance before continuing');
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
    const token = approval?.token;
    const payload = operation.payload;
    if (!approval || typeof approval.id !== 'string' || !approval.id || approval.walletPublicKey !== launch.walletPublicKey || approval.destinationWallet !== payload.destinationWallet
        || approval.network !== network || approval.genesisHash !== expectedGenesisHash || !Number.isSafeInteger(approval.expiresAtMs) || approval.expiresAtMs <= now()
        || !Number.isSafeInteger(approval.maxSpendLamports) || approval.maxSpendLamports < payload.feeCeilingLamports + payload.rentCeilingLamports
        || !token || token.mint !== payload.mint || token.programId !== payload.programId || token.sourceTokenAccount !== payload.sourceTokenAccount
        || token.amountRaw !== payload.amountRaw || token.decimals !== payload.decimals
        || (launch.config.action && (approval.scopeId !== launch.config.scopeId || publicJson(approval.action || null) !== publicJson(launch.config.action))) || await authorize({ approval, operation, launch }) !== true) {
      throw failure('EXECUTION_APPROVAL_REQUIRED', 'Approve the exact token, source, destination, amount, network, and fee limit');
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
      if (now() >= deadline) throw Object.assign(uncertain('Resume the saved token transfer when its finalized receipt is available'), { operationId: operation.id });
      await sleep(pollIntervalMs);
    }
  };
  const activeFor = (walletPublicKey, destinationWallet) => {
    owner.assertActive();
    const active = store.getActiveOperation(walletPublicKey);
    if (active && (active.kind !== kind || active.payload.destinationWallet !== destinationWallet || store.getLaunch(active.launchId)?.network !== network)) throw failure('OPERATION_IN_FLIGHT', 'Recover the saved wallet operation first', { operationId: active.id });
    return active;
  };
  return {
    async recover({ scopeId, walletPublicKey, destinationWallet, approval }) {
      const operation = activeFor(walletPublicKey, destinationWallet);
      if (operation && scopeId && store.getLaunch(operation.launchId).config.scopeId !== scopeId) throw failure('OPERATION_IN_FLIGHT', 'Resume the saved launch scope', { operationId: operation.id });
      return operation ? run(operation, approval) : null;
    },
    async transfer({ scopeId, walletPublicKey, destinationWallet, mint, programId, sourceTokenAccount, amountRaw, decimals, action, approval }) {
      const wallet = address(walletPublicKey), destination = address(destinationWallet), tokenMint = address(mint), program = address(programId);
      if (!scopeId || wallet === destination || destination === SystemProgram.programId.toBase58() || ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(program)
          || !Number.isInteger(decimals) || decimals < 0 || decimals > 255 || amount(amountRaw) === 0n) throw failure('INVALID_INPUT', 'Use a saved launch, token program, exact amount, and separate destination');
      const source = sourceTokenAccount ? address(sourceTokenAccount) : getAssociatedTokenAddressSync(publicKey(tokenMint), publicKey(wallet), false, publicKey(program)).toBase58();
      const destinationTokenAccount = getAssociatedTokenAddressSync(publicKey(tokenMint), publicKey(destination), false, publicKey(program)).toBase58();
      const intent = { mint: tokenMint, programId: program, sourceTokenAccount: source, destinationWallet: destination, destinationTokenAccount, amountRaw: amount(amountRaw).toString(), decimals };
      if (action !== undefined && (!action || typeof action.key !== 'string' || !action.key || action.key.length > 256)) throw failure('INVALID_INPUT', 'Use a stable transfer action key');
      const config = { scopeId, purpose: kind, walletPublicKey: wallet, network, genesisHash: expectedGenesisHash,
        ...(action ? { action: JSON.parse(publicJson(action)) } : {}) };
      const planDigest = digest(config), launch = { id: `${kind}-${action ? digest({ scopeId, walletPublicKey: wallet, network, actionKey: action.key }) : planDigest}`, walletPublicKey: wallet, network, planDigest, config };
      const savedLaunch = store.getLaunch(launch.id);
      if (savedLaunch && savedLaunch.planDigest !== planDigest) throw failure('OPERATION_CONFLICT', 'Use the original transfer action and launch plan');
      const pending = activeFor(wallet, destination);
      if (pending) {
        if (pending.launchId !== launch.id || Object.entries(intent).some(([key, value]) => pending.payload[key] !== value)) throw failure('OPERATION_IN_FLIGHT', 'Recover the exact saved token transfer first', { operationId: pending.id });
        return run(pending, approval);
      }
      const saved = action && store.listOperations(launch.id)[0];
      if (saved) {
        if (Object.entries(intent).some(([key, value]) => saved.payload[key] !== value)) throw failure('OPERATION_CONFLICT', 'Use the original token, amount, source, and recipient', { operationId: saved.id });
        return run(saved, approval);
      }
      const current = await snapshot(intent, wallet);
      const policy = await feePolicy({ connection, walletPublicKey: wallet });
      const computeUnitLimit = integer(policy.computeUnitLimit, 'Compute limit'), microLamports = integer(policy.microLamports, 'Priority fee'), feeCeilingLamports = integer(policy.feeCeilingLamports, 'Fee limit');
      if (!computeUnitLimit || computeUnitLimit > 1_400_000) throw failure('INVALID_INPUT', 'Use a bounded token transfer compute limit');
      const accountExtensions = program === TOKEN_2022_PROGRAM_ID.toBase58()
        ? [ExtensionType.ImmutableOwner, ...current.extensions.map(getAccountTypeOfMintType).filter((type) => type !== ExtensionType.Uninitialized)] : [];
      const rentCeilingLamports = current.destination ? 0 : integer(await connection.getMinimumBalanceForRentExemption(getAccountLen(accountExtensions), 'finalized'), 'Account rent');
      if (!Number.isSafeInteger(rentCeilingLamports + feeCeilingLamports)) throw failure('INVALID_INPUT', 'Use a safe integer spending ceiling');
      const transferFee = getTransferFeeConfig(current.mint);
      let transferFeeRaw = '0';
      if (transferFee) {
        const epoch = await connection.getEpochInfo('finalized');
        if (!Number.isSafeInteger(epoch?.epoch) || epoch.epoch < 0 || !Number.isSafeInteger(epoch.absoluteSlot) || epoch.absoluteSlot < current.slot) throw uncertain('Read the current finalized epoch for the token fee');
        transferFeeRaw = calculateEpochFee(transferFee, BigInt(epoch.epoch), amount(intent.amountRaw)).toString();
      }
      const payload = { ...intent, createDestination: !current.destination, isNative: current.source.isNative, hasTransferFee: !!transferFee, transferFeeRaw, rentCeilingLamports, feeCeilingLamports, computeUnitLimit, microLamports };
      await validateApproval(approval, { payload }, launch);
      const operation = store.transaction(() => {
        store.saveLaunch(launch);
        const prepared = store.prepareOperation({ launchId: launch.id, kind, index: action ? 0 : store.listOperations(launch.id).length, payload });
        recordApproval(prepared, approval);
        return prepared;
      });
      return run(operation, approval);
    },
  };
}
