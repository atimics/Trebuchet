async function checkExecutionReadiness({ retried = false } = {}) {
  await autoVerifyQuoteTokens();
  const config = currentLaunchConfig();
  const walletPublicKey = state.selectedWalletPublicKey || state.managedWallets[0]?.publicKey || '';
  state.executionChecking = true;
  renderClassicBridge();

  try {
    if (state.apiStatus === 'connected' && state.apiClient?.checkExecutionReadiness) {
      state.executionReadiness = await state.apiClient.checkExecutionReadiness({
        walletPublicKey,
        config,
        fundingEstimate: currentClassicFundingEstimateForConfig(config),
        airdropRecipients: config.poolTopology.airdrop.recipients,
      });
      rememberLaunchProof(state.executionReadiness);
      const blockers = state.executionReadiness.blockers || [];
      // The server binds the estimate to more of the plan than the screen does. A stale estimate is
      // fixed by estimating again, which is read-only: do it and check once more, before the token exists.
      if (!retried && blockers.some((item) => item.id === 'funding-estimate-stale') && !launchTokenExists()) {
        state.executionChecking = false;
        notify('The plan changed since the estimate: estimating again');
        if (state.classicFundingEstimate) state.classicFundingEstimate = { ...state.classicFundingEstimate, v2FundingFingerprint: null };
        await estimateClassicFunding();
        return checkExecutionReadiness({ retried: true });
      }
      renderAll();
      notify(blockers.length
        ? `Can't launch yet: ${blockers[0].title || 'see the list'}${blockers.length > 1 ? ` (+${blockers.length - 1} more, listed on the right)` : ''}`
        : 'Launch ready');
      return;
    }

    state.executionReadiness = {
      contractVersion: 1,
      status: 'blocked',
      nextEndpoint: null,
      nextAction: 'Open local app',
      walletPublicKey: walletPublicKey || null,
      blockers: [{
        id: 'local-api-unavailable',
        phase: 'wallet',
        title: 'Local API unavailable',
        detail: 'Execution readiness requires the authenticated Trebuchet local API.',
        severity: 'blocker',
      }],
      warnings: [],
      phases: [
        { id: 'token', title: 'Create token', endpoint: '/api/create-token', state: 'waiting' },
        { id: 'liquidity', title: 'Create pools', endpoint: '/api/create-lp', state: 'waiting' },
        { id: 'recover', title: 'Resume launch', endpoint: '/api/resume-launch', state: 'waiting' },
        { id: 'sweep', title: 'Sweep assets', endpoint: '/api/transfer-assets', state: 'waiting' },
      ],
    };
    renderAll();
    notify('Local API required for execution readiness');
  } catch (error) {
    notify(error.message || 'Execution readiness check failed');
  } finally {
    state.executionChecking = false;
    renderAll();
  }
}

function applyExecutionErrorReadiness(error) {
  if (/^RUN_ENVELOPE_/.test(String(error?.code || ''))) {
    state.lastRunEnvelope = null;
  }
  const readiness = error?.readiness || error?.response?.readiness;
  if (!readiness || typeof readiness !== 'object') return false;
  state.executionReadiness = readiness;
  rememberLaunchProof(readiness);
  return true;
}

async function runDemoLaunch() {
  if (!state.demoActive) {
    notify('Switch to test mode for a test launch');
    return;
  }
  const config = currentLaunchConfig();
  const walletPublicKey = state.selectedWalletPublicKey || state.managedWallets[0]?.publicKey || '';
  if (!walletPublicKey) {
    notify('Generate a launch wallet first');
    return;
  }
  if (state.apiStatus !== 'connected' || !state.apiClient?.runDemoLaunch) {
    notify('Test launch requires the Trebuchet desktop app');
    return;
  }

  state.demoLaunchRunning = true;
  renderAll();
  try {
    state.lastDemoLaunchRun = await state.apiClient.runDemoLaunch({
      walletPublicKey,
      config,
      fundingEstimate: currentClassicFundingEstimateForConfig(config),
      airdropRecipients: config.poolTopology.airdrop.recipients,
    });
    state.executionReadiness = state.lastDemoLaunchRun.readiness || state.executionReadiness;
    applyLaunchPlan(
      state.executionReadiness?.plan || state.launchPlan || fallbackLaunchPlan(),
      config,
      { openApproval: true },
    );
    state.transactions.forEach((tx) => {
      tx.state = 'signed';
    });
    state.launchStage = launchStages.length - 1;
    state.approvalOpen = false;
    history.unshift({
      title: `${state.lastDemoLaunchRun.token?.symbol || config.token.symbol} demo launch completed`,
      detail: `${fullAddress(state.lastDemoLaunchRun.token?.tokenMint)} minted, ${state.lastDemoLaunchRun.liquidity?.results?.length || 0} pool${state.lastDemoLaunchRun.liquidity?.results?.length === 1 ? '' : 's'}, sweep simulated.`,
      time: 'Just now',
    });
    pollLiveOps().catch(() => null);
    setLaunchWorkspace('finish');
    notify('Test launch complete: no SOL was spent');
  } catch (error) {
    notify(error.message || 'Test launch failed; no SOL was spent');
  } finally {
    state.demoLaunchRunning = false;
    renderAll();
  }
}

