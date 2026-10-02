import { throwIfExecutionPaused } from './chainRetry.js';
// sweepOrchestrator.js
//
// The decision core of the post-launch asset sweep: the straggler second
// pass, the SOL gate, and the SOL sweep itself. Extracted from the
// /api/transfer-assets handler so the LOGIC is a pure, dependency-injected
// unit that tests can drive through every branch — the handler keeps the
// HTTP/journal plumbing and calls this for the part that decides whether
// money moves.
//
// The invariant this module owns (from two real user reports of assets
// left behind): SOL is the wallet's ability to pay for transactions, so it
// leaves the wallet LAST and ONLY when every other asset is verifiably out.
// Concretely, the SOL sweep runs only when ALL of:
//   1. the NFT sweep reported zero errors,
//   2. the token sweep reported zero errors,
//   3. a fresh 'finalized' re-enumeration SUCCEEDED, and
//   4. that enumeration showed no remaining token balances.
// An enumeration FAILURE fails the gate — "unknown" is not "empty". When
// the gate blocks, the SOL stays behind deliberately: it is the fee money
// (and destination-ATA rent money) the retry needs. Sweeping it anyway is
// how a recoverable partial failure becomes "manual recovery required".
//
// Second-pass semantics: if the first re-enumeration finds anything left
// (an asset a lagging node hid from the first pass, or one that landed
// mid-sweep), ONE more full NFT+token pass runs. Its transferred items are
// APPENDED to the caller's results; its errors REPLACE the first pass's
// errors — the second pass re-attempts everything still present, so an
// item that failed pass 1 but succeeded pass 2 is not an error, and an
// item still failing shows up in the second pass's own error list.

// True when the balance snapshot shows any token balance above zero.
// SOL is deliberately ignored — SOL is what the gate is deciding about.
// Malformed amounts count as "has balances" (fail closed).
export function hasTokenBalances(balanceSnapshot) {
  if (!balanceSnapshot) return false;
  return Object.values(balanceSnapshot.tokens || {}).some((t) => {
    try { return BigInt(t.amountRaw) > 0n; } catch (_) { return true; }
  });
}

/**
 * Runs the straggler pass, evaluates the SOL gate, and (only when the gate
 * passes) sweeps the SOL.
 *
 * MUTATES `nftSweep` and `tokenSweep` in place when a second pass runs
 * (transferred appended, errors replaced) — the caller reports those
 * objects, and the merged view is the truthful one.
 *
 * All side-effecting collaborators are injected so tests can drive every
 * branch:
 *   sweepNfts({tempWalletSecretKey, destinationWallet}) -> {transferred, errors}
 *   sweepTokens({tempWalletSecretKey, destinationWallet}) -> {transferred, errors}
 *   sweepSol({tempWalletSecretKey, destinationWallet}) -> {solTransferred, txId?}
 *   enumerate(walletPublicKey, {commitment}) -> {sol, tokens}   (may throw)
 *   recordEvent(event)                                          (durable commit)
 *
 * Returns { solSweep, solSweepError, solSweepSkipped, secondPassRan }.
 * Recovery failures propagate. Other sweep failures become gate outcomes.
 */
