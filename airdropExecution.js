import { createHash } from 'node:crypto';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { normalizeTokenAmountRaw, formatTokenAmountRaw } from '@trebuchet/core/validators';
import { openRuntimeStore, publicJson } from '@trebuchet/runtime/store';
import { SOLANA_GENESIS_HASHES } from '@trebuchet/runtime/solana';
import { getNetwork, getRpcUrl } from './rpcConfig.js';
import { readObservedAirdrop } from '@trebuchet/runtime/observed-airdrop';
import { throwIfExecutionPaused } from './chainRetry.js';
import { createExecutionConnection } from './rpcConnection.js';

const purpose = 'airdrop';
const hash = (value) => createHash('sha256').update(publicJson(value)).digest('hex');
const paused = (message, operationId) => Object.assign(new Error(message), { code: 'EXECUTION_RECOVERY_REQUIRED', statusCode: 409, operationId });
const address = (value) => new PublicKey(value).toBase58();

export function normalizeAirdropPlan(input, walletPublicKey) {
  const tokenMint = address(input.tokenMint), tokenDecimals = Number(input.tokenDecimals);
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 255) throw paused('Use the saved token decimals');
  const programId = (input.isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID).toBase58();
  if (input.programId && input.programId !== programId) throw paused('Use the saved token program');
  if (!Array.isArray(input.recipients) || !input.recipients.length) throw paused('Provide the complete airdrop recipient list');
  const seen = new Set();
  let totalRaw = 0n;
  const recipients = input.recipients.map((row) => {
    const wallet = address(row.wallet);
    if (wallet === walletPublicKey || !PublicKey.isOnCurve(new PublicKey(wallet)) || seen.has(wallet)) throw paused('Use a distinct recipient wallet for each airdrop row');
    seen.add(wallet);
    const value = row.tokens ?? row.amount;
    if (row.amountRaw != null && !/^[0-9]+$/.test(String(row.amountRaw))) throw paused('Use whole base units for an exact raw amount');
    const amountRaw = row.amountRaw == null ? normalizeTokenAmountRaw(value, tokenDecimals) : normalizeTokenAmountRaw(row.amountRaw, 0);
    if (value !== undefined && normalizeTokenAmountRaw(value, tokenDecimals) !== amountRaw) throw paused('Match the exact raw and displayed token amounts');
    totalRaw += BigInt(amountRaw);
    return { wallet, amountRaw };
  }).sort((left, right) => left.wallet < right.wallet ? -1 : left.wallet > right.wallet ? 1 : 0);
  if (totalRaw > (1n << 64n) - 1n) throw paused('Keep the airdrop total within the token supply limit');
  return { tokenMint, tokenDecimals, programId, isToken2022: !!input.isToken2022, totalRaw: totalRaw.toString(), recipients };
}