async function executeNextRunOperation() {
  const config = currentLaunchConfig();
  const walletPublicKey = state.selectedWalletPublicKey || state.managedWallets[0]?.publicKey || '';
  if (!walletPublicKey) {
    notify('Generate or select a launch wallet first');
    return;
  }
  if (state.demoActive) {
    notify('Switch to live mode to launch for real');
    return;
  }
  if (state.apiStatus !== 'connected' || !state.apiClient?.executeNextRunOperation) {
    notify('Real execution requires the Trebuchet desktop app');
    return;
  }
  const runEnvelopeId = state.lastRunEnvelope?.status === 'armed'
    ? String(state.lastRunEnvelope.id || '')
    : '';
  if (!runEnvelopeId) {
    notify('Review and arm the local run before executing');
    return;
  }
  if (!state.executionReadiness || state.executionReadiness.status !== 'ready') {
    await checkExecutionReadiness();
  }
  const readiness = state.executionReadiness;
  if (!readiness?.nextEndpoint) {
    notify('No classic endpoint is ready');
    return;
  }
  if (Array.isArray(readiness.blockers) && readiness.blockers.length > 0) {
    notify(`${readiness.blockers.length} execution blocker${readiness.blockers.length === 1 ? '' : 's'}`);
    return;
  }
  const finalizationIssue = executeNextTransferFinalizationIssue(readiness, config);
  if (finalizationIssue) {
    notify(finalizationIssue);
    return;
  }

  {
    const ok = await confirmOperatorAction({
      title: readiness.nextAction || 'Execute next launch operation',
      detail: `Trebuchet will run ${readiness.nextEndpoint} with ${fullAddress(walletPublicKey)}. This can send a real transaction through the configured RPC.`,
      confirmLabel: 'Execute operation',
      danger: true,
      confirmationText: 'EXECUTE',
    });
    if (!ok) return;
  }

  state.realExecutionRunning = true;
  renderLaunchRunningBar();
  const ledgerId = startExecutionLedgerEntry({
    kind: 'endpoint',
    endpoint: readiness.nextEndpoint,
    label: readiness.nextAction || fullRunEndpointLabel(readiness.nextEndpoint),
    detail: `Confirmed ${readiness.nextEndpoint} for ${fullAddress(walletPublicKey)}.`,
  });
  renderAll();
  try {
    const dossierProof = currentLaunchProof();
    const dossierConfig = proofConfigForFingerprint(dossierProof, config);
    const result = await state.apiClient.executeNextRunOperation({
      walletPublicKey,
      config,
      fundingEstimate: currentClassicFundingEstimateForConfig(config),
      airdropRecipients: config.poolTopology.airdrop.recipients,
      confirmNextEndpoint: readiness.nextEndpoint,
      localDossier: currentLocalDossier(dossierProof, dossierConfig),
      runEnvelopeId,
    });
    if (result.envelope) state.lastRunEnvelope = result.envelope;
    state.lastRealExecution = result.executed;
    state.executionReadiness = result.readiness || state.executionReadiness;
    rememberLaunchProof(result.proof || result.readiness?.proof);
    if (result.executed?.endpoint === '/api/create-token' && result.executed.result?.tokenMint) {
      history.unshift({
        title: `${config.token.symbol} token created`,
        detail: `${fullAddress(result.executed.result.tokenMint)} minted by the launch wallet.`,
        time: 'Just now',
      });
    } else if (result.executed?.endpoint === '/api/finish-token-creation' && result.executed.result?.mint) {
      history.unshift({
        title: `${config.token.symbol} token recovered`,
        detail: `${fullAddress(result.executed.result.mint)} finished without creating another mint.`,
        time: 'Just now',
      });
    } else if (Array.isArray(result.executed?.result?.results)) {
      history.unshift({
        title: `${config.token.symbol} liquidity executed`,
        detail: `${result.executed.result.results.length} pool${result.executed.result.results.length === 1 ? '' : 's'} recorded by the launch runner.`,
        time: 'Just now',
      });
    } else {
      history.unshift({
        title: `${config.token.symbol} ${result.executed?.action || 'execution'} complete`,
        detail: `${result.executed?.endpoint || 'Launch operation'} finished through the guarded Trebuchet runner.`,
        time: 'Just now',
      });
    }
    finishExecutionLedgerEntry(ledgerId, {
      status: 'complete',
      detail: `${result.executed?.action || fullRunEndpointLabel(result.executed?.endpoint)} completed.`,
      ...ledgerObservationFromExecution(result.executed),
    });
    await refreshLocalApiState();
    pollLiveOps().catch(() => null);
    notify(`${result.executed?.action || 'Launch operation'} complete`);
  } catch (error) {
    applyExecutionErrorReadiness(error);
    finishExecutionLedgerEntry(ledgerId, {
      status: 'error',
      error: error.message || 'Execution failed',
      detail: error.message || 'Execution failed.',
    });
    notify(error.message || 'Execution failed');
  } finally {
    state.realExecutionRunning = false;
    renderLaunchRunningBar();
    renderAll();
  }
}

