function riskClass(value) {
  if (['High', 'Watch', 'Low confidence'].includes(value)) return 'danger';
  if (['Medium', 'Warn', 'Medium confidence'].includes(value)) return 'warn';
  return '';
}

function defaultSignatureRows() {
  return state.transactions.length
    ? state.transactions
    : baseTransactions.map((tx) => ({ ...tx, state: 'queued', source: 'draft' }));
}

function readinessPhaseState(id) {
  const phase = Array.isArray(state.executionReadiness?.phases)
    ? state.executionReadiness.phases.find((item) => item.id === id)
    : null;
  return String(phase?.state || '').toLowerCase();
}

function isReadinessPhaseComplete(id) {
  return ['complete', 'completed', 'done'].includes(readinessPhaseState(id));
}

function isReadinessPhaseBlocked(id) {
  return readinessPhaseState(id) === 'blocked';
}

function runStepState({ complete = false, running = false, blocked = false, ready = false } = {}) {
  if (complete) return 'signed';
  if (blocked) return 'blocked';
  if (running || ready) return 'pending';
  return 'queued';
}

function airdropCompletionStatus(proof = currentLaunchProof(), topology = currentClassicModel()) {
  const airdrop = proof?.airdrop || {};
  const proofRecipients = Array.isArray(airdrop.recipients) ? airdrop.recipients : [];
  const topologyRecipients = Array.isArray(topology?.airdrop?.recipients) ? topology.airdrop.recipients : [];
  const configured = Boolean(
    topology?.airdrop?.enabled
      || Number(airdrop.plannedRecipientCount || 0) > 0
      || proofRecipients.length > 0
      || topologyRecipients.length > 0,
  );
  if (!configured) {
    return { configured: false, planned: 0, delivered: 0, failed: 0, pending: 0, complete: true, retryRequired: false, missing: [] };
  }
  const planned = Math.max(0, Number(
    airdrop.plannedRecipientCount
      || topology?.airdrop?.recipientCount
      || proofRecipients.length
      || topologyRecipients.length
      || 0,
  ));
  const evidence = comparisonAirdropDeliveryEvidenceState({
    ...airdrop,
    recipients: proofRecipients.length ? proofRecipients : topologyRecipients,
    plannedRecipientCount: planned,
  });
  const pending = Math.max(0, evidence.planned - evidence.delivered - evidence.failed);
  return {
    configured: true,
    planned: evidence.planned,
    delivered: evidence.delivered,
    failed: evidence.failed,
    pending,
    complete: evidence.complete,
    retryRequired: evidence.failed > 0,
    missing: evidence.missing || [],
    transactionCount: evidence.transactionCount,
    deliveredRowCount: evidence.deliveredRowCount,
    recipientCount: evidence.recipientCount,
  };
}

function airdropCompletionIssue(status = {}, actionLabel = 'final sweep') {
  if (!status?.configured || status.complete) return null;
  if (status.retryRequired) {
    return `Airdrop has ${status.failed} failed recipient${status.failed === 1 ? '' : 's'}; retry before ${actionLabel}.`;
  }
  if (status.pending > 0) {
    return `${status.pending} airdrop recipient${status.pending === 1 ? '' : 's'} still pending; run airdrop before ${actionLabel}.`;
  }
  const missing = Array.isArray(status.missing) && status.missing.length
    ? status.missing.join(', ')
    : 'recipient and transaction evidence';
  return `Airdrop proof is incomplete (${missing}); refresh or rerun airdrop before ${actionLabel}.`;
}

function liveAirdropComplete(topology, proof) {
  const status = airdropCompletionStatus(proof, topology);
  return status.complete;
}