export async function finishSweepWithSolGate({
  walletPublicKey,
  tempWalletSecretKey,
  destinationWallet,
  nftSweep,
  tokenSweep,
  deps,
}) {
  const {
    sweepNfts, sweepTokens, sweepSol, enumerate, recordEvent = () => {},
  } = deps;

  // ---- Straggler pass -----------------------------------------------------
  let remainingAfterSweep = null;
  let secondPassRan = false;
  try {
    remainingAfterSweep = await enumerate(walletPublicKey, { commitment: 'finalized' });
  } catch (e) {
    throwIfExecutionPaused(e);
    console.warn('Straggler re-enumeration failed (treating as unknown):', e.message);
  }

  if (hasTokenBalances(remainingAfterSweep)) {
    secondPassRan = true;
    console.log('Straggler pass: assets remain after first sweep — running a second pass.');
    recordEvent({
      stage: 'sweep_second_pass',
      remainingTokenMints: Object.keys(remainingAfterSweep.tokens || {}).length,
    });

    const nftSweep2 = await sweepNfts({ tempWalletSecretKey, destinationWallet });
    const tokenSweep2 = await sweepTokens({ tempWalletSecretKey, destinationWallet });
    nftSweep.transferred.push(...nftSweep2.transferred);
    nftSweep.errors = nftSweep2.errors;
    tokenSweep.transferred.push(...tokenSweep2.transferred);
    tokenSweep.errors = tokenSweep2.errors;

    try {
      remainingAfterSweep = await enumerate(walletPublicKey, { commitment: 'finalized' });
    } catch (e) {
      throwIfExecutionPaused(e);
      console.warn('Post-second-pass re-enumeration failed:', e.message);
      remainingAfterSweep = null; // unknown — the gate below fails closed
    }
  }

  // ---- The SOL gate -------------------------------------------------------
  const assetSweepClean =
    (nftSweep.errors || []).length === 0
    && (tokenSweep.errors || []).length === 0
    && remainingAfterSweep !== null            // enumeration must have SUCCEEDED
    && !hasTokenBalances(remainingAfterSweep); // ...and shown nothing left

  let solSweep = { solTransferred: 0 };
  let solSweepError = null;
  let solSweepSkipped = null;

  if (!assetSweepClean) {
    solSweepSkipped = 'Assets remain in the launch wallet (or their absence '
      + 'could not be verified), so the SOL was deliberately NOT swept — '
      + 'it stays behind to pay the fees for a retry. Retry the transfer; '
      + 'nothing has been lost.';
    console.warn(`SOL sweep skipped: ${solSweepSkipped}`);
    recordEvent({
      stage: 'sol_sweep_skipped_assets_remain',
      nftErrors: (nftSweep.errors || []).length,
      tokenErrors: (tokenSweep.errors || []).length,
    });
  } else {
    try {
      solSweep = await sweepSol({ tempWalletSecretKey, destinationWallet });
    } catch (e) {
      throwIfExecutionPaused(e);
      // The gate passed — every asset is out — so a SOL-sweep failure here
      // strands only SOL, which the recovery entry (kept by the caller's
      // post-sweep verification) can always retrieve. Report, don't throw.
      console.error('SOL sweep failed (token/NFT sweeps succeeded):', e.message);
      solSweepError = e.message;
    }
  }

  return { solSweep, solSweepError, solSweepSkipped, secondPassRan };
}


// Rebuild the report from durable receipts, including earlier attempts.
// Keep legacy results while each signature contributes to the report once.
export function mergeTransferReceipts({ nftSweep, tokenSweep, receipts }) {
  const bySignature = new Map(receipts.map((receipt) => [receipt.txId, receipt]));
  const retainedSignatures = new Set();
  for (const sweep of [nftSweep, tokenSweep]) {
    sweep.transferred = sweep.transferred.filter((entry) => {
      const signatures = entry.txIds || (entry.txId ? [entry.txId] : []);
      if (signatures.length && signatures.every((signature) => bySignature.has(signature))) return false;
      for (const signature of signatures) retainedSignatures.add(signature);
      const known = signatures.filter((signature) => bySignature.has(signature)).map((signature) => bySignature.get(signature));
      if (known.length) entry.receipts = known;
      return true;
    });
  }
  const tokens = new Map();
  for (const receipt of bySignature.values()) {
    if (retainedSignatures.has(receipt.txId)) continue;
    if (receipt.decimals === 0 && receipt.amountRaw === '1') {
      nftSweep.transferred.push({ ...receipt, receipts: [receipt] });
      continue;
    }
    const key = JSON.stringify([receipt.mint, receipt.programId, receipt.decimals]);
    if (!tokens.has(key)) tokens.set(key, []);
    tokens.get(key).push(receipt);
  }
  for (const group of tokens.values()) {
    const first = group[0];
    const sum = (field) => group.reduce((total, receipt) => total + BigInt(receipt[field]), 0n).toString();
    const amountRaw = sum('amountRaw');
    const digits = amountRaw.padStart(first.decimals + 1, '0');
    const amountText = first.decimals ? `${digits.slice(0, -first.decimals)}.${digits.slice(-first.decimals)}` : digits;
    const destinations = [...new Set(group.map((receipt) => receipt.destinationWallet))];
    tokenSweep.transferred.push({
      mint: first.mint, programId: first.programId, decimals: first.decimals,
      amount: Number(amountText), amountText, amountRaw, receivedRaw: sum('receivedRaw'), transferFeeRaw: sum('transferFeeRaw'),
      txId: first.txId, txIds: group.map((receipt) => receipt.txId), receipts: group,
      ...(destinations.length === 1 ? { destinationWallet: destinations[0] } : { destinationWallets: destinations }),
    });
  }
}