function executeNextTransferFinalizationIssue(readiness, config = currentLaunchConfig()) {
  if (readiness?.nextEndpoint !== '/api/transfer-assets') return null;
  const proof = currentLaunchProof();
  const safeConfig = proofConfigForFingerprint(proof, config);
  const airdropStatus = airdropCompletionStatus(proof, safeConfig.poolTopology);
  const airdropIssue = airdropCompletionIssue(airdropStatus);
  if (airdropIssue) return airdropIssue;
  if (!proof) return 'The launch record is not loaded.';

  const staleReport = staleReportPublishForProof(proof, safeConfig);
  if (staleReport) return 'Launch report is stale for this proof; republish before final sweep.';

  const report = currentReportPublish(proof, safeConfig);
  const localDossier = currentLocalDossier(proof, safeConfig);
  const staleLocalDossier = !localDossier
    ? [proof?.localDossier, state.lastLocalDossier].find((dossier) => dossier && typeof dossier === 'object')
    : null;
  const staleLocalDossierIssue = staleLocalDossier
    ? localDossierFinalizationIssue(staleLocalDossier, proof, safeConfig)
    : null;
  if (!report?.jsonUri && !report?.htmlUri && staleLocalDossierIssue && staleLocalDossierIssue !== 'missing') {
    return `Saved launch record proof is stale or incomplete (${staleLocalDossierIssue}); download a fresh launch record before final sweep.`;
  }
  if (!report?.jsonUri && !report?.htmlUri && !localDossier) {
    return state.prefs.publishLaunchReport === false
      ? 'Report publishing is off; download the saved launch record before final sweep.'
      : 'Publish or download the launch report before final sweep.';
  }
  return null;
}