function liveRunProgressContext() {
  const config = currentLaunchConfig();
  const topology = config.poolTopology;
  const proof = currentLaunchProof();
  const proofConfig = proofConfigForFingerprint(proof, config);
  const proofTopology = proofConfig.poolTopology || topology;
  const readiness = state.executionReadiness;
  const quoteRoutes = quoteAcquireRoutes();
  const quoteStatus = quoteAcquireStatus(config);
  const quoteProgress = quoteStatus.progress;
  const quoteRunning = state.quoteAcquire.running || state.quoteAcquire.job?.status === 'running';
  const quoteFailed = Boolean(state.quoteAcquire.error || quoteProgress.failed);
  const quoteAcquireReady = quoteStatus.ready;
  const manualItems = quoteManualPrefundItems();
  const manualSummary = manualPrefundSummary(manualItems);
  const manualReady = !manualItems.length || manualSummary.className === '';
  const selectedWalletPublicKey = selectedLaunchWalletPublicKey();
  const selectedWallet = selectedManagedWallet();
  const walletSecretLocked = state.secretPin.locked || selectedWallet?.secretPinLocked === true;
  const walletSecretAvailable = state.demoActive || selectedWallet?.hasSecretKey === true;
  const walletSecretMissing = Boolean(selectedWalletPublicKey && (!selectedWallet || selectedWallet.decryptionFailed || !walletSecretAvailable));
  const walletReady = Boolean(selectedWalletPublicKey && selectedWallet && walletSecretAvailable && !walletSecretLocked && !selectedWallet.decryptionFailed);
  const funding = fundingMeterSnapshot(config);
  const fundingBalanceKnown = state.demoActive || (state.apiStatus === 'connected' && funding.hasWalletBalance === true && funding.walletBalanceFresh === true);
  const fundingSolReady = Number(funding.missingSol || 0) <= 0.001;
  const fundingEstimateStatus = classicFundingEstimateStatus(config);
  const fundingReady = fundingEstimateStatus.matchesConfig
    && !quoteRunning
    && !quoteFailed
    && quoteAcquireReady
    && manualReady
    && fundingSolReady
    && fundingBalanceKnown;
  const fundingBlocked = Boolean(
    quoteFailed
    || isReadinessPhaseBlocked('funding')
    || (fundingEstimateStatus.hasEstimate && (!fundingEstimateStatus.matchesConfig || !fundingBalanceKnown || !fundingSolReady || !quoteAcquireReady || !manualReady))
  );
  const tokenMint = String(proof?.token?.mint || '').trim();
  const completedDemoRun = demoRunHasCompletedReadiness();
  const tokenAuthorityFields = ['mintAuthorityRenounced', 'freezeAuthorityDisabled', 'metadataUpdateAuthorityRevoked', 'metadataImmutable'];
  const tokenAuthorityPassCount = tokenAuthorityFields.filter((field) => proof?.token?.[field] === true).length;
  const tokenAuthorityComplete = tokenAuthorityPassCount === tokenAuthorityFields.length;
  const tokenPhaseComplete = isReadinessPhaseComplete('token');
  const tokenComplete = Boolean(completedDemoRun || (tokenMint && tokenAuthorityComplete));
  const tokenNeedsAuthorityProof = Boolean((tokenMint || tokenPhaseComplete) && !tokenComplete);
  const tokenRunning = state.realExecutionRunning
    && ['/api/create-token', '/api/finish-token-creation'].includes(state.executionReadiness?.nextEndpoint);
  const proofResults = Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results : [];
  const plannedPools = buildV2ReportPoolPlan(proofConfig, proofResults, proof);
  const poolTarget = Math.max(1, plannedPools.length || proofTopology.pools?.length || topology.pools.length);
  const plannedPositionCount = plannedPools.reduce((sum, pool) => sum + Number(pool.plannedPositionCount || 0), 0);
  const liquidityEvidence = comparisonLiquidityEvidenceState(proof, {
    plannedPoolCount: poolTarget,
    plannedPositionCount,
  });
  const recordedPositionCount = liquidityEvidence.positionCount;
  const lockedPositionCount = liquidityEvidence.lockedPositionCount;
  const feeKeyCount = liquidityEvidence.feeKeyCount;
  const liquidityTxEvidence = v2LiquidityTransactionEvidenceCounts(proofResults);
  const poolCreateTxCount = liquidityTxEvidence.poolCreateTxCount;
  const openTxCount = liquidityTxEvidence.openTxCount;
  const lockTxCount = liquidityTxEvidence.lockTxCount;
  const feeKeyRecipientTarget = liquidityTxEvidence.feeKeyRecipientRows.length;
  const feeKeyRecipientTransferred = liquidityTxEvidence.feeKeyRecipientTransferred;
  const feeKeyRecipientsDelivered = feeKeyRecipientTarget <= 0 || feeKeyRecipientTransferred >= feeKeyRecipientTarget;
  const recordedPoolIds = launchProofPoolIds(proof);
  const recordedPoolIdCount = recordedPoolIds.length;
  const reportedPoolCount = Number(liquidityEvidence.poolCount || 0);
  const liquidityRunning = /liquidity|resume/i.test(state.fullRunStep || '')
    || (state.realExecutionRunning && ['/api/create-lp', '/api/resume-launch'].includes(state.executionReadiness?.nextEndpoint))
    || String(state.liveOps.lp?.status || '').toLowerCase() === 'running'
    || state.liveOps.lpEvents.length > 0;
  const liquidityPhaseComplete = isReadinessPhaseComplete('liquidity') || proof?.liquidity?.complete === true;
  const poolsRecorded = recordedPoolIdCount === poolTarget
    && reportedPoolCount === recordedPoolIdCount
    && poolCreateTxCount >= poolTarget
    && !liquidityEvidence.missing.includes('pool count');
  const positionsRecorded = plannedPositionCount > 0
    ? recordedPositionCount >= plannedPositionCount
      && openTxCount >= recordedPositionCount
      && !liquidityEvidence.missing.some((item) => ['position count', 'position records'].includes(item))
    : recordedPositionCount > 0
      && openTxCount >= recordedPositionCount
      && !liquidityEvidence.missing.some((item) => ['position count', 'position records'].includes(item));
  const liquidityComplete = Boolean(completedDemoRun || (poolsRecorded && positionsRecorded));
  const liquidityNeedsPositionProof = Boolean((liquidityPhaseComplete || poolsRecorded) && !liquidityComplete);
  const lockEventCount = state.liveOps.lpEvents.filter((event) => /_lock_done$|fee_key_transfer_done/.test(String(event.stage || ''))).length;
  const locksRecorded = recordedPositionCount > 0
    && lockedPositionCount >= recordedPositionCount
    && lockTxCount >= recordedPositionCount
    && !liquidityEvidence.missing.includes('lock count');
  const feeKeysRecorded = locksRecorded
    && feeKeyCount >= lockedPositionCount
    && !liquidityEvidence.missing.includes('fee key count');
  const lockComplete = Boolean(
    completedDemoRun
    || (locksRecorded && feeKeysRecorded && feeKeyRecipientsDelivered)
  );
  const lockNeedsProof = Boolean((liquidityComplete || liquidityPhaseComplete) && recordedPositionCount > 0 && !lockComplete);
  const airdropRunning = Boolean(state.airdropRunning)
    || /airdrop/i.test(state.fullRunStep || '')
    || ['running', 'active'].includes(String(state.liveOps.airdrop?.status || '').toLowerCase());
  const airdropStatus = airdropCompletionStatus(proof, proofTopology);
  const airdropIssue = airdropCompletionIssue(airdropStatus);
  const airdropComplete = liveAirdropComplete(proofTopology, proof);
  const report = currentReportPublish(proof, proofConfig, { allowTransient: true });
  const reportUri = report?.htmlUri || report?.jsonUri || null;
  const localDossier = currentLocalDossier(proof, proofConfig);
  const reportLocalOnly = state.prefs.publishLaunchReport === false;
  const reportPublishEvidence = proofHasReportPublishEvidence(proof, proofConfig);
  const reportReady = Boolean(
    airdropStatus.complete
    && ((proof?.canPublishReport && reportPublishEvidence) || (reportLocalOnly && reportPublishEvidence))
  );
  const terminalSweepComplete = Boolean(completedDemoRun || transferHasWalletEmptyFinalSweepEvidence(proof?.transfer));
  const reportArtifactRecord = report || localDossier || null;
  const reportArtifactSweepBound = Boolean(
    completedDemoRun
    || (terminalSweepComplete && reportArtifactRecord && reportArtifactMatchesTerminalSweep(reportArtifactRecord, proof))
  );
  const reportNeedsFinalArtifact = Boolean(
    terminalSweepComplete
    && (reportUri || localDossier)
    && !reportArtifactSweepBound
  );
  const reportDone = Boolean(reportUri || localDossier) && !reportNeedsFinalArtifact;
  const sweepReadinessComplete = isReadinessPhaseComplete('sweep');
  const sweepNeedsProof = sweepReadinessComplete && !terminalSweepComplete;
  const sweepRunning = /sweep/i.test(state.fullRunStep || '')
    || (state.realExecutionRunning && state.executionReadiness?.nextEndpoint === '/api/transfer-assets');
  const hasLiveEvidence = Boolean(
    readiness
    || proof
    || state.fullRunRunning
    || state.realExecutionRunning
    || state.demoLaunchRunning
    || state.reportPublishing
    || state.airdropRunning
    || state.lastFullRun
    || state.lastRealExecution
    || state.lastDemoLaunchRun
    || state.quoteAcquire.job
    || state.classicFundingEstimate
    || state.liveOps.lpEvents.length
    || state.liveOps.airdrop
  );

  const rows = [
    {
      id: 'live-wallet',
      label: 'Wallet and CA',
      state: runStepState({ complete: walletReady, blocked: isReadinessPhaseBlocked('wallet') || walletSecretLocked || walletSecretMissing }),
      stage: 'config',
      effects: [walletReady
        ? 'Launch wallet is ready.'
        : !selectedWalletPublicKey
          ? 'Generate or import a launch wallet.'
          : !selectedWallet
            ? 'This address is not one of your saved launch wallets.'
            : walletSecretLocked
              ? 'Unlock the Recovery PIN before Trebuchet can sign launch calls.'
              : walletSecretMissing
                ? 'Launch wallet exists, but its signing secret is unavailable.'
                : 'Generate or import a launch wallet.'],
    },
    {
      id: 'live-funding',
      label: 'Funding and quote acquire',
      state: runStepState({ complete: fundingReady, running: quoteRunning, blocked: fundingBlocked, ready: fundingEstimateStatus.hasEstimate }),
      stage: 'fund',
      effects: [quoteRunning
        ? `${quoteProgress.completed}/${quoteProgress.total} quote routes acquired.`
        : fundingReady
          ? 'Funding estimate, wallet SOL, and quote-token requirements are ready.'
          : !fundingEstimateStatus.hasEstimate
            ? 'Run estimate, acquire routes, or satisfy manual prefund.'
            : fundingEstimateStatus.stale
              ? 'Funding estimate is stale for the current token, pools, market cap, or airdrop model.'
            : !fundingBalanceKnown
              ? funding.walletBalanceStale
                ? 'Selected launch-wallet balance is stale; wait for the desktop app refresh or click Check balance.'
                : 'Selected launch-wallet balance has not been verified yet.'
              : !fundingSolReady
                ? `Launch wallet is short ${funding.missingSol.toFixed(3)} SOL.`
                : quoteStatus.stale
                  ? 'Quote acquire is stale for the selected wallet or launch model; run it again.'
                : !quoteAcquireReady
                  ? `${quoteRoutes.length} quote acquire route${quoteRoutes.length === 1 ? '' : 's'} still need successful completion.`
                  : !manualReady
                    ? `Manual quote prefund is ${manualSummary.label}.`
                    : 'Run estimate, acquire routes, or satisfy manual prefund.'],
    },
    {
      id: 'live-token',
      label: 'Create token',
      state: runStepState({
        complete: tokenComplete,
        running: tokenRunning,
        blocked: isReadinessPhaseBlocked('token') || (tokenNeedsAuthorityProof && !tokenRunning),
        ready: ['/api/create-token', '/api/finish-token-creation'].includes(state.executionReadiness?.nextEndpoint),
      }),
      stage: 'mint',
      effects: [tokenComplete
        ? `Mint ${shortAddress(tokenMint || state.lastDemoLaunchRun?.token?.tokenMint || state.executionReadiness?.tokenMint)} and authority posture are recorded.`
        : tokenNeedsAuthorityProof
          ? tokenMint
            ? `Mint ${shortAddress(tokenMint)} recorded; authority proof is ${tokenAuthorityPassCount}/${tokenAuthorityFields.length}.`
            : 'Token phase is past; mint and authority proof are still missing.'
          : 'Create mint, metadata, and revoke authorities.'],
    },
    {
      id: 'live-liquidity',
      label: 'Pools and positions',
      state: runStepState({
        complete: liquidityComplete,
        running: liquidityRunning,
        blocked: isReadinessPhaseBlocked('liquidity') || (liquidityNeedsPositionProof && !liquidityRunning),
        ready: ['/api/create-lp', '/api/resume-launch'].includes(state.executionReadiness?.nextEndpoint),
      }),
      stage: 'liquidity',
      effects: [liquidityComplete
        ? `${recordedPositionCount}/${plannedPositionCount || recordedPositionCount} planned positions recorded with ${openTxCount} open tx${openTxCount === 1 ? '' : 's'} across ${recordedPoolIdCount}/${poolTarget} pool IDs.`
        : liquidityNeedsPositionProof
          ? `${recordedPoolIdCount}/${poolTarget} pool IDs recorded; pool-create tx proof is ${poolCreateTxCount}/${poolTarget}, position-open tx proof is ${openTxCount}/${recordedPositionCount || plannedPositionCount || '?'}.`
          : liquidityRunning ? `${state.liveOps.lpEvents.length} LP checkpoint${state.liveOps.lpEvents.length === 1 ? '' : 's'} seen.` : 'Open pools, main slices, ladders, support, and bootstrap positions.'],
    },
    {
      id: 'live-locks',
      label: 'Locks and Fee Keys',
      state: runStepState({
        complete: lockComplete,
        running: lockEventCount > 0 && !lockComplete,
        blocked: lockNeedsProof && !liquidityRunning,
        ready: liquidityRunning || liquidityComplete,
      }),
      stage: 'liquidity',
      effects: [lockComplete
        ? `${lockedPositionCount}/${recordedPositionCount} positions locked with ${lockTxCount} lock tx${lockTxCount === 1 ? '' : 's'}; ${feeKeyCount} Fee Key NFT${feeKeyCount === 1 ? '' : 's'} recorded${feeKeyRecipientTarget > 0 ? `; ${feeKeyRecipientTransferred}/${feeKeyRecipientTarget} recipient transfer${feeKeyRecipientTarget === 1 ? '' : 's'} delivered.` : '.'}`
        : lockNeedsProof
          ? locksRecorded && feeKeysRecorded && !feeKeyRecipientsDelivered
            ? `${feeKeyRecipientTransferred}/${feeKeyRecipientTarget} Fee Key recipient transfer${feeKeyRecipientTarget === 1 ? '' : 's'} recorded; retry or forward from return wallet before completion.`
            : locksRecorded
              ? `${feeKeyCount}/${lockedPositionCount} Fee Key NFT${lockedPositionCount === 1 ? '' : 's'} recorded; waiting for remaining transfer proof.`
            : `${lockedPositionCount}/${recordedPositionCount} positions are locked; lock tx proof is ${lockTxCount}/${recordedPositionCount}.`
          : `${lockEventCount} lock or Fee Key checkpoint${lockEventCount === 1 ? '' : 's'} seen.`],
    },
    {
      id: 'live-airdrop',
      label: 'Airdrop recipients',
      state: runStepState({
        complete: airdropComplete,
        running: airdropRunning,
        blocked: airdropStatus.retryRequired,
        ready: topology.airdrop.enabled,
      }),
      stage: 'sweep',
      effects: [airdropIssue
        || (airdropComplete && airdropStatus.configured
          ? `${airdropStatus.delivered}/${airdropStatus.planned} airdrop recipient${airdropStatus.planned === 1 ? '' : 's'} delivered with transaction proof.`
          : topology.airdrop.enabled ? `${topology.airdrop.recipientCount} recipient${topology.airdrop.recipientCount === 1 ? '' : 's'} planned.` : 'No airdrop configured for this launch.')],
    },
    {
      id: 'live-report',
      label: 'Publish launch record',
      state: runStepState({
        complete: reportDone,
        running: state.reportPublishing || /report/i.test(state.fullRunStep || ''),
        blocked: reportNeedsFinalArtifact,
        ready: reportReady || reportNeedsFinalArtifact,
      }),
      stage: 'sweep',
      effects: [reportNeedsFinalArtifact
        ? 'Terminal sweep is recorded; download a fresh launch record so the artifact carries the final sweep hash.'
        : reportDone
        ? reportUri
          ? 'Permanent launch record proof is attached.'
          : 'Local launch record proof is attached.'
        : reportLocalOnly && reportReady
          ? 'Report publishing is off; download the local HTML/JSON launch record before review.'
          : reportReady ? 'Proof is ready for report publishing.' : 'Wait for token and liquidity proof.'],
    },
    {
      id: 'live-sweep',
      label: 'Sweep assets',
      state: runStepState({
        complete: terminalSweepComplete,
        running: sweepRunning,
        blocked: isReadinessPhaseBlocked('sweep') || sweepNeedsProof,
        ready: state.executionReadiness?.nextEndpoint === '/api/transfer-assets',
      }),
      stage: 'sweep',
      effects: [terminalSweepComplete
        ? 'Final transfer/sweep is recorded.'
        : sweepNeedsProof
          ? 'Readiness says sweep is past; wallet-empty, error-free final-sweep proof is still missing.'
          : 'Sweep remaining assets to the return wallet.'],
    },
  ];

  const activeRow = rows.find((row) => ['pending', 'blocked'].includes(row.state)) || rows.find((row) => row.state !== 'signed') || rows[rows.length - 1];
  const source = state.fullRunRunning
    ? state.fullRunStep || 'Full launch running'
    : state.realExecutionRunning
      ? 'execute-next running'
      : state.demoLaunchRunning
        ? 'demo launch running'
        : state.quoteAcquire.running
          ? 'quote acquire running'
          : readiness
            ? 'execution readiness'
            : proof
              ? proof.source || 'launch record'
              : 'launch progress';

  return {
    active: hasLiveEvidence,
    rows,
    activeId: activeRow?.id || null,
    source,
    focusLabel: state.fullRunRunning || state.realExecutionRunning || state.demoLaunchRunning ? 'Current operation' : 'Next checkpoint',
    headingLabel: 'Live launch progress',
  };
}