export function createAirdropExecutionRuntime({ owner, walletExecution, getJournal, updateJournal,
  createConnection = () => createExecutionConnection(), networkForRequest = getNetwork, paceMs = 350, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const withStore = (run) => {
    owner.assertActive();
    const store = openRuntimeStore(owner.profile);
    try { return run(store); }
    catch (cause) {
      if (cause.code === 'RECOVERY_STORAGE_UNAVAILABLE' || cause.code === 'EXECUTION_RECOVERY_REQUIRED') throw cause;
      throw Object.assign(paused('Restore the saved airdrop plan before continuing'), { cause });
    } finally { store.close(); }
  };
  const context = (walletPublicKey) => {
    owner.assertActive();
    const journal = getJournal(walletPublicKey), scopeId = journal?.id, network = networkForRequest();
    if (!scopeId || !SOLANA_GENESIS_HASHES[network]) throw paused('Save the launch and select its network before the airdrop');
    return { journal, scopeId, network, walletPublicKey, id: hash({ purpose, scopeId, network, walletPublicKey }) };
  };
  const matches = (request, plan) => {
    if (request.tokenMint !== plan.tokenMint || request.tokenDecimals !== plan.tokenDecimals || request.programId !== plan.programId
        || request.recipients.some((row) => !plan.recipients.some((saved) => saved.wallet === row.wallet && saved.amountRaw === row.amountRaw))) throw paused('Use the saved airdrop token and recipient amounts');
  };
  const external = (plan) => ({ ...plan, recipients: plan.recipients.map((row) => ({ ...row, tokens: formatTokenAmountRaw(row.amountRaw, plan.tokenDecimals) })) });
  const savedPlan = (walletPublicKey) => {
    const ctx = context(walletPublicKey), launch = withStore((store) => store.getLaunch(ctx.id));
    return launch ? { ...ctx, launch, plan: launch.config.plan } : null;
  };
  const validateAction = (walletPublicKey, action, operationId) => {
    const saved = savedPlan(walletPublicKey), value = action?.context;
    if (!saved || value?.purpose !== purpose || value.scopeId !== saved.scopeId || value.network !== saved.network
        || value.planDigest !== saved.launch.planDigest || value.tokenMint !== saved.plan.tokenMint || value.programId !== saved.plan.programId
        || value.decimals !== saved.plan.tokenDecimals || action.key !== `airdrop/${value.recipient}`
        || !saved.plan.recipients.some((row) => row.wallet === value.recipient && row.amountRaw === value.amountRaw)) throw paused('Recover the exact saved airdrop recipient and amount', operationId);
    return saved;
  };
  const pending = (walletPublicKey) => {
    const ctx = context(walletPublicKey), root = savedPlan(walletPublicKey);
    const saved = withStore((store) => {
      const op = store.getActiveOperation(walletPublicKey);
      if (!op) return null;
      const launch = store.getLaunch(op.launchId);
      if (op.kind === 'airdrop-observed-delivery') {
        const value = launch?.config;
        if (!root || value.scopeId !== ctx.scopeId || launch.network !== ctx.network || value.genesisHash !== SOLANA_GENESIS_HASHES[ctx.network]
            || value.planDigest !== root.launch.planDigest || !root.plan.recipients.some((row) => row.wallet === value.recipient && row.amountRaw === value.amountRaw)) throw paused('Resume the saved airdrop receipt verification', op.id);
        return { op, legacy: true, tokenMint: root.plan.tokenMint };
      }
      if (op.kind !== 'token-transfer') return null;
      const action = launch?.config.action;
      if (action?.context?.purpose !== purpose) return null;
      const value = action.context;
      if (launch.config.scopeId !== ctx.scopeId || launch.network !== ctx.network || launch.config.genesisHash !== SOLANA_GENESIS_HASHES[ctx.network]
          || op.payload.mint !== value.tokenMint || op.payload.programId !== value.programId || op.payload.decimals !== value.decimals
          || op.payload.destinationWallet !== value.recipient || op.payload.amountRaw !== value.amountRaw) throw paused('Recover the original airdrop transfer intent', op.id);
      return { op, action };
    });
    if (saved && !saved.legacy) validateAction(walletPublicKey, saved.action, saved.op.id);
    return saved;
  };
  const checkpoint = (walletPublicKey, receipt, action) => {
    const saved = validateAction(walletPublicKey, action, receipt.operationId), value = action.context;
    if (receipt.mint !== value.tokenMint || receipt.programId !== value.programId || receipt.decimals !== value.decimals
        || receipt.destinationWallet !== value.recipient || receipt.amountRaw !== value.amountRaw) throw paused('Read the exact airdrop transfer receipt', receipt.operationId);
    const previous = saved.journal.airdrop || {}, delivered = previous.transferred || [];
    const row = { wallet: value.recipient, tokens: formatTokenAmountRaw(value.amountRaw, value.decimals), amountRaw: value.amountRaw,
      receivedRaw: receipt.receivedRaw, transferFeeRaw: receipt.transferFeeRaw, txId: receipt.txId, operationId: receipt.operationId, attempts: 1 };
    const previousRow = delivered.find((item) => item.operationId === receipt.operationId);
    if (previousRow && Object.entries(row).every(([key, value]) => previousRow[key] === value)) return;
    updateJournal(walletPublicKey, { airdrop: { ...previous, transferred: [...delivered.filter((item) => item.wallet !== row.wallet), row],
      failed: (previous.failed || []).filter((item) => item.wallet !== row.wallet) } },
    { stage: 'airdrop_recipient_done', recipient: row.wallet, tokenMint: value.tokenMint, amountRaw: row.amountRaw, txId: row.txId, operationId: row.operationId });
  };
  const replay = (walletPublicKey) => {
    for (const receipt of walletExecution.getTransferReceipts(walletPublicKey)) {
      if (receipt.action?.context?.purpose === purpose) checkpoint(walletPublicKey, receipt, receipt.action);
    }
  };
  const prepare = ({ walletPublicKey, airdrop }) => {
    const ctx = context(walletPublicKey);
    const saved = withStore((store) => store.getLaunch(ctx.id));
    const journalPlan = ctx.journal.poolPlan?.airdropPlan;
    if (!saved && !journalPlan?.recipients?.length && !airdrop?.recipients?.length) return null;
    try {
      const request = airdrop?.recipients?.length ? normalizeAirdropPlan(airdrop, walletPublicKey) : null;
      let plan = saved?.config.plan || (journalPlan?.recipients?.length ? normalizeAirdropPlan(journalPlan, walletPublicKey) : request);
      if (!saved && !journalPlan?.recipients?.length && request) {
        const rows = new Map(request.recipients.map((row) => [row.wallet, row]));
        for (const row of [...(ctx.journal.airdrop?.transferred || []), ...(ctx.journal.airdrop?.failed || [])]) {
          const normalized = normalizeAirdropPlan({ ...external(request), recipients: [row] }, walletPublicKey).recipients[0];
          if (rows.has(row.wallet) && rows.get(row.wallet).amountRaw !== normalized.amountRaw) throw paused('Preserve the saved airdrop recipient amount');
          rows.set(row.wallet, normalized);
        }
        plan = normalizeAirdropPlan({ ...external(request), recipients: [...rows.values()] }, walletPublicKey);
      }
      if (request) matches(request, plan);
      if (journalPlan?.recipients?.length) {
        const original = normalizeAirdropPlan(journalPlan, walletPublicKey);
        if (publicJson(original) !== publicJson(plan)) throw paused('Restore the complete approved airdrop plan');
      }
      for (const row of ctx.journal.airdrop?.transferred || []) {
        matches(normalizeAirdropPlan({ ...external(plan), recipients: [row] }, walletPublicKey), plan);
        if (!row.txId) throw paused('Verify each saved airdrop delivery signature before continuing');
      }
      withStore((store) => store.saveLaunch({ id: ctx.id, walletPublicKey, network: ctx.network, planDigest: hash(plan),
        config: { scopeId: ctx.scopeId, purpose, genesisHash: SOLANA_GENESIS_HASHES[ctx.network], plan } }));
      replay(walletPublicKey);
      return external(plan);
    } catch (cause) {
      if (cause.code === 'RECOVERY_STORAGE_UNAVAILABLE' || cause.code === 'EXECUTION_RECOVERY_REQUIRED') throw cause;
      throw Object.assign(paused('Review the exact airdrop amounts and recipients'), { cause });
    }
  };
  const verifyLegacy = async (walletPublicKey) => {
    const saved = savedPlan(walletPublicKey);
    if (!saved) return;
    for (const row of getJournal(walletPublicKey)?.airdrop?.transferred || []) {
      if (row.operationId) continue;
      const recipient = saved.plan.recipients.find((item) => item.wallet === row.wallet);
      if (!recipient || !row.txId) throw paused('Verify the original airdrop delivery before continuing');
      const config = { scopeId: saved.scopeId, genesisHash: SOLANA_GENESIS_HASHES[saved.network], planDigest: saved.launch.planDigest,
        recipient: row.wallet, amountRaw: recipient.amountRaw, signature: row.txId };
      const digest = hash(config), id = `airdrop-observed-${digest}`;
      let operation = withStore((store) => store.transaction(() => {
        store.saveLaunch({ id, walletPublicKey, network: saved.network, planDigest: digest, config });
        return store.listOperations(id)[0] || store.prepareOperation({ launchId: id, kind: 'airdrop-observed-delivery', payload: { originalJournalRow: row } });
      }));
      if (operation.state !== 'confirmed') {
        try {
          const receipt = await readObservedAirdrop({ connection: createConnection(), expectedGenesisHash: config.genesisHash, walletPublicKey,
            tokenMint: saved.plan.tokenMint, programId: saved.plan.programId, decimals: saved.plan.tokenDecimals,
            recipient: row.wallet, amountRaw: recipient.amountRaw, signature: row.txId });
          if (context(walletPublicKey).id !== saved.id) throw paused('Keep the saved launch scope during airdrop recovery');
          operation = withStore((store) => store.setOperationState(operation.id, 'confirmed', { source: 'legacy-journal', chain: receipt }));
        } catch (cause) {
          if (cause.code === 'RECOVERY_STORAGE_UNAVAILABLE') throw cause;
          withStore((store) => store.setOperationState(operation.id, 'recovery_required', { reason: 'LEGACY_RECEIPT_UNCERTAIN' }));
          throw Object.assign(paused('Verify the saved airdrop receipt before the next wallet action', operation.id), { cause });
        }
      }
      if (operation.state !== 'confirmed') throw paused('Complete the saved airdrop receipt verification', operation.id);
      const receipt = operation.evidence.chain;
      if (row.verifiedReceiptId === operation.id) continue;
      const current = getJournal(walletPublicKey).airdrop;
      updateJournal(walletPublicKey, { airdrop: { ...current, transferred: current.transferred.map((item) => item.wallet === row.wallet
        ? { ...item, amountRaw: receipt.amountRaw, receivedRaw: receipt.receivedRaw, transferFeeRaw: receipt.transferFeeRaw, verifiedReceiptId: operation.id } : item) } },
      { stage: 'airdrop_prior_receipt_verified', recipient: row.wallet, txId: row.txId, operationId: operation.id });
    }
  };
  const recover = async ({ tempWalletSecretKey, tokenMint }) => {
    const walletPublicKey = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey)).publicKey.toBase58();
    const saved = pending(walletPublicKey);
    let result = null;
    if (saved) {
      if (tokenMint && tokenMint !== (saved.legacy ? saved.tokenMint : saved.action.context.tokenMint)) throw paused('Resume the original airdrop token', saved.op.id);
      if (!saved.legacy) result = await walletExecution.recover({ tempWalletSecretKey, destinationWallet: saved.action.context.recipient });
    }
    replay(walletPublicKey);
    await verifyLegacy(walletPublicKey);
    return result;
  };
  return {
    prepare, recover,
    canRecover: (walletPublicKey) => !!pending(walletPublicKey),
    async execute(input) {
      const wallet = Keypair.fromSecretKey(Uint8Array.from(input.tempWalletSecretKey)), walletPublicKey = wallet.publicKey.toBase58();
      prepare({ walletPublicKey, airdrop: input });
      await recover(input);
      const saved = savedPlan(walletPublicKey), request = normalizeAirdropPlan(input, walletPublicKey);
      matches(request, saved.plan);
      const transferred = [];
      for (const row of request.recipients) {
        const done = getJournal(walletPublicKey)?.airdrop?.transferred?.find((item) => item.wallet === row.wallet);
        if (done) { transferred.push(done); continue; }
        if (transferred.length) await sleep(paceMs);
        const action = { key: `airdrop/${row.wallet}`, context: { purpose, scopeId: saved.scopeId, network: saved.network,
          planDigest: saved.launch.planDigest, tokenMint: saved.plan.tokenMint, programId: saved.plan.programId,
          decimals: saved.plan.tokenDecimals, recipient: row.wallet, amountRaw: row.amountRaw } };
        const receipt = await walletExecution.transferToken({ tempWalletSecretKey: input.tempWalletSecretKey, destinationWallet: row.wallet,
          mint: saved.plan.tokenMint, programId: saved.plan.programId, decimals: saved.plan.tokenDecimals, amountRaw: row.amountRaw, action,
          sourceTokenAccount: getAssociatedTokenAddressSync(new PublicKey(saved.plan.tokenMint), wallet.publicKey, false, new PublicKey(saved.plan.programId)).toBase58() });
        checkpoint(walletPublicKey, receipt, action);
        const delivered = getJournal(walletPublicKey).airdrop.transferred.find((item) => item.wallet === row.wallet);
        transferred.push(delivered);
        try { input.onProgress?.({ recipient: row.wallet, tokens: delivered.tokens, success: true }); }
        catch (error) { throwIfExecutionPaused(error); }
      }
      return { transferred, failed: [] };
    },
  };
}