function fullRunCompletionAudit(proof = currentLaunchProof(), config = currentLaunchConfig()) {
  const blockers = [];
  const safeConfig = proofConfigForFingerprint(proof, config && typeof config === 'object' ? config : { poolTopology: {} });
  const topology = safeConfig.poolTopology || {};
  const token = proof?.token || {};
  const tokenAuthorityFields = ['mintAuthorityRenounced', 'freezeAuthorityDisabled', 'metadataUpdateAuthorityRevoked', 'metadataImmutable'];
  const tokenAuthorityPassCount = tokenAuthorityFields.filter((field) => token[field] === true).length;
  const results = Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results : [];
  const plannedPools = buildV2ReportPoolPlan(safeConfig, results, proof);
  const plannedPoolCount = Math.max(1, plannedPools.length || topology?.pools?.length || 0);
  const recordedPoolIds = [
    ...(Array.isArray(proof?.liquidity?.poolIds) ? proof.liquidity.poolIds : []),
    ...results.map((pool) => pool?.poolId).filter(Boolean),
  ].filter((value, index, list) => value && list.indexOf(value) === index);
  const proofPoolCount = Number(proof?.liquidity?.poolCount || 0);
  const recordedPoolCount = recordedPoolIds.length;
  const plannedPositionCount = plannedPools.reduce((sum, pool) => sum + Number(pool.plannedPositionCount || 0), 0);
  const liquidityEvidence = comparisonLiquidityEvidenceState(proof, {
    plannedPoolCount,
    plannedPositionCount,
  });
  const recordedPositionCount = liquidityEvidence.positionCount;
  const lockedPositionCount = liquidityEvidence.lockedPositionCount;
  const feeKeyCount = liquidityEvidence.feeKeyCount;
  const txEvidence = v2LiquidityTransactionEvidenceCounts(results);
  const poolCreateTxCount = txEvidence.poolCreateTxCount;
  const openTxCount = txEvidence.openTxCount;
  const lockTxCount = txEvidence.lockTxCount;
  const feeKeyRecipientTarget = txEvidence.feeKeyRecipientRows.length;
  const feeKeyRecipientTransferred = txEvidence.feeKeyRecipientTransferred;
  const airdropStatus = airdropCompletionStatus(proof, topology);
  const report = currentReportPublish(proof, safeConfig);
  const reportUri = report?.htmlUri || report?.jsonUri || null;
  const localDossier = currentLocalDossier(proof, safeConfig);
  const reportArtifactRecord = report || localDossier || null;
  const reportLocalOnly = state.prefs.publishLaunchReport === false;
  const staleReport = staleReportPublishForProof(proof, safeConfig);
  const finalSweepComplete = transferHasWalletEmptyFinalSweepEvidence(proof?.transfer);
  const reportArtifactSweepBound = Boolean(
    finalSweepComplete
    && reportArtifactRecord
    && reportArtifactMatchesTerminalSweep(reportArtifactRecord, proof)
  );
  const proofLaunchConfigSnapshot = proofLaunchConfigSnapshotState(proof);
  const localJournalEvidenceState = proofJournalEvidenceState(proof);
  const matchingLocalJournal = localJournalEvidenceState.journal;
  const terminalJournalComplete = proofHasTerminalLaunchJournal(proof);

  if (!proof || typeof proof !== 'object') {
    blockers.push('Launch record is missing after the full run.');
  }
  if (proofLaunchConfigSnapshot.state === 'missing') {
    blockers.push('Frozen launch-config snapshot proof is missing.');
  } else if (proofLaunchConfigSnapshot.state === 'mismatch') {
    blockers.push(`Frozen launch-config snapshot does not match launch evidence (${proofLaunchConfigSnapshot.mismatches.join(', ')}).`);
  } else if (!proofLaunchConfigSnapshot.complete) {
    blockers.push(`Frozen launch-config snapshot is incomplete (${proofLaunchConfigSnapshot.missing.join(', ')}).`);
  }
  if (!String(token.mint || '').trim()) {
    blockers.push('Token mint proof is missing.');
  }
  if (tokenAuthorityPassCount < tokenAuthorityFields.length) {
    blockers.push(`Token authority proof is ${tokenAuthorityPassCount}/${tokenAuthorityFields.length}.`);
  }
  if (recordedPoolCount < plannedPoolCount) {
    blockers.push(`Pool proof is ${recordedPoolCount}/${plannedPoolCount}.`);
  }
  if (plannedPoolCount > 0 && poolCreateTxCount < plannedPoolCount) {
    blockers.push(`Pool-create transaction proof is ${poolCreateTxCount}/${plannedPoolCount}.`);
  }
  if (liquidityEvidence.missing.includes('pool count')) {
    blockers.push('Pool count proof does not match recorded pool rows.');
  } else if (Number.isFinite(proofPoolCount) && proofPoolCount > 0 && proofPoolCount !== recordedPoolCount) {
    blockers.push('Pool count proof does not match recorded pool IDs.');
  }
  if (plannedPositionCount <= 0) {
    blockers.push('Planned position count is missing.');
  } else if (recordedPositionCount < plannedPositionCount) {
    blockers.push(`Position proof is ${recordedPositionCount}/${plannedPositionCount}.`);
  }
  if (liquidityEvidence.missing.includes('position count')) {
    blockers.push('Position count proof does not match recorded position rows.');
  }
  if (liquidityEvidence.missing.includes('position records')) {
    blockers.push('Position record proof is thinner than the reported position count.');
  }
  if (recordedPositionCount > 0 && openTxCount < recordedPositionCount) {
    blockers.push(`Position-open transaction proof is ${openTxCount}/${recordedPositionCount}.`);
  }
  if (recordedPositionCount > 0 && lockedPositionCount < recordedPositionCount) {
    blockers.push(`Burn & Earn lock proof is ${lockedPositionCount}/${recordedPositionCount}.`);
  }
  if (recordedPositionCount > 0 && lockTxCount < recordedPositionCount) {
    blockers.push(`Burn & Earn lock transaction proof is ${lockTxCount}/${recordedPositionCount}.`);
  }
  if (liquidityEvidence.missing.includes('lock count')) {
    blockers.push('Burn & Earn lock count does not match recorded lock rows.');
  }
  if (lockedPositionCount > 0 && feeKeyCount < lockedPositionCount) {
    blockers.push(`Fee Key NFT proof is ${feeKeyCount}/${lockedPositionCount}.`);
  }
  if (liquidityEvidence.missing.includes('fee key count')) {
    blockers.push('Fee Key NFT count does not match recorded Fee Key rows.');
  }
  if (feeKeyRecipientTransferred < feeKeyRecipientTarget) {
    blockers.push(`Fee Key recipient transfer proof is ${feeKeyRecipientTransferred}/${feeKeyRecipientTarget}.`);
  }
  if (airdropStatus.retryRequired) {
    blockers.push(`${airdropStatus.failed} airdrop recipient${airdropStatus.failed === 1 ? '' : 's'} failed.`);
  } else if (airdropStatus.pending > 0) {
    blockers.push(`${airdropStatus.pending} airdrop recipient${airdropStatus.pending === 1 ? '' : 's'} pending.`);
  } else if (!airdropStatus.complete) {
    blockers.push(airdropCompletionIssue(airdropStatus) || 'Airdrop proof is incomplete.');
  }
  if (staleReport) {
    blockers.push('Launch report proof is stale for this launch.');
  } else if (!reportUri && !localDossier) {
    blockers.push(reportLocalOnly
      ? 'Report publishing is off; download or attach the saved launch record before marking the run complete.'
      : 'Launch report artifact proof is missing.');
  } else if (reportLocalOnly && !localDossier) {
    blockers.push('Report publishing is off; download or attach the saved launch record before marking the run complete.');
  }
  if (!finalSweepComplete) {
    blockers.push('Wallet-empty final-sweep proof is missing.');
  } else if ((reportUri || localDossier) && !reportArtifactSweepBound) {
    blockers.push('Launch report artifact is missing terminal final-sweep evidence; download a fresh proof artifact after final sweep.');
  }
  if (finalSweepComplete && proof?.journalId && !matchingLocalJournal) {
    blockers.push('Matching launch journal is not loaded from the local recovery store.');
  } else if (finalSweepComplete && localJournalEvidenceState.mismatches.length) {
    blockers.push(`Local launch journal does not match proof (${localJournalEvidenceState.mismatches.join(', ')}).`);
  } else if (finalSweepComplete && localJournalEvidenceState.missing.length) {
    blockers.push(`Local launch journal is missing proof backing (${localJournalEvidenceState.missing.join(', ')}).`);
  } else if (finalSweepComplete && !terminalJournalComplete) {
    blockers.push('Launch journal has not reached transfer_completed.');
  }

  return {
    complete: blockers.length === 0,
    blockers,
    reportUri,
    localDossier,
    finalSweepComplete,
    terminalJournalComplete,
    tokenAuthorityPassCount,
    tokenAuthorityTotal: tokenAuthorityFields.length,
    recordedPoolCount,
    plannedPoolCount,
    poolCreateTxCount,
    recordedPositionCount,
    plannedPositionCount,
    openTxCount,
    lockedPositionCount,
    lockTxCount,
    feeKeyCount,
    feeKeyRecipientTransferred,
    feeKeyRecipientTarget,
  };
}

