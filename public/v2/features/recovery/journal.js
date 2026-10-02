function completedLaunchJournal(proof = currentLaunchProof()) {
  const mint = proofTokenMint(proof);
  if (!mint) return null;
  return (state.recovery?.journals || [])
    .filter((journal) => String(journal?.status || '').toLowerCase() === 'completed' && journalTokenMint(journal) === mint)
    .sort((a, b) => Date.parse(b.completedAt || b.updatedAt || 0) - Date.parse(a.completedAt || a.updatedAt || 0))[0] || null;
}

function renderLaunchCompleteCard(journal) {
  const transfer = journal.transfer || {};
  const facts = [
    ['Token', journal.token.mint],
    ['Returned to', transfer.destinationWallet || '—'],
    ['SOL returned', Number.isFinite(Number(transfer.solTransferred)) ? `${Number(transfer.solTransferred).toFixed(4)} SOL` : '—'],
    ['Fee Keys', transfer.nftsTransferred ?? '—'],
  ];
  return `
    <section class="launch-complete-card">
      <span class="eyebrow">Launch complete</span>
      <strong>${escapeHtml(journal.launchConfig?.token?.name || 'Token')} is live</strong>
      <dl>${facts.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd><code>${escapeHtml(String(value))}</code></dd></div>`).join('')}</dl>
      <small>Completed ${escapeHtml(new Date(journal.completedAt || journal.updatedAt).toLocaleString())}. Nothing left to fund or sweep.</small>
    </section>`;
}

function isTerminalJournal(journal) {
  return ['completed', 'archived'].includes(String(journal?.status || '').toLowerCase());
}

function journalNeedsStartupRecovery(journal) {
  if (!journal || isTerminalJournal(journal)) return false;
  const stage = String(journal.stage || '').toLowerCase();
  return String(journal.status || '').toLowerCase() === 'failed'
    || Boolean(journal.error)
    || Boolean(journal.token?.mint)
    || Boolean(journal.lp?.failedPhase)
    || /failed|partial|interrupted|resume/.test(stage);
}

function journalNeedsTokenFinish(journal) {
  return Boolean(
    journalNeedsStartupRecovery(journal)
    && journal?.token?.mint
    && journal.token.mintAuthorityRenounced !== true,
  );
}

function recoveryWorkspaceForJournal(journal = {}) {
  if (journalNeedsTokenFinish(journal)) return 'mint';
  if (journal?.token?.mint) {
    const results = journalResultList(journal);
    const plannedPoolCount = Array.isArray(journal?.poolPlan?.allocations)
      ? journal.poolPlan.allocations.length
      : Array.isArray(journal?.launchConfig?.poolTopology?.pools)
        ? journal.launchConfig.poolTopology.pools.length
        : 0;
    const liquidityComplete = Boolean(
      !journal?.lp?.failedPhase
      && results.length > 0
      && (plannedPoolCount === 0 || results.length >= plannedPoolCount)
      && results.every((result) => result?.poolId),
    );
    return liquidityComplete ? 'finish' : 'liquidity';
  }
  const stage = String(journal.stage || '').toLowerCase();
  return /fund|estimate|acquire/.test(stage) ? 'fund' : 'configure';
}

function routeStartupRecoveryFirst() {
  if (state.recoveryStartupRouted || state.apiStatus !== 'connected') return false;
  state.recoveryStartupRouted = true;
  const journal = [...state.recovery.journals]
    .filter(journalNeedsStartupRecovery)
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))[0];
  if (!journal) return null;
  const restored = restoreLaunchConfigFromJournal(journal);
  if (journal.walletPublicKey
      && state.managedWallets.some((wallet) => wallet.publicKey === journal.walletPublicKey)) {
    state.selectedWalletPublicKey = journal.walletPublicKey;
    state.accountId = journal.walletPublicKey;
  }
  const workspace = recoveryWorkspaceForJournal(journal);
  state.launchWorkspace = workspace;
  return {
    view: 'launch',
    workspace,
    journal,
    restored,
    kind: journalNeedsTokenFinish(journal) ? 'token' : 'journal',
  };
}

function canResumeJournal(journal) {
  if (!journal || state.demoActive || isTerminalJournal(journal)) return false;
  if (journalNeedsTokenFinish(journal)) return false;
  if (completedLpJournal(journal)) return false;
  if (!journalHasResumeMaterial(journal)) return false;
  return !journalResumePlan(journal).manualRecoveryRequired;
}

function canContinueJournalToFinish(journal) {
  return Boolean(
    journal
    && !isTerminalJournal(journal)
    && completedLpJournal(journal),
  );
}

function canDismissJournal(journal) {
  return Boolean(journal?.id) && !isTerminalJournal(journal);
}

function journalHasResumeMaterial(journal) {
  return Boolean(journal?.poolPlan || journal?.lp || journal?.token || journal?.stage);
}

function journalResultList(journal) {
  const lp = journal?.lp || {};
  if (Array.isArray(lp.results) && lp.results.length > 0) return lp.results;
  if (Array.isArray(lp.partialResults) && lp.partialResults.length > 0) return lp.partialResults;
  return [];
}

function journalAllocationForEvent(journal, event) {
  const allocations = journal?.poolPlan?.allocations;
  const index = Number(event?.allocationIndex);
  return Number.isInteger(index) && Array.isArray(allocations) ? allocations[index] : null;
}

function journalDistributionForEvent(journal, event) {
  const allocation = journalAllocationForEvent(journal, event);
  return Array.isArray(allocation?.distribution) && allocation.distribution.length > 0
    ? allocation.distribution
    : [{ sharePercent: 100, recipient: null }];
}

function journalResultHasOpenedPhase1Position(result) {
  return [
    ...(Array.isArray(result?.mainPositions) ? result.mainPositions : []),
    ...(Array.isArray(result?.ladderPositions) ? result.ladderPositions : []),
    ...(Array.isArray(result?.supportPositions) ? result.supportPositions : []),
  ].some((position) => position?.nftMint);
}

function journalIsResumeCheckpointResult(result) {
  return Boolean(result?.poolId)
    && (result.phase1Complete !== false || journalResultHasOpenedPhase1Position(result));
}

function mergeJournalResultCheckpoint(base, overlay) {
  if (!base) return overlay;
  const merged = { ...base, ...overlay };
  [
    ['mainPositions', 'sliceIndex'],
    ['ladderPositions', 'bandIndex'],
    ['supportPositions', 'supportIndex'],
  ].forEach(([key, indexKey]) => {
    const byIndex = new Map();
    [
      ...(Array.isArray(base?.[key]) ? base[key] : []),
      ...(Array.isArray(overlay?.[key]) ? overlay[key] : []),
    ].forEach((position, fallbackIndex) => {
      const index = Number(position?.[indexKey] ?? (indexKey === 'supportIndex' ? fallbackIndex : NaN));
      if (Number.isFinite(index)) byIndex.set(index, position);
    });
    merged[key] = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, position]) => position);
  });
  merged.txIds = { ...(base.txIds || {}), ...(overlay.txIds || {}) };
  merged.bootstrap = overlay.bootstrap || base.bootstrap || null;
  return merged;
}

function upsertJournalPlanResult(results, nextResult) {
  const index = results.findIndex((result) => result?.allocationIndex === nextResult?.allocationIndex);
  if (index >= 0) results[index] = mergeJournalResultCheckpoint(results[index], nextResult);
  else results.push(nextResult);
  results.sort((a, b) => Number(a.allocationIndex ?? 0) - Number(b.allocationIndex ?? 0));
}

function applyJournalEventToPlanResults(results, event, journal) {
  if (!event?.stage) return;
  const allocationIndex = Number(event.allocationIndex);
  let result = results.find((item) => Number(item?.allocationIndex) === allocationIndex);

  if (event.stage === 'phase1_pool_done' && event.result) {
    upsertJournalPlanResult(results, { ...event.result, phase1Complete: true });
    return;
  }

  if (event.stage === 'pool_create_done' && event.poolId && Number.isInteger(allocationIndex)) {
    const allocation = journalAllocationForEvent(journal, event) || {};
    upsertJournalPlanResult(results, {
      allocationIndex,
      quoteSymbol: allocation.quoteSymbolOverride || allocation.quoteSymbol || allocation.quoteToken || null,
      quoteAddress: allocation.quoteMint || allocation.quoteToken || null,
      supplyPercent: allocation.supplyPercent ?? null,
      poolId: event.poolId,
      mainPositions: [],
      ladderPositions: [],
      supportPositions: [],
      bootstrap: null,
      txIds: { createPool: event.txId || null },
      phase1Complete: false,
    });
    return;
  }

  if ((!result || !result.poolId) && event.poolId && Number.isInteger(allocationIndex)) {
    const allocation = journalAllocationForEvent(journal, event) || {};
    upsertJournalPlanResult(results, {
      allocationIndex,
      quoteSymbol: allocation.quoteSymbolOverride || allocation.quoteSymbol || allocation.quoteToken || null,
      quoteAddress: allocation.quoteMint || allocation.quoteToken || null,
      supplyPercent: allocation.supplyPercent ?? null,
      poolId: event.poolId,
      mainPositions: [],
      ladderPositions: [],
      supportPositions: [],
      bootstrap: null,
      txIds: { createPool: null },
      phase1Complete: false,
    });
    result = results.find((item) => Number(item?.allocationIndex) === allocationIndex);
  }
  if (!result || !result.poolId) return;

  if (event.stage === 'main_open_done') {
    const sliceIndex = Number(event.sliceIndex);
    if (!Number.isInteger(sliceIndex) || !event.nftMint) return;
    const slice = journalDistributionForEvent(journal, event)[sliceIndex] || {};
    upsertJournalPlanResult(results, {
      ...result,
      phase1Complete: false,
      mainPositions: [
        ...(Array.isArray(result.mainPositions) ? result.mainPositions : []).filter(
          (position) => Number(position?.sliceIndex) !== sliceIndex,
        ),
        {
          sliceIndex,
          sharePercent: Number.isFinite(Number(slice.sharePercent)) ? Number(slice.sharePercent) : null,
          tickLower: Number.isFinite(event.tickLower) ? event.tickLower : null,
          tickUpper: Number.isFinite(event.tickUpper) ? event.tickUpper : null,
          nftMint: event.nftMint,
          locked: false,
          recipient: slice.recipient || null,
          transferredTo: null,
          baseAmountRaw: event.baseAmountRaw || null,
          txIds: { open: event.txId || null, lock: null, transfer: null },
        },
      ],
    });
    return;
  }

  if (event.stage === 'ladder_open_done') {
    const bandIndex = Number(event.bandIndex);
    if (!Number.isInteger(bandIndex) || !event.nftMint) return;
    upsertJournalPlanResult(results, {
      ...result,
      phase1Complete: false,
      ladderPositions: [
        ...(Array.isArray(result.ladderPositions) ? result.ladderPositions : []).filter(
          (position) => Number(position?.bandIndex) !== bandIndex,
        ),
        {
          bandIndex,
          tickLower: Number.isFinite(event.tickLower) ? event.tickLower : null,
          tickUpper: Number.isFinite(event.tickUpper) ? event.tickUpper : null,
          nftMint: event.nftMint,
          locked: false,
          baseAmountRaw: event.baseAmountRaw || null,
          txIds: { open: event.txId || null, lock: null },
        },
      ],
    });
    return;
  }

  if (event.stage === 'support_open_done') {
    if (!event.nftMint) return;
    upsertJournalPlanResult(results, {
      ...result,
      phase1Complete: false,
      supportPositions: [{
        supportIndex: 0,
        tickLower: Number.isFinite(event.tickLower) ? event.tickLower : null,
        tickUpper: Number.isFinite(event.tickUpper) ? event.tickUpper : null,
        depthPct: Number.isFinite(Number(event.depthPct)) ? Number(event.depthPct) : null,
        quoteRaw: event.quoteAmountRaw || null,
        nftMint: event.nftMint,
        locked: false,
        txIds: { open: event.txId || null, lock: null },
      }],
    });
    return;
  }

  if (event.stage === 'bootstrap_open_done') {
    upsertJournalPlanResult(results, {
      ...result,
      bootstrap: {
        nftMint: event.nftMint || null,
        locked: false,
        tickLower: Number.isFinite(event.tickLower) ? event.tickLower : null,
        tickUpper: Number.isFinite(event.tickUpper) ? event.tickUpper : null,
        txIds: { open: event.txId || null, lock: null },
      },
    });
  }
}

function journalEventDerivedResults(journal) {
  const results = [];
  (Array.isArray(journal?.events) ? journal.events : []).forEach((event) => {
    applyJournalEventToPlanResults(results, event, journal);
  });
  return results.filter(journalIsResumeCheckpointResult);
}

function journalPriorResults(journal) {
  const byAllocation = new Map();
  journalResultList(journal).filter(journalIsResumeCheckpointResult).forEach((result) => {
    byAllocation.set(result.allocationIndex, result);
  });
  journalEventDerivedResults(journal).forEach((result) => {
    byAllocation.set(
      result.allocationIndex,
      mergeJournalResultCheckpoint(byAllocation.get(result.allocationIndex), result),
    );
  });
  return [...byAllocation.values()]
    .filter(journalIsResumeCheckpointResult)
    .sort((a, b) => Number(a.allocationIndex ?? 0) - Number(b.allocationIndex ?? 0));
}

function journalPoolCount(journal, priorResults = journalPriorResults(journal)) {
  const allocations = journal?.poolPlan?.allocations;
  if (Array.isArray(allocations) && allocations.length > 0) return allocations.length;
  const maxIndex = priorResults.reduce((max, result) => {
    const index = Number(result?.allocationIndex);
    return Number.isFinite(index) ? Math.max(max, index) : max;
  }, -1);
  return maxIndex >= 0 ? maxIndex + 1 : priorResults.length;
}

function journalUnsafePoolEvents(journal, priorResults = journalPriorResults(journal)) {
  const completed = new Set(priorResults.map((result) => result.allocationIndex));
  return Array.isArray(journal?.events)
    ? journal.events.filter(
      (event) => event?.stage === 'pool_create_done' && !completed.has(event.allocationIndex),
    )
    : [];
}

function completedLpJournal(journal) {
  return ['lp_created', 'transfer_started', 'transfer_partial', 'transfer_failed'].includes(journal?.stage)
    && Array.isArray(journal?.lp?.results)
    && journal.lp.results.length > 0
    && !journal.lp.failedPhase;
}

function failedPhaseLabel(phase) {
  const labels = {
    pre_flight: 'Preflight',
    main_positions: 'Pool positions',
    bootstrap: 'Bootstrap',
    locks: 'Burn & Earn locks',
    transfers: 'Fee Key transfers',
    resume: 'Resume',
  };
  return labels[phase] || humanizeStage(phase || 'checkpoint');
}

function journalFailureLabel(failure) {
  const pool = Number.isFinite(Number(failure?.allocationIndex))
    ? `Pool ${Number(failure.allocationIndex) + 1}`
    : 'Pool';
  const type = failure?.positionType ? humanizeStage(failure.positionType) : 'position';
  if (Number.isFinite(Number(failure?.sliceIndex))) {
    return `${pool} ${type} slice ${Number(failure.sliceIndex) + 1}`;
  }
  if (Number.isFinite(Number(failure?.bandIndex))) {
    return `${pool} ladder band ${Number(failure.bandIndex) + 1}`;
  }
  if (Number.isFinite(Number(failure?.supportIndex))) {
    return `${pool} support ${Number(failure.supportIndex) + 1}`;
  }
  return `${pool} ${type}`;
}

function pushUnique(list, item) {
  if (item && !list.includes(item)) list.push(item);
}

function journalResumePlan(journal) {
  const priorResults = journalPriorResults(journal);
  const poolCount = journalPoolCount(journal, priorResults);
  const unsafeEvents = journalUnsafePoolEvents(journal, priorResults);
  const failedPhase = journal?.lp?.failedPhase || journal?.errorDetails?.failedPhase || '';
  const failedAllocationIndex = Number(journal?.lp?.failedAllocationIndex ?? journal?.errorDetails?.failedAllocationIndex);
  const failedSliceIndex = Number(journal?.errorDetails?.sliceIndex);
  const missingPools = poolCount > 0 ? Math.max(0, poolCount - priorResults.length) : 0;
  const items = [];

  if (!journalHasResumeMaterial(journal)) {
    return {
      state: 'warn',
      badge: 'No plan',
      title: 'No resumable checkpoint',
      detail: 'This journal does not include enough token or pool state for automatic resume.',
      items: ['Use the wallet recovery controls for manual inspection.'],
      manualRecoveryRequired: true,
    };
  }

  if (journalNeedsTokenFinish(journal)) {
    const metadataRecorded = (journal.events || []).some((event) => event?.stage === 'metadata_account_created');
    return {
      state: 'warn',
      badge: 'Finish token',
      title: 'Finish interrupted token',
      detail: 'The mint already exists. Continue its missing supply and authority-safety steps before any liquidity recovery.',
      items: [
        'Trebuchet will reuse the recorded mint; it will not create a second token.',
        metadataRecorded ? 'Metadata is already recorded and will be skipped.' : 'Metadata will be checked before supply is minted.',
        'On-chain supply is checked before every retry to prevent duplicate minting.',
      ],
      tokenFinishRequired: true,
      manualRecoveryRequired: false,
    };
  }

  if (unsafeEvents.length > 0) {
    pushUnique(items, `${unsafeEvents.length} pool create checkpoint lacks a completed position result.`);
    pushUnique(items, 'Automatic resume is blocked to avoid duplicate pool work.');
    if (unsafeEvents[0]?.poolId) pushUnique(items, `Recorded pool: ${fullAddress(unsafeEvents[0].poolId)}`);
    return {
      state: 'danger',
      badge: 'Manual',
      title: 'Manual recovery required',
      detail: 'Trebuchet saw a pool get created before it recorded the matching LP positions.',
      items,
      manualRecoveryRequired: true,
    };
  }

  if (completedLpJournal(journal)) {
    pushUnique(items, `${priorResults.length} pool result${priorResults.length === 1 ? '' : 's'} already recorded.`);
    pushUnique(items, 'Resume skips pool creation and opens the final transfer/sweep path.');
    return {
      state: 'pass',
      badge: 'Recover',
      title: 'Continue to final transfer',
      detail: 'Liquidity is recorded. Recovery will restore the session for report, airdrop, and sweep.',
      items,
      manualRecoveryRequired: false,
    };
  }

  if (poolCount > 0) {
    pushUnique(items, `${priorResults.length}/${poolCount} pool result${poolCount === 1 ? '' : 's'} carried forward.`);
  }
  if (missingPools > 0) {
    pushUnique(items, `Next run skips recorded pools and attempts ${missingPools} missing pool${missingPools === 1 ? '' : 's'}.`);
  }
  if (Number.isFinite(failedAllocationIndex)) {
    const sliceText = Number.isFinite(failedSliceIndex) ? `, slice ${failedSliceIndex + 1}` : '';
    pushUnique(items, `Last failure: Pool ${failedAllocationIndex + 1}${sliceText}.`);
  }

  const bootstrapFailures = Array.isArray(journal?.lp?.bootstrapFailures) ? journal.lp.bootstrapFailures : [];
  const lockFailures = Array.isArray(journal?.lp?.lockFailures) ? journal.lp.lockFailures : [];
  const transferFailures = Array.isArray(journal?.lp?.transferFailures) ? journal.lp.transferFailures : [];
  if (bootstrapFailures.length) {
    pushUnique(items, `Retry ${bootstrapFailures.length} missing bootstrap${bootstrapFailures.length === 1 ? '' : 's'}.`);
  }
  if (lockFailures.length) {
    pushUnique(items, `Retry ${lockFailures.length} Burn & Earn lock${lockFailures.length === 1 ? '' : 's'}: ${lockFailures.slice(0, 2).map(journalFailureLabel).join(', ')}.`);
  }
  if (transferFailures.length) {
    pushUnique(items, `Fee Key transfer retry/sweep fallback for ${transferFailures.length} recipient${transferFailures.length === 1 ? '' : 's'}.`);
  }

  const recentEvent = Array.isArray(journal?.events)
    ? journal.events.slice().reverse().find((event) => event?.stage)
    : null;
  if (recentEvent) pushUnique(items, `Last checkpoint: ${progressEventLabel(recentEvent)}.`);
  if (!items.length) pushUnique(items, 'Resume uses the saved launch wallet and journaled pool plan.');

  if (failedPhase === 'pre_flight') {
    return {
      state: 'warn',
      badge: 'Retry',
      title: 'Fix preflight and retry',
      detail: 'No durable pool work should have been sent before this failure.',
      items,
      manualRecoveryRequired: false,
    };
  }

  return {
    state: failedPhase ? 'warn' : 'pass',
    badge: failedPhase ? 'Resume' : 'Ready',
    title: failedPhase ? `Resume ${failedPhaseLabel(failedPhase)}` : 'Resume saved launch',
    detail: failedPhase
      ? 'Trebuchet will reuse recorded pool state and retry only incomplete durable work.'
      : 'Trebuchet will rebuild the classic launch session from this journal.',
    items,
    manualRecoveryRequired: false,
  };
}