function signatureRows() {
  const live = liveRunProgressContext();
  if (!state.transactions.length && live.active) return live.rows;
  return defaultSignatureRows();
}

function signatureStats() {
  const rows = signatureRows();
  const total = rows.length || 8;
  const signed = rows.filter((tx) => tx.state === 'signed').length;
  const pending = rows.filter((tx) => tx.state !== 'signed').length;
  const percent = total > 0 ? Math.round((signed / total) * 100) : 0;
  return { rows, total, signed, pending, percent };
}

function runProgressContext() {
  const live = liveRunProgressContext();
  const useLive = !state.transactions.length && live.active;
  const rows = useLive ? live.rows : defaultSignatureRows();
  const total = rows.length || 8;
  const signed = rows.filter((tx) => tx.state === 'signed').length;
  const pending = rows.filter((tx) => tx.state !== 'signed').length;
  const percent = total > 0 ? Math.round((signed / total) * 100) : 0;
  const activeId = state.activeApprovalId
    || (useLive ? live.activeId : null)
    || rows.find((tx) => tx.state !== 'signed')?.id
    || rows[0]?.id
    || null;
  return {
    rows,
    total,
    signed,
    pending,
    percent,
    activeId,
    isLive: useLive,
    source: useLive
      ? live.source
      : state.transactions.length
        ? state.launchPlan?.source === 'local-api' ? 'local API' : 'static preview'
        : 'not staged',
    focusLabel: useLive ? live.focusLabel : state.transactions.length ? 'Next operation' : 'First operation',
    headingLabel: useLive ? live.headingLabel : 'Local wallet run',
  };
}