function fullRunEndpointLabel(endpoint) {
  return {
    '/api/create-token': 'Creating token',
    '/api/finish-token-creation': 'Finishing interrupted token',
    '/api/create-lp': 'Creating liquidity',
    '/api/resume-launch': 'Resuming liquidity',
    '/api/reveal-sealed-metadata': 'Revealing sealed identity',
    '/api/transfer-assets': 'Sweeping assets',
  }[endpoint] || 'Running classic operation';
}

async function refreshExecutionReadinessForFullRun(walletPublicKey, config) {
  const readiness = await state.apiClient.checkExecutionReadiness({
    walletPublicKey,
    config,
    fundingEstimate: currentClassicFundingEstimateForConfig(config),
    airdropRecipients: config.poolTopology.airdrop.recipients,
  });
  state.executionReadiness = readiness;
  rememberLaunchProof(readiness);
  return readiness;
}

async function runFullLaunch() {
  const config = currentLaunchConfig();
  const walletPublicKey = state.selectedWalletPublicKey || state.managedWallets[0]?.publicKey || '';
  if (!walletPublicKey) {
    notify('Generate or select a launch wallet first');
    return;
  }
  if (state.demoActive) {
    runDemoLaunch();
    return;
  }
  if (state.apiStatus !== 'connected' || !state.apiClient?.executeNextRunOperation) {
    notify('Full launch requires the Trebuchet desktop app');
    return;
  }
  const runEnvelopeId = state.lastRunEnvelope?.status === 'armed'
    ? String(state.lastRunEnvelope.id || '')
    : '';
  if (!runEnvelopeId) {
    // A plan edit since the estimate leaves it stale. Re-estimating is read-only, so Launch does it
    // rather than stopping on the blocker; once the token exists the launch keeps its original estimate.
    if (!classicFundingEstimateStatus(config).matchesConfig && !launchTokenExists()) {
      notify('The plan changed since the estimate: estimating again');
      await estimateClassicFunding();
      state.executionReadiness = null;
      if (!classicFundingEstimateStatus(currentLaunchConfig()).matchesConfig) return;
    }
    // Launch reviews first: it opens the operation review, and approving it starts the launch.
    state.launchAfterArm = true;
    await reviewAndArmRun();
    if (state.lastRunEnvelope?.status === 'armed') { state.launchAfterArm = false; return runFullLaunch(); }
    if (!state.approvalOpen) state.launchAfterArm = false;
    return;
  }
  if (state.fullRunRunning || state.realExecutionRunning) {
    notify('A launch operation is already running');
    return;
  }

  let readiness = state.executionReadiness;
  try {
    if (!readiness || readiness.status !== 'ready') {
      state.executionChecking = true;
      state.fullRunStep = 'Checking readiness';
      renderAll();
      readiness = await refreshExecutionReadinessForFullRun(walletPublicKey, config);
    }
  } catch (error) {
    notify(error.message || 'Execution readiness check failed');
    state.executionChecking = false;
    state.fullRunStep = null;
    renderAll();
    return;
  } finally {
    state.executionChecking = false;
  }

  if (Array.isArray(readiness.blockers) && readiness.blockers.length > 0) {
    notify(`${readiness.blockers.length} execution blocker${readiness.blockers.length === 1 ? '' : 's'}`);
    renderAll();
    return;
  }
  if (!readiness.nextEndpoint) {
    notify(readiness.nextAction || 'No classic endpoint is ready');
    renderAll();
    return;
  }

  {
    const ok = await confirmOperatorAction({
      title: 'Run full launch',
      detail: `Trebuchet will use ${fullAddress(walletPublicKey)} until sweep or a blocker. This can send multiple real transactions through the configured RPC.`,
      confirmLabel: 'Run live launch',
      danger: true,
      confirmationText: 'RUN LIVE',
    });
    if (!ok) return;
  }

  state.fullRunRunning = true;
  state.fullRunStep = 'Starting';
  renderAll();
  const executed = [];
  const finalization = {};

  try {
    for (let index = 0; index < 5; index += 1) {
      readiness = state.executionReadiness || await refreshExecutionReadinessForFullRun(walletPublicKey, config);
      if (Array.isArray(readiness.blockers) && readiness.blockers.length > 0) {
        throw new Error(readiness.blockers[0]?.detail || 'Execution became blocked');
      }
      const endpoint = readiness.nextEndpoint;
      if (!endpoint) break;

      if (endpoint === '/api/transfer-assets') {
        let proof = currentLaunchProof();
        let proofConfig = proofConfigForFingerprint(proof, config);
        let airdropStatus = airdropCompletionStatus(proof, proofConfig.poolTopology);
        if (airdropStatus.retryRequired) {
          state.fullRunStep = 'Retrying airdrop';
          renderAll();
          finalization.airdrop = await runV2Airdrop({ retry: true, skipConfirm: true, quiet: true, refreshReadiness: false });
          const failed = Array.isArray(finalization.airdrop?.failed) ? finalization.airdrop.failed.length : 0;
          if (!finalization.airdrop || failed > 0) {
            throw new Error(failed > 0
              ? `Airdrop still has ${failed} failed recipient${failed === 1 ? '' : 's'}; final sweep stopped.`
              : 'Airdrop retry did not complete; final sweep stopped.');
          }
        }
        proof = currentLaunchProof();
        proofConfig = proofConfigForFingerprint(proof, config);
        airdropStatus = airdropCompletionStatus(proof, proofConfig.poolTopology);
        if (airdropStatus.pending > 0) {
          state.fullRunStep = 'Running airdrop';
          renderAll();
          finalization.airdrop = await runV2Airdrop({ skipConfirm: true, quiet: true, refreshReadiness: false });
          const failed = Array.isArray(finalization.airdrop?.failed) ? finalization.airdrop.failed.length : 0;
          if (!finalization.airdrop || failed > 0) {
            throw new Error(failed > 0
              ? `${failed} airdrop recipient${failed === 1 ? '' : 's'} not paid.`
              : 'Airdrop did not complete; final sweep stopped.');
          }
        }
        proof = currentLaunchProof();
        proofConfig = proofConfigForFingerprint(proof, config);
        airdropStatus = airdropCompletionStatus(proof, proofConfig.poolTopology);
        if (airdropStatus.failed > 0) {
          throw new Error(`${airdropStatus.failed} airdrop recipient${airdropStatus.failed === 1 ? '' : 's'} not paid.`);
        }
        if (!airdropStatus.complete) {
          throw new Error(airdropCompletionIssue(airdropStatus) || 'Airdrop is not complete; final sweep stopped.');
        }
        const reportProof = currentLaunchProof();
        const reportConfig = proofConfigForFingerprint(reportProof, config);
        const reportPublish = currentReportPublish(reportProof, reportConfig);
        const reportDone = reportPublish?.jsonUri || reportPublish?.htmlUri || currentLocalDossier(reportProof, reportConfig);
        if (!reportDone && state.prefs.publishLaunchReport === false) {
          throw new Error('Report publishing is off; download the saved launch record before final sweep.');
        }
        if (!reportDone && reportProof?.canPublishReport && proofHasReportPublishEvidence(reportProof, reportConfig)) {
          state.fullRunStep = 'Publishing report';
          renderAll();
          finalization.report = await publishV2LaunchReport({ quiet: true, refreshReadiness: false });
          if (!finalization.report || finalization.report.failed || finalization.report.skipped) {
            throw new Error(finalization.report?.error || finalization.report?.reason || 'Launch report did not publish; final sweep stopped.');
          }
        } else if (!reportDone) {
          throw new Error('Publish or download the launch report before final sweep.');
        }
        readiness = await refreshExecutionReadinessForFullRun(walletPublicKey, config);
      }

      if (!readiness.nextEndpoint) break;
      const endpointToRun = readiness.nextEndpoint;
      state.fullRunStep = fullRunEndpointLabel(endpointToRun);
      const ledgerId = startExecutionLedgerEntry({
        kind: 'endpoint',
        endpoint: endpointToRun,
        label: fullRunEndpointLabel(endpointToRun),
        detail: readiness.nextAction || `Confirmed ${endpointToRun} for ${fullAddress(walletPublicKey)}.`,
      });
      renderAll();
      try {
        const dossierProof = currentLaunchProof();
        const dossierConfig = proofConfigForFingerprint(dossierProof, config);
        const result = await state.apiClient.executeNextRunOperation({
          walletPublicKey,
          config,
          fundingEstimate: currentClassicFundingEstimateForConfig(config),
          airdropRecipients: config.poolTopology.airdrop.recipients,
          confirmNextEndpoint: endpointToRun,
          localDossier: currentLocalDossier(dossierProof, dossierConfig),
          runEnvelopeId,
        });
        if (result.envelope) state.lastRunEnvelope = result.envelope;
        executed.push(result.executed);
        state.lastRealExecution = result.executed;
        state.executionReadiness = result.readiness || state.executionReadiness;
        rememberLaunchProof(result.proof || result.readiness?.proof);
        finishExecutionLedgerEntry(ledgerId, {
          status: 'complete',
          detail: `${result.executed?.action || fullRunEndpointLabel(result.executed?.endpoint)} completed.`,
          ...ledgerObservationFromExecution(result.executed),
        });
        pollLiveOps().catch(() => null);

        if (result.executed?.endpoint === '/api/transfer-assets') break;
      } catch (error) {
        applyExecutionErrorReadiness(error);
        finishExecutionLedgerEntry(ledgerId, {
          status: 'error',
          error: error.message || 'Classic operation failed',
          detail: error.message || 'Classic operation failed.',
        });
        throw error;
      }
    }

    state.fullRunStep = 'Verifying launch record';
    renderAll();
    try {
      readiness = await refreshExecutionReadinessForFullRun(walletPublicKey, config);
    } catch (error) {
      finalization.proofVerificationError = error.message || 'Launch record refresh failed';
    }
    try {
      await refreshLocalApiState();
    } catch (error) {
      finalization.recoveryRefreshError = error.message || 'Local recovery refresh failed';
    }
    const completion = fullRunCompletionAudit(currentLaunchProof(), config);
    const fullRunStatus = completion.complete ? 'complete' : 'needs-proof';
    state.lastFullRun = {
      status: fullRunStatus,
      executed,
      finalization,
      proof: currentLaunchProof(),
      completion,
      completedAt: completion.complete ? new Date().toISOString() : null,
      advancedAt: new Date().toISOString(),
    };
    history.unshift({
      title: completion.complete
        ? `${config.token.symbol} full launch complete`
        : `${config.token.symbol} full launch needs proof`,
      detail: completion.complete
        ? `${executed.length} classic operation${executed.length === 1 ? '' : 's'} executed and terminal proof is attached.`
        : `${executed.length} classic operation${executed.length === 1 ? '' : 's'} executed; ${completion.blockers[0] || 'proof review is still pending'}`,
      time: 'Just now',
    });
    await refreshLocalApiState();
    pollLiveOps().catch(() => null);
    notify(completion.complete
      ? `Full launch complete: ${executed.length} operation${executed.length === 1 ? '' : 's'} executed`
      : `Full launch needs proof: ${completion.blockers[0] || `${executed.length} operation${executed.length === 1 ? '' : 's'} advanced`}`);
  } catch (error) {
    notify(error.message || 'Full launch failed');
  } finally {
    state.fullRunRunning = false;
    state.fullRunStep = null;
    renderAll();
  }
}

async function runLaunchEnvelope() {
  if (!state.transactions.length) return;
  const walletPublicKey = state.selectedWalletPublicKey || account().publicKey || account().id;
  if (state.apiStatus !== 'connected' || !state.apiClient?.armRunEnvelope) {
    notify('Arming requires the Trebuchet desktop app');
    return;
  }
  if (!walletIsUnlocked()) {
    const unlocked = await unlockSecretPin({ reason: 'arm' });
    if (!unlocked || !walletIsUnlocked()) {
      notify('Unlock the Recovery PIN before arming');
      return;
    }
  }
  const config = currentLaunchConfig();
  const recoveryEndpoint = recoveryAuthorizationEndpoint();
  const reviewedPlanStatus = recoveryEndpoint ? null : localApiLaunchPlanStatus(state.launchPlan, config);
  const reviewedPlanDigest = String(state.launchPlan?.integrity?.digest || '').trim().toLowerCase();
  if (
    !recoveryEndpoint
    && (!reviewedPlanStatus?.ready || !/^[a-f0-9]{64}$/.test(reviewedPlanDigest))
  ) {
    notify('The launch plan changed or is incomplete. Stage and review it again before arming.');
    await stageTransactions({ openApproval: true, announce: false });
    return;
  }
  // Once the token exists (next step is liquidity or later), funding is
  // committed: arm with the estimate the launch started from, never send
  // the user back to Fund to re-estimate from half-spent balances.
  const midLaunch = launchTokenExists();
  const fundingEstimate = recoveryEndpoint
    ? null
    : currentClassicFundingEstimateForConfig(config) || (midLaunch ? state.classicFundingEstimate : null);
  if (!recoveryEndpoint && !fundingEstimate) {
    notify('Run a current funding estimate before arming');
    setLaunchWorkspace('fund', { focus: true });
    return;
  }
  const proof = currentLaunchProof();
  const proofConfig = proofConfigForFingerprint(proof, config);
  const localDossier = currentLocalDossier(proof, proofConfig);
  try {
    state.lastRunEnvelope = await state.apiClient.armRunEnvelope({
      walletPublicKey,
      config,
      fundingEstimate,
      recoveryEndpoint,
      localDossier,
      reviewedPlan: recoveryEndpoint ? null : state.launchPlan,
      reviewedPlanDigest: recoveryEndpoint ? null : reviewedPlanDigest,
    });
  } catch (error) {
    notify(error.message || 'Could not arm local run');
    return;
  }
  state.launchStage = Math.max(state.launchStage, 2);
  state.activeApprovalId = null;
  state.approvalOpen = false;
  history.unshift({
    title: recoveryEndpoint
      ? `${($('#tokenSymbol').value || 'TOK').toUpperCase()} recovery armed`
      : `${($('#tokenSymbol').value || 'TOK').toUpperCase()} local run armed`,
    detail: recoveryEndpoint
      ? `${state.transactions[0]?.label || 'Recovery action'} reviewed for ${account().name}; envelope ${state.lastRunEnvelope.id}. Nothing executed during arming.`
      : `${state.transactions.length} operations reviewed for ${account().name}; envelope ${state.lastRunEnvelope.id}. No transaction has executed yet.`,
    time: 'Just now',
  });
  renderAll();
  const nextOperation = state.executionReadiness?.nextEndpoint === '/api/create-token'
    ? 'Create token'
    : state.executionReadiness?.nextEndpoint === '/api/finish-token-creation'
      ? 'Finish token safely'
    : state.executionReadiness?.nextAction || 'the next operation';
  if (state.launchAfterArm && !recoveryEndpoint) {
    state.launchAfterArm = false;
    notify('Approved. Launching.');
    runFullLaunch().catch((error) => notify(error.message || 'The launch could not start'));
    return;
  }
  state.launchAfterArm = false;
  notify(`Approved. Next: ${nextOperation}.`);
  window.requestAnimationFrame(() => {
    document.querySelector(`[data-classic-workspace="${state.launchWorkspace}"] [data-action="execute-next-run"]`)?.focus();
  });
}

// Once the token exists, funding is committed: the launch continues on the estimate it started
// from. Nothing after that point re-estimates or sends you back to Fund.
function launchTokenExists() {
  return Boolean(proofTokenMint(currentLaunchProof()));
}
