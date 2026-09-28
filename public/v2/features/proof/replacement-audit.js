function buildClassicRetirementGate(proof = currentLaunchProof(), audit = null, config = currentLaunchConfig()) {
  config = proofConfigForFingerprint(proof, config);
  const expectedAuditFingerprint = launchProofFingerprint(proof, config);
  audit = reportParityAuditMatchesProof(audit, proof, config)
    ? audit
    : buildV2ReportParityAudit(proof, config);
  const comparison = currentClassicComparisonForProof(proof, config);
  const results = Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results : [];
  const plannedPools = buildV2ReportPoolPlan(config, results, proof);
  const plannedPoolCount = Math.max(1, plannedPools.length || 0);
  const plannedPositionCount = plannedPools.reduce((sum, pool) => sum + Number(pool.plannedPositionCount || 0), 0);
  const recordedPoolIds = launchProofPoolIds(proof);
  const poolCount = Number(proof?.liquidity?.poolCount || results.length || 0);
  const positionCount = proofPositions(results);
  const liquidityEvidence = comparisonLiquidityEvidenceState(proof, {
    plannedPoolCount,
    plannedPositionCount,
  });
  const recordedPositionCount = liquidityEvidence.positionCount;
  const lockedPositionCount = liquidityEvidence.lockedPositionCount;
  const feeKeyCount = liquidityEvidence.feeKeyCount;
  const txEvidence = v2LiquidityTransactionEvidenceCounts(results);
  const feeKeyRecipientTarget = txEvidence.feeKeyRecipientRows.length;
  const report = currentReportPublish(proof, config);
  const localDossier = currentLocalDossier(proof, config);
  const staleReport = staleReportPublishForProof(proof, config);
  const reportUri = report?.htmlUri || report?.jsonUri || null;
  const reportArtifactRecord = report || localDossier || null;
  const reportArtifact = reportUri || localDossier;
  const finalSweepComplete = transferHasWalletEmptyFinalSweepEvidence(proof?.transfer);
  const reportArtifactSweepBound = Boolean(
    finalSweepComplete
    && reportArtifactRecord
    && reportArtifactMatchesTerminalSweep(reportArtifactRecord, proof)
  );
  const isDemoProof = isDemoLaunchProof(proof);
  const comparisonIsV2Artifact = comparison?.artifactSource === 'trebuchet-v2';
  const comparisonMatchesProof = classicComparisonMatchesProof(comparison, proof, config);
  const comparisonEvidence = classicComparisonRequiredEvidence(comparison, proof, config);
  const proofLaunchConfigSnapshot = proofLaunchConfigSnapshotState(proof);
  const proofJournalEvidence = Boolean(proof?.journalId);
  const localJournalEvidenceState = proofJournalEvidenceState(proof);
  const matchingLocalJournal = localJournalEvidenceState.journal;
  const proofTerminalJournalEvidence = proofHasTerminalLaunchJournal(proof);
  const proofWalletEvidence = Boolean(proof?.walletPublicKey);
  const liveTokenAuthorityFields = ['mintAuthorityRenounced', 'freezeAuthorityDisabled', 'metadataUpdateAuthorityRevoked', 'metadataImmutable'];
  const liveTokenAuthorityPassCount = liveTokenAuthorityFields.filter((field) => proof?.token?.[field] === true).length;
  const liveTokenAuthorityComplete = liveTokenAuthorityPassCount === liveTokenAuthorityFields.length;
  const livePoolIdentityComplete = Boolean(
    plannedPoolCount > 0
    && recordedPoolIds.length === plannedPoolCount
    && poolCount === plannedPoolCount
    && txEvidence.poolCreateTxCount >= plannedPoolCount
    && !liquidityEvidence.missing.includes('pool count')
  );
  const livePositionProofComplete = Boolean(
    plannedPositionCount > 0
    && recordedPositionCount >= plannedPositionCount
    && txEvidence.openTxCount >= recordedPositionCount
    && !liquidityEvidence.missing.some((item) => ['position count', 'position records'].includes(item))
  );
  const liveLockProofComplete = Boolean(
    recordedPositionCount > 0
    && lockedPositionCount >= recordedPositionCount
    && txEvidence.lockTxCount >= recordedPositionCount
    && !liquidityEvidence.missing.includes('lock count')
    && feeKeyCount >= lockedPositionCount
    && !liquidityEvidence.missing.includes('fee key count')
    && txEvidence.feeKeyRecipientTransferred >= feeKeyRecipientTarget
  );
  const liveLiquidityProofComplete = Boolean(livePoolIdentityComplete && livePositionProofComplete && liveLockProofComplete);
  const hasCompletedLiveProof = Boolean(
    proof
    && !isDemoProof
    && proofLaunchConfigSnapshot.complete
    && proofJournalEvidence
    && proofTerminalJournalEvidence
    && proofWalletEvidence
    && proof?.token?.mint
    && liveTokenAuthorityComplete
    && liveLiquidityProofComplete
    && finalSweepComplete,
  );
  const demoRunComplete = demoRunHasCompletedReadiness();
  const replacementCriteria = buildV2ReplacementCriteriaAudit({
    proof,
    audit,
    hasCompletedLiveProof,
    demoRunComplete,
    reportArtifact,
    reportArtifactRecord,
    reportArtifactSweepBound,
    comparison,
    comparisonMatchesProof,
    comparisonEvidence,
    comparisonIsV2Artifact,
    config,
  });
  const missingReplacementCriteria = replacementCriteria.filter((item) => item.pass !== true);
  const requirements = [
    {
      id: 'live-proof',
      pass: hasCompletedLiveProof,
      detail: hasCompletedLiveProof
        ? `Live Trebuchet proof has ${poolCount} pool${poolCount === 1 ? '' : 's'} and ${positionCount} position${positionCount === 1 ? '' : 's'}.`
        : isDemoProof
          ? 'Test launch record proves wiring only; run a real Trebuchet launch before retiring Classic.'
          : proof && proofLaunchConfigSnapshot.state === 'missing'
            ? 'Completed proof is missing its frozen launch-config snapshot; load proof-bound config before retiring Classic.'
            : proof && proofLaunchConfigSnapshot.state === 'mismatch'
              ? `Completed proof has a mismatched frozen launch-config snapshot (${proofLaunchConfigSnapshot.mismatches.join(', ')}); load the journal-bound token and pool configuration before retiring Classic.`
            : proof && !proofLaunchConfigSnapshot.complete
              ? `Completed proof has an incomplete frozen launch-config snapshot (${proofLaunchConfigSnapshot.missing.join(', ')}); load proof-bound token and pool configuration before retiring Classic.`
            : proof && !proofJournalEvidence
              ? 'Completed proof is missing its launch journal id; load journal-backed proof before retiring Classic.'
            : proof && !matchingLocalJournal
              ? `Completed proof journal ${proof.journalId} is not loaded from the local launch-journal store; refresh local recovery state before retiring Classic.`
            : proof && localJournalEvidenceState.mismatches.length
              ? `Loaded launch journal does not match proof (${localJournalEvidenceState.mismatches.join(', ')}); refresh local recovery state before retiring Classic.`
            : proof && localJournalEvidenceState.missing.length
              ? `Loaded launch journal is missing proof backing (${localJournalEvidenceState.missing.join(', ')}); refresh local recovery state before retiring Classic.`
            : proof && !proofTerminalJournalEvidence
              ? `Launch journal is not terminal (${proof?.status || 'unknown'} / ${proof?.stage || 'unknown'}); refresh proof after final sweep before retiring Classic.`
            : proof && !proofWalletEvidence
              ? 'Completed proof is missing its launch wallet; load wallet-bound proof before retiring Classic.'
          : proof?.token?.mint && !liveTokenAuthorityComplete
                ? `Token authority proof is ${liveTokenAuthorityPassCount}/${liveTokenAuthorityFields.length}; complete authority evidence before retiring Classic.`
          : proof && (!livePoolIdentityComplete && (recordedPoolIds.length !== plannedPoolCount || poolCount !== plannedPoolCount || liquidityEvidence.missing.includes('pool count')))
            ? `Pool identity proof is ${recordedPoolIds.length}/${plannedPoolCount}; load exact recorded pool IDs before retiring Classic.`
          : proof && txEvidence.poolCreateTxCount < plannedPoolCount
            ? `Pool-create transaction proof is ${txEvidence.poolCreateTxCount}/${plannedPoolCount}; refresh journal-backed liquidity proof before retiring Classic.`
          : proof && !livePositionProofComplete && (recordedPositionCount < plannedPositionCount || liquidityEvidence.missing.some((item) => ['position count', 'position records'].includes(item)))
            ? `Position proof is ${recordedPositionCount}/${plannedPositionCount}; load exact position records before retiring Classic.`
          : proof && txEvidence.openTxCount < recordedPositionCount
            ? `Position-open transaction proof is ${txEvidence.openTxCount}/${recordedPositionCount}; refresh journal-backed liquidity proof before retiring Classic.`
          : proof && !liveLockProofComplete && (lockedPositionCount < recordedPositionCount || liquidityEvidence.missing.includes('lock count'))
            ? `Burn & Earn lock proof is ${lockedPositionCount}/${recordedPositionCount}; complete lock evidence before retiring Classic.`
          : proof && txEvidence.lockTxCount < recordedPositionCount
            ? `Burn & Earn lock transaction proof is ${txEvidence.lockTxCount}/${recordedPositionCount}; refresh journal-backed liquidity proof before retiring Classic.`
          : proof && !liveLockProofComplete && (feeKeyCount < lockedPositionCount || liquidityEvidence.missing.includes('fee key count'))
            ? `Fee Key NFT proof is ${feeKeyCount}/${lockedPositionCount}; complete Fee Key mint evidence before retiring Classic.`
          : proof && txEvidence.feeKeyRecipientTransferred < feeKeyRecipientTarget
            ? `Fee Key recipient transfer proof is ${txEvidence.feeKeyRecipientTransferred}/${feeKeyRecipientTarget}; complete recipient delivery evidence before retiring Classic.`
          : proof?.transfer && !finalSweepComplete
            ? 'Final sweep record is not terminal; verify wallet-empty, error-free sweep evidence before retiring Classic.'
            : 'Run a real Trebuchet launch through token, liquidity, and final sweep.',
    },
    {
      id: 'report-proof',
      pass: Boolean(reportArtifact && reportArtifactSweepBound),
      detail: reportUri
        ? reportArtifactSweepBound
          ? `Permanent report proof is attached: ${shortAddress(reportUri)}.`
          : 'Permanent report proof is missing the terminal sweep evidence hash; republish after final sweep before replacing Classic.'
        : localDossier
          ? reportArtifactSweepBound
            ? `Saved launch record proof is attached: ${localDossier.filename}.`
            : 'Saved launch record proof is missing the terminal sweep evidence hash; download a fresh launch record after final sweep before replacing Classic.'
        : staleReport
          ? reportPublishMatchesProof(staleReport, proof, config) && !reportArtifactMatchesTerminalSweep(staleReport, proof)
            ? localDossierHasEvidence(staleReport)
              ? 'Saved launch record proof is missing the terminal sweep evidence hash; download a fresh launch record after final sweep before replacing Classic.'
              : 'Permanent report proof is missing the terminal sweep evidence hash; republish after final sweep before replacing Classic.'
            : 'Report artifact belongs to another Trebuchet proof; regenerate it before replacing Classic.'
          : 'Publish or attach a proof-bound Trebuchet launch report before replacing Classic.',
    },
    {
      id: 'classic-comparison',
      pass: comparison?.status === 'pass' && !comparisonIsV2Artifact && comparisonMatchesProof && comparisonEvidence.pass,
      detail: comparison?.status === 'pass' && !comparisonIsV2Artifact && comparisonMatchesProof && comparisonEvidence.pass
        ? `Classic artifact comparison passed ${comparison.passCount || 0}/${comparison.fieldCount || 0} fields.`
        : comparisonIsV2Artifact
          ? 'Loaded artifact was generated by Trebuchet; compare against a completed Classic artifact.'
          : comparison && !comparisonMatchesProof
            ? 'Classic artifact comparison belongs to another Trebuchet proof; rerun it for the current launch.'
          : comparison?.status === 'pass' && !comparisonEvidence.pass
            ? comparisonEvidence.detail
          : comparison
            ? `Classic artifact comparison is ${comparison.status}: ${comparison.mismatchCount || 0} mismatched, ${comparison.missingCount || 0} missing.`
            : 'Paste and compare a completed Classic artifact against the completed Trebuchet proof.',
    },
    {
      id: 'audit',
      pass: audit?.status === 'pass',
      detail: audit?.status === 'pass'
        ? 'The generated Trebuchet proof audit is fully passing.'
        : `Proof audit is ${audit?.status || 'missing'} with ${audit?.missingCount || 0} missing and ${audit?.warnCount || 0} warning checks.`,
    },
    {
      id: 'replacement-criteria',
      pass: missingReplacementCriteria.length === 0,
      detail: missingReplacementCriteria.length === 0
        ? `${replacementCriteria.length}/${replacementCriteria.length} replacement criteria have proof.`
        : `${missingReplacementCriteria.length} replacement criteria still need proof: ${missingReplacementCriteria.map((item) => item.label || item.id).slice(0, 3).join(', ')}${missingReplacementCriteria.length > 3 ? ', ...' : ''}.`,
    },
  ];
  const missing = requirements.filter((item) => !item.pass);
  const passCount = requirements.length - missing.length;
  return {
    id: 'classic-retirement',
    source: 'trebuchet-v2-classic-retirement-gate',
    proofFingerprint: expectedAuditFingerprint,
    auditFingerprint: audit?.proofFingerprint || null,
    title: missing.length ? 'Classic retirement gate' : 'Classic can be retired',
    state: missing.length ? 'danger' : 'pass',
    badge: missing.length ? 'Blocked' : 'Ready',
    detail: missing.length ? missing[0].detail : 'Live Trebuchet proof, proof-bound report artifact, and Classic comparison are all attached.',
    passCount,
    itemCount: requirements.length,
    requirements,
    replacementCriteria,
    criteriaPassCount: replacementCriteria.filter((item) => item.pass).length,
    criteriaItemCount: replacementCriteria.length,
  };
}

function loadedRecoveryJournalEvidence() {
  const journals = Array.isArray(state.recovery?.journals) ? state.recovery.journals : [];
  const rows = journals.filter((journal) => {
    if (!journal || !journal.id) return false;
    const status = String(journal.status || '').toLowerCase();
    if (['completed', 'archived'].includes(status)) return false;
    return journalHasRecoveryPlanningEvidence(journal);
  });
  const failed = rows.filter((journal) => {
    const status = String(journal.status || '').toLowerCase();
    const stage = String(journal.stage || '').toLowerCase();
    return status === 'failed' || stage.includes('failed') || stage.includes('partial');
  }).length;
  return {
    count: rows.length,
    failed,
  };
}

function journalHasRecoveryPlanningEvidence(journal = {}) {
  if (!journal || isTerminalJournal(journal)) return false;
  const priorResults = typeof journalPriorResults === 'function'
    ? journalPriorResults(journal)
    : (
      Array.isArray(journal?.lp?.results) && journal.lp.results.length
        ? journal.lp.results
        : (Array.isArray(journal?.lp?.partialResults) ? journal.lp.partialResults : [])
    );
  const checkpointMatcher = typeof journalIsResumeCheckpointResult === 'function'
    ? journalIsResumeCheckpointResult
    : recoveryResultHasDurableCheckpointRow;
  if (priorResults.some(checkpointMatcher)) return true;
  const poolPlan = journal.poolPlan && typeof journal.poolPlan === 'object' ? journal.poolPlan : null;
  const allocations = Array.isArray(poolPlan?.allocations) ? poolPlan.allocations : [];
  const tokenMint = typeof journalTokenMint === 'function'
    ? journalTokenMint(journal)
    : String(journal?.token?.mint || journal?.token?.tokenMint || journal?.poolPlan?.tokenMint || '').trim();
  if (allocations.length > 0 && (poolPlan?.tokenMint || tokenMint)) return true;
  const unsafeEvents = typeof journalUnsafePoolEvents === 'function'
    ? journalUnsafePoolEvents(journal, priorResults)
    : (Array.isArray(journal?.events)
      ? journal.events.filter((event) => event?.stage === 'pool_create_done')
      : []);
  if (unsafeEvents.some((event) => String(event?.poolId || '').trim())) {
    return true;
  }
  const failedPhase = journal?.lp?.failedPhase || journal?.errorDetails?.failedPhase || '';
  return Boolean(failedPhase && (allocations.length > 0 || priorResults.length > 0));
}

function recoveryResultHasResumeEvidence(result = state.lastRecoveryResult) {
  if (!result || typeof result !== 'object' || result.success !== true) return false;
  const rows = Array.isArray(result.results)
    ? result.results
    : Array.isArray(result.partialResults) ? result.partialResults : [];
  if (rows.some(recoveryResultHasDurableCheckpointRow)) return true;
  const journal = result.journal && typeof result.journal === 'object' ? result.journal : null;
  if (String(journal?.id || journal?.journalId || '').trim()) return true;
  const recovered = result.recovered && typeof result.recovered === 'object' ? result.recovered : null;
  if (String(recovered?.journalId || recovered?.journal?.id || '').trim()) return true;
  return false;
}

function recoveryResultPositionRows(row = {}) {
  return [
    ...(Array.isArray(row?.mainPositions) ? row.mainPositions : []),
    ...(Array.isArray(row?.ladderPositions) ? row.ladderPositions : []),
    ...(Array.isArray(row?.supportPositions) ? row.supportPositions : []),
    ...(row?.bootstrap && typeof row.bootstrap === 'object' ? [row.bootstrap] : []),
  ];
}

function recoveryResultHasOpenedPositionEvidence(row = {}) {
  return recoveryResultPositionRows(row).some((position) => Boolean(
    position?.nftMint
    || position?.positionNftMint
    || position?.txIds?.open
    || position?.openTx
  ));
}

function recoveryResultHasDurableCheckpointRow(row = {}) {
  const poolId = String(row?.poolId || row?.id || '').trim();
  return Boolean(
    poolId
    && (
      row.phase1Complete === true
      || recoveryResultHasOpenedPositionEvidence(row)
    )
  );
}

function buildV2ReplacementCriteriaAudit({
  proof = currentLaunchProof(),
  audit = null,
  hasCompletedLiveProof = false,
  demoRunComplete = false,
  reportArtifact = null,
  reportArtifactRecord = null,
  reportArtifactSweepBound = false,
  comparison = null,
  comparisonMatchesProof = false,
  comparisonEvidence = null,
  comparisonIsV2Artifact = false,
  config = proofConfigForFingerprint(proof, currentLaunchConfig()),
} = {}) {
  const results = Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results : [];
  const plannedPools = buildV2ReportPoolPlan(config, results, proof);
  const selectedWalletPublicKey = selectedLaunchWalletPublicKey();
  const selectedWallet = selectedManagedWallet();
  const walletSecretLocked = state.secretPin?.locked === true || selectedWallet?.secretPinLocked === true;
  const proofWalletEvidence = Boolean(proof?.walletPublicKey && hasCompletedLiveProof);
  const walletRuntimeEvidence = Boolean(
    state.apiStatus === 'connected'
    && selectedWalletPublicKey
    && selectedWallet
    && selectedWallet.hasSecretKey === true
    && !walletSecretLocked
    && !selectedWallet.decryptionFailed
  );
  const walletEvidence = Boolean(proofWalletEvidence || walletRuntimeEvidence);
  const persistedVanityCandidates = state.vanityCandidates.filter((candidate) => (
    state.apiStatus === 'connected'
    && candidate?.persisted === true
    && candidate?.decryptionFailed !== true
    && candidate?.hasSecretKey !== false
  ));
  const selectedVanityCandidate = persistedVanityCandidates.find((candidate) => (
    candidate.publicKey === state.selectedVanityPublicKey
  )) || null;
  const nativeVanityAvailable = state.apiStatus === 'connected' && state.vanityAvailable;
  const vanityEvidence = Boolean(
    selectedVanityCandidate
    || persistedVanityCandidates.length
    || nativeVanityAvailable
  );
  const chartRendererEvidence = Boolean(typeof renderV2TokenomicsDonutSvg === 'function' && typeof liquidityDepthRows === 'function');
  const viewportSmokeProof = validatedLocalViewportSmokeProof();
  const viewportSmokeStatus = state.viewportSmoke || proof?.viewportSmoke || proof?.reportParity?.viewportSmoke || null;
  const viewportSmokeApiConnected = state.apiStatus === 'connected';
  const viewportSmokeEvidence = viewportSmokeApiConnected && Boolean(viewportSmokeProof);
  const viewportSmokeNames = Array.isArray(viewportSmokeProof?.viewports)
    ? viewportSmokeProof.viewports.filter((row) => row?.passed).map((row) => row.name).filter(Boolean)
    : [];
  const viewportSmokeDetail = viewportSmokeProof
    ? viewportSmokeApiConnected
      ? `Viewport smoke passed${viewportSmokeNames.length ? ` for ${viewportSmokeNames.join(', ')}` : ''}${viewportSmokeProof.generatedAt ? ` at ${viewportSmokeProof.generatedAt}` : ''}.`
    : 'Connect the desktop app to verify viewport smoke proof against current Trebuchet assets.'
    : viewportSmokeStatus?.detail || 'Run `npm run test:v2:viewport` to generate desktop/mobile viewport-smoke proof.';
  const topologyIssues = typeof customQuoteSafetySummary === 'function'
    ? customQuoteSafetySummary(config?.poolTopology || {})
    : { blockers: [], warnings: [] };
  const poolBlockerCount = Array.isArray(topologyIssues?.blockers) ? topologyIssues.blockers.length : 0;
  const poolWarningCount = Array.isArray(topologyIssues?.warnings) ? topologyIssues.warnings.length : 0;
  const localApiLaunchPlan = localApiLaunchPlanStatus(state.launchPlan, config);
  const localApiLaunchPlanEvidence = localApiLaunchPlan.ready;
  const chartModelEvidence = Boolean(hasCompletedLiveProof || localApiLaunchPlanEvidence);
  const tokenConfig = tokenConfigStatus(hasCompletedLiveProof ? proofConfigForFingerprint(proof, config) : config);
  const tokenConfigEvidence = Boolean(
    tokenConfig.ready
    && (hasCompletedLiveProof || localApiLaunchPlanEvidence)
  );
  const poolConfigEvidence = Boolean(
    plannedPools.length
    && poolBlockerCount === 0
    && (hasCompletedLiveProof || localApiLaunchPlanEvidence)
  );
  const funding = typeof fundingMeterSnapshot === 'function'
    ? fundingMeterSnapshot(config)
    : { missingSol: 0, hasWalletBalance: false };
  const fundingEstimateStatus = classicFundingEstimateStatus(config);
  const fundingEstimateEvidence = fundingEstimateStatus.matchesConfig;
  const fundingBalanceEvidence = state.apiStatus === 'connected' && funding.hasWalletBalance === true && funding.walletBalanceFresh === true;
  const fundingSolEvidence = Number(funding.missingSol || 0) <= 0.001;
  const quoteRoutes = typeof quoteAcquireRoutes === 'function' ? quoteAcquireRoutes() : [];
  const quoteStatus = typeof quoteAcquireStatus === 'function'
    ? quoteAcquireStatus(config)
    : { ready: !quoteRoutes.length, stale: false };
  const quoteAcquireEvidence = quoteStatus.ready;
  const manualItems = typeof quoteManualPrefundItems === 'function' ? quoteManualPrefundItems() : [];
  const manualSummary = typeof manualPrefundSummary === 'function'
    ? manualPrefundSummary(manualItems)
    : { className: manualItems.length ? 'warn' : '' };
  const manualPrefundEvidence = !manualItems.length || manualSummary.className === '';
  const fundingEvidence = Boolean(
    hasCompletedLiveProof
    || (fundingEstimateEvidence
      && fundingBalanceEvidence
      && fundingSolEvidence
      && quoteAcquireEvidence
      && manualPrefundEvidence)
  );
  const currentHeldReserveAudit = buildV2ReportHeldReserveAudit(config, currentClassicFundingEstimateForConfig(config));
  const reportHeldReserveAudit = reportArtifactRecord?.heldReserveAudit && typeof reportArtifactRecord.heldReserveAudit === 'object'
    ? reportArtifactRecord.heldReserveAudit
    : null;
  const effectiveHeldReserveAudit = reportHeldReserveAudit || currentHeldReserveAudit;
  const heldReserveConfigured = Number(
    effectiveHeldReserveAudit?.heldReservePercent ?? currentHeldReserveAudit?.heldReservePercent ?? 0,
  ) > 0;
  const heldReserveEvidence = !heldReserveConfigured
    || (hasCompletedLiveProof
      ? Boolean(reportArtifactSweepBound && reportHeldReserveAudit?.state === 'pass')
      : currentHeldReserveAudit?.state === 'pass');
  const proofJournalEvidence = Boolean(proof?.journalId);
  const localJournalEvidenceState = proofJournalEvidenceState(proof);
  const matchingLocalJournal = localJournalEvidenceState.journal;
  const proofTerminalJournalEvidence = proofHasTerminalLaunchJournal(proof);
  const proofFinalSweepEvidence = transferHasWalletEmptyFinalSweepEvidence(proof?.transfer);
  const proofBackedPreterminalJournalEvidence = Boolean(
    proofJournalEvidence
    && matchingLocalJournal
    && !isTerminalJournal(matchingLocalJournal)
    && journalHasRecoveryPlanningEvidence(matchingLocalJournal)
  );
  const localRecoveryJournal = loadedRecoveryJournalEvidence();
  const localJournalEvidence = localRecoveryJournal.count > 0;
  const recoveryResultJournalEvidence = recoveryResultHasResumeEvidence();
  const resumeEvidence = hasCompletedLiveProof
    ? proofJournalEvidence && proofTerminalJournalEvidence
    : proof && proofFinalSweepEvidence
      ? Boolean(proofJournalEvidence && matchingLocalJournal && localJournalEvidenceState.backed && proofTerminalJournalEvidence)
      : Boolean(
        proofBackedPreterminalJournalEvidence
        || localJournalEvidence
        || recoveryResultJournalEvidence
      );
  const sweepReportEvidence = Boolean(
    reportArtifact
    && reportArtifactSweepBound
    && transferHasWalletEmptyFinalSweepEvidence(proof?.transfer)
  );
  const staleReportArtifact = staleReportPublishForProof(proof, config);
  const staleReportMissingSweepHash = Boolean(
    staleReportArtifact
    && reportPublishMatchesProof(staleReportArtifact, proof, config)
    && !reportArtifactMatchesTerminalSweep(staleReportArtifact, proof)
  );
  const requiredComparisonEvidence = comparisonEvidence || classicComparisonRequiredEvidence(comparison, proof, config);
  const classicComparisonEvidence = Boolean(
    comparison?.status === 'pass'
    && comparisonMatchesProof
    && requiredComparisonEvidence.pass
    && !comparisonIsV2Artifact
  );

  return [
    {
      id: 'demo-end-to-end',
      label: 'Full demo launch',
      pass: Boolean(demoRunComplete || hasCompletedLiveProof),
      evidence: demoRunComplete
        ? `Test launch ${shortAddress(state.lastDemoLaunchRun?.token?.tokenMint || state.lastDemoLaunchRun?.token?.mint)} completed with terminal readiness proof.`
        : hasCompletedLiveProof
          ? 'Completed live Trebuchet proof is stronger than the demo path.'
          : state.lastDemoLaunchRun
            ? 'Test launch exists, but terminal readiness or final sweep evidence is incomplete.'
          : 'Run the Trebuchet demo launch before replacing Classic.',
      detail: 'Covers token creation, LP creation, Fee Key recipient transfer, airdrop delivery, and final sweep routing.',
    },
    {
      id: 'wallet-lifecycle',
      label: 'Wallet generation and recovery',
      pass: walletEvidence,
      evidence: walletEvidence
        ? proofWalletEvidence
          ? `Launch wallet ${shortAddress(proof.walletPublicKey)} is attached to completed proof.`
          : `Selected launch wallet ${shortAddress(selectedWalletPublicKey)} has an available local signing secret.`
        : selectedWalletPublicKey
          ? !selectedWallet
            ? 'This address is not one of your saved launch wallets.'
            : walletSecretLocked
              ? 'Selected launch wallet is PIN locked; unlock it before Trebuchet can replace Classic signing.'
            : selectedWallet.decryptionFailed || selectedWallet.hasSecretKey !== true
                ? 'Selected launch wallet is missing a usable signing secret.'
                : state.apiStatus !== 'connected'
                  ? 'Connect the desktop app to verify this launch wallet signing secret.'
                : 'Select a launch wallet with an available signing secret.'
        : 'Generate, import, or load a launch wallet.',
      detail: 'Replaces Classic temporary-wallet generation, funding address, QR, and Recovery PIN flows.',
    },
    {
      id: 'vanity-options',
      label: 'Vanity CA options',
      pass: vanityEvidence,
      evidence: selectedVanityCandidate
        ? `Selected persisted Vanity CA ${shortAddress(selectedVanityCandidate.publicKey)}.`
        : persistedVanityCandidates.length
          ? `${persistedVanityCandidates.length} persisted Vanity CA option${persistedVanityCandidates.length === 1 ? '' : 's'} available.`
          : state.selectedVanityPublicKey
            ? `Selected Vanity CA ${shortAddress(state.selectedVanityPublicKey)} is preview-only or missing its saved secret; grind or select a persisted candidate from the desktop app.`
            : nativeVanityAvailable
            ? 'Native grinder is available.'
            : state.apiStatus === 'connected'
              ? 'Native grinder is not available in this local app.'
              : 'Connect the desktop app to verify the native grinder; file preview only shows the UI contract.',
      detail: 'Preserves Classic grinding with split start/end targets and selectable saved candidates.',
    },
    {
      id: 'token-config-parity',
      label: 'Token configuration parity',
      pass: tokenConfigEvidence,
      evidence: tokenConfig.ready
        ? hasCompletedLiveProof
          ? `Completed live proof minted ${shortAddress(proof?.token?.mint)} from the frozen token config.`
          : localApiLaunchPlanEvidence
            ? `Token ${tokenConfig.name} / ${tokenConfig.symbol} / ${tokenConfig.supply} is staged in the current local launch plan${tokenConfig.hasLogo ? ' with validated logo handoff' : ''}.`
            : state.apiStatus === 'connected'
              ? localApiLaunchPlan.stale
                ? `Token fields are valid, but the staged launch plan is stale for the ${localApiLaunchPlanStaleReason(localApiLaunchPlan)}; stage it again through the desktop app.`
                : localApiLaunchPlan.incomplete
                  ? `Token fields are valid, but the staged launch plan is incomplete: ${localApiLaunchPlanIncompleteReason(localApiLaunchPlan)}. Stage it again through the desktop app.`
                : 'Token fields are valid; stage the launch plan through the desktop app before replacing Classic token creation.'
              : 'Token fields are valid; connect the desktop app and stage the launch plan before replacing Classic token creation.'
        : tokenConfig.issues[0] || 'Token fields are not ready for Classic-compatible execution.',
      detail: 'Replaces Classic token name, symbol, supply, description, logo, and create-token payload validation.',
    },
    {
      id: 'charts-and-viewport',
      label: 'Charts and viewport smoke',
      pass: Boolean(chartRendererEvidence && viewportSmokeEvidence && chartModelEvidence),
      evidence: chartRendererEvidence && viewportSmokeEvidence && chartModelEvidence
        ? `Chart renderers are wired against the executable launch model. ${viewportSmokeDetail}`
        : chartRendererEvidence && viewportSmokeEvidence
          ? state.apiStatus === 'connected'
            ? localApiLaunchPlan.stale
              ? `Chart renderers and viewport smoke are ready, but the staged launch plan is stale for the ${localApiLaunchPlanStaleReason(localApiLaunchPlan)}; stage it again through the desktop app.`
              : localApiLaunchPlan.incomplete
                ? `Chart renderers and viewport smoke are ready, but the staged launch plan is incomplete: ${localApiLaunchPlanIncompleteReason(localApiLaunchPlan)}. Stage it again through the desktop app.`
                : 'Chart renderers and viewport smoke are ready; stage the launch plan through the desktop app so charts are bound to the executable token/pool model.'
            : 'Chart renderers and viewport smoke are ready; connect the desktop app and stage the launch plan so charts are bound to the executable token/pool model.'
        : chartRendererEvidence
          ? `Chart renderers are wired; ${viewportSmokeDetail}`
          : 'Tokenomics and liquidity chart renderers are missing.',
      detail: 'Tokenomics, liquidity depth, funding, and run progress render from the staged Trebuchet launch model.',
    },
    {
      id: 'pool-config-parity',
      label: 'Pool configuration parity',
      pass: poolConfigEvidence,
      evidence: plannedPools.length
        ? poolBlockerCount
          ? `${poolBlockerCount} blocking pool/topology issue${poolBlockerCount === 1 ? '' : 's'} must be resolved before parity.`
          : !hasCompletedLiveProof && !localApiLaunchPlanEvidence
            ? state.apiStatus === 'connected'
              ? localApiLaunchPlan.stale
                ? `Staged launch plan is stale for the ${localApiLaunchPlanStaleReason(localApiLaunchPlan)}; stage it again through the desktop app.`
                : localApiLaunchPlan.incomplete
                  ? `Staged launch plan is current, but incomplete: ${localApiLaunchPlanIncompleteReason(localApiLaunchPlan)}. Stage it again through the desktop app.`
                : 'Stage the launch plan through the desktop app before replacing Classic pool configuration.'
              : 'Connect the desktop app and stage a Classic-shaped launch plan before replacing Classic pool configuration.'
          : `${plannedPools.length} planned pool${plannedPools.length === 1 ? '' : 's'} available for proof comparison${poolWarningCount ? ` with ${poolWarningCount} warning${poolWarningCount === 1 ? '' : 's'}` : ''}.`
        : 'No planned pool rows are available for Classic comparison.',
      detail: 'Covers simple SOL, quote pools, slices, ladder bands, support positions, fee tiers, and Fee Key recipients.',
    },
    {
      id: 'funding-and-quote',
      label: 'Funding and quote readiness',
      pass: fundingEvidence,
      evidence: hasCompletedLiveProof
        ? 'Completed live proof shows the launch advanced through funded execution.'
        : !fundingEstimateEvidence
          ? fundingEstimateStatus.stale
            ? 'Classic funding estimate is stale for the current launch model; rerun the estimate before replacing Classic.'
          : 'Run the Classic funding estimate before replacing Classic.'
          : !fundingBalanceEvidence
            ? funding.walletBalanceStale
              ? 'Selected Trebuchet launch-wallet balance is stale; wait for the desktop app refresh or click Check balance.'
              : 'Verify the selected Trebuchet launch-wallet balance from the desktop app.'
            : !fundingSolEvidence
              ? `Launch wallet is short ${Number(funding.missingSol || 0).toFixed(3)} SOL.`
              : quoteStatus.stale
                ? 'Quote acquire job is stale for the selected wallet or current launch model; run it again.'
              : !quoteAcquireEvidence
                ? `${quoteRoutes.length} quote acquire route${quoteRoutes.length === 1 ? '' : 's'} still need successful completion.`
                : !manualPrefundEvidence
                  ? `Manual quote prefund is ${manualSummary.label}.`
                  : 'Classic funding estimate, wallet SOL, quote acquire, and manual prefund checks are ready.',
      detail: 'Replaces Classic funding estimate, quote acquire, wallet-balance, and manual quote prefund readiness.',
    },
    {
      id: 'held-reserve-backing',
      label: 'Held reserve backing',
      pass: heldReserveEvidence,
      evidence: !heldReserveConfigured
        ? 'No held reserve is configured.'
        : hasCompletedLiveProof
          ? reportArtifactSweepBound
            ? reportHeldReserveAudit
              ? reportHeldReserveAudit.state === 'pass'
                ? reportHeldReserveAudit.detail || 'Final report/dossier includes a passing held-reserve support audit.'
                : reportHeldReserveAudit.detail || 'Final report/dossier held-reserve audit is not passing.'
              : 'Final report/dossier is missing the held-reserve audit; regenerate it with report data v14 or newer.'
            : 'Attach a terminal-sweep-bound report or saved launch record before trusting held-reserve backing proof.'
          : currentHeldReserveAudit?.detail || 'Run the Classic funding estimate so Trebuchet can verify held-reserve support backing.',
      detail: 'Blocks unsafe preallocation or airdrop reserves unless support backing is visible in readiness and the final report proof.',
    },
    {
      id: 'run-and-resume',
      label: 'Run and resume safety',
      pass: resumeEvidence,
      evidence: hasCompletedLiveProof
        ? `Completed live proof includes guarded execution journal ${shortAddress(proof.journalId)}.`
        : proof && !proofJournalEvidence
          ? 'Completed launch record is missing its launch journal id.'
          : proof?.journalId && !matchingLocalJournal && proofFinalSweepEvidence
          ? 'Final sweep proof is attached, but the matching launch journal is not loaded locally.'
          : proofFinalSweepEvidence && localJournalEvidenceState.mismatches.length
            ? `Final sweep proof is attached, but the local launch journal does not match it: ${localJournalEvidenceState.mismatches.join(', ')}.`
          : proofFinalSweepEvidence && localJournalEvidenceState.missing.length
            ? `Final sweep proof is attached, but the local launch journal is missing proof backing: ${localJournalEvidenceState.missing.join(', ')}.`
          : proofFinalSweepEvidence && !proofTerminalJournalEvidence
          ? 'Final sweep proof is attached, but the launch journal has not reached transfer_completed.'
          : proofJournalEvidence && matchingLocalJournal && isTerminalJournal(matchingLocalJournal)
          ? 'Matching launch journal is terminal, but the proof is missing terminal final-sweep evidence.'
          : proofJournalEvidence && matchingLocalJournal && !journalHasRecoveryPlanningEvidence(matchingLocalJournal)
          ? `Journal ${shortAddress(proof.journalId)} is loaded, but it lacks pool-plan or checkpoint evidence needed to prove resume safety.`
          : proofJournalEvidence && matchingLocalJournal
          ? `Journal ${shortAddress(proof.journalId)} is loaded for the launch record.`
          : proofJournalEvidence
            ? `Launch record has journal ${shortAddress(proof.journalId)}, but the matching local journal is not loaded.`
            : localJournalEvidence
              ? `${localRecoveryJournal.count} active or failed launch journal${localRecoveryJournal.count === 1 ? '' : 's'} with pool-plan or checkpoint evidence loaded for recovery planning${localRecoveryJournal.failed ? ` (${localRecoveryJournal.failed} failed/partial)` : ''}.`
            : recoveryResultJournalEvidence
              ? 'A successful journal resume/recovery result is attached in this session.'
              : Number(state.recovery?.journalCount || 0) > 0
                ? 'Local launch history is loaded, but no active or failed journal exercises resume safety yet.'
              : state.apiStatus === 'connected'
                ? 'Local API is connected, but no launch journal or proof has exercised resume safety yet.'
                : 'Connect the desktop app and load a journal-backed proof.',
      detail: 'Keeps Classic journal recovery, resume-only-missing-work, and unsafe manual blockers visible.',
    },
    {
      id: 'sweep-report-proof',
      label: 'Sweep and report proof',
      pass: sweepReportEvidence,
      evidence: sweepReportEvidence
        ? 'Proof-bound report artifact and terminal final-sweep evidence are both attached.'
        : staleReportMissingSweepHash
          ? 'Report artifact is attached, but it is missing the terminal sweep evidence hash; regenerate it after final sweep.'
        : reportArtifact
          ? transferHasWalletEmptyFinalSweepEvidence(proof?.transfer)
            ? 'Report artifact is attached, but it is missing the terminal sweep evidence hash; regenerate it after final sweep.'
            : 'Report artifact is attached; terminal final-sweep evidence is still required.'
          : 'Publish or download a proof-bound report and complete the final sweep.',
      detail: 'Matches Classic report download/publish and transfer/sweep replacement criteria.',
    },
    {
      id: 'classic-artifact-comparison',
      label: 'Classic artifact comparison',
      pass: classicComparisonEvidence,
      evidence: classicComparisonEvidence
        ? `Classic comparison passed ${comparison.passCount || 0}/${comparison.fieldCount || 0} fields.`
        : comparisonIsV2Artifact
          ? 'Loaded artifact was generated by Trebuchet; use a completed Classic artifact.'
          : comparison?.status === 'pass' && !requiredComparisonEvidence.pass
            ? requiredComparisonEvidence.detail
          : comparison
            ? `Comparison is ${comparison.status}; rerun against the current completed proof.`
            : 'Compare a completed Classic artifact against the completed Trebuchet proof.',
      detail: 'Prevents retiring Classic on Trebuchet self-artifacts, stale comparisons, or partial proof matches.',
    },
    {
      id: 'proof-audit',
      label: 'Proof audit checklist',
      pass: audit?.status === 'pass',
      evidence: audit?.status === 'pass'
        ? `${audit.passCount || 0}/${audit.itemCount || 0} proof audit checks passing.`
        : `${audit?.missingCount || 0} missing and ${audit?.warnCount || 0} warning proof audit checks remain.`,
      detail: 'Ensures token, liquidity, lock/Fee Key, airdrop, recovery, report, sweep, and Classic comparison rows are all represented.',
    },
  ];
}

function validatedLocalViewportSmokeProof() {
  const proof = state.viewportSmoke;
  if (!proof || proof.passed !== true || proof.state !== 'valid') return null;
  if (proof.artifactVersion !== 1 || proof.kind !== 'trebuchet-v2-viewport-smoke') return null;
  const assetHashes = proof.assetHashes && typeof proof.assetHashes === 'object'
    ? proof.assetHashes
    : {};
  const hasRequiredHashes = V2_VIEWPORT_SMOKE_REQUIRED_ASSETS.every((file) => (
    typeof assetHashes[file] === 'string' && assetHashes[file].length >= 32
  ));
  const viewports = Array.isArray(proof.viewports) ? proof.viewports : [];
  const requiredViewportsPassed = ['desktop', 'mobile'].every((name) => (
    viewports.some((row) => {
      const checks = row?.checks && typeof row.checks === 'object' ? row.checks : {};
      return row?.name === name
        && row?.passed === true
        && V2_VIEWPORT_SMOKE_REQUIRED_CHECKS.every((check) => checks[check] === true);
    })
  ));
  return hasRequiredHashes && requiredViewportsPassed ? proof : null;
}

function replacementCriteriaById(criteria = []) {
  return new Map((Array.isArray(criteria) ? criteria : [])
    .filter((item) => item?.id)
    .map((item) => [item.id, item]));
}

function parityFeatureFromCriterion(feature, criterion, {
  passBadge = 'Evidence',
  warnBadge = 'Needs proof',
} = {}) {
  if (!criterion) {
    return {
      ...feature,
      state: feature.preview || feature.real ? 'warn' : 'danger',
      badge: feature.preview || feature.real ? warnBadge : 'Gap',
      detail: feature.preview || feature.real
        ? 'Replacement evidence is not available for this feature yet.'
        : feature.detail,
    };
  }
  return {
    ...feature,
    state: criterion.pass ? 'pass' : 'warn',
    badge: criterion.pass ? passBadge : warnBadge,
    detail: criterion.evidence || criterion.detail || feature.detail,
    criterionId: criterion.id,
  };
}

function renderReplacementCriteriaStrip(criteria = []) {
  const rows = Array.isArray(criteria) ? criteria : [];
  if (!rows.length) return '';
  return `
    <div class="criteria-strip" aria-label="Replacement criteria">
      ${rows.map((item) => {
        const pass = item.pass === true;
        const icon = pass ? 'fa-check' : 'fa-circle-exclamation';
        const title = item.detail || item.evidence || item.label || item.id;
        return `
          <span class="criteria-chip ${pass ? 'pass' : 'warn'}" title="${escapeHtml(title)}">
            <i class="fa-solid ${icon}" aria-hidden="true"></i>
            <strong>${escapeHtml(item.label || item.id)}</strong>
            <small>${pass ? 'Pass' : 'Needs proof'}</small>
          </span>
        `;
      }).join('')}
    </div>
  `;
}

function renderClassicRetirementProofRail(retirementGate = {}) {
  const requirements = Array.isArray(retirementGate.requirements) ? retirementGate.requirements : [];
  if (!requirements.length) return '';
  const labelById = {
    'live-proof': 'Live launch',
    'report-proof': 'Report',
    'classic-comparison': 'Classic artifact',
    audit: 'Audit',
    'replacement-criteria': 'Criteria',
  };
  return `
    <div class="field-proof-rail ${retirementGate.state === 'pass' ? 'pass' : 'danger'}" aria-label="Classic retirement proof path">
      <div class="field-proof-head">
        <span>Field parity</span>
        <strong>${Number(retirementGate.passCount || 0)}/${Number(retirementGate.itemCount || requirements.length)}</strong>
      </div>
      <div class="field-proof-steps">
        ${requirements.map((item, index) => {
          const pass = item.pass === true;
          const stateClass = pass ? 'pass' : 'wait';
          const icon = pass ? 'fa-check' : 'fa-circle';
          const label = labelById[item.id] || item.title || item.id || `Step ${index + 1}`;
          const detail = item.detail || label;
          return `
            <span class="field-proof-step ${stateClass}" title="${escapeHtml(detail)}">
              <i class="fa-solid ${icon}" aria-hidden="true"></i>
              <strong>${escapeHtml(label)}</strong>
              <small>${pass ? 'Proof' : 'Wait'}</small>
            </span>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderParityPanel() {
  const proof = currentLaunchProof();
  const config = proofConfigForFingerprint(proof, currentLaunchConfig());
  const reportAudit = buildV2ReportParityAudit(proof, config);
  const retirementGate = buildClassicRetirementGate(proof, reportAudit, config);
  const criteriaById = replacementCriteriaById(retirementGate.replacementCriteria);
  const liveProofPassed = retirementGate.requirements
    .find((item) => item.id === 'live-proof')?.pass === true;
  const rows = parityFeatures.map((feature) => {
    if (feature.id === 'wallet') {
      return parityFeatureFromCriterion(feature, criteriaById.get('wallet-lifecycle'));
    }
    if (feature.id === 'recovery') {
      return parityFeatureFromCriterion(feature, criteriaById.get('run-and-resume'), {
        passBadge: 'Journal',
      });
    }
    if (feature.id === 'charts') {
      return parityFeatureFromCriterion(feature, criteriaById.get('charts-and-viewport'), {
        passBadge: 'Smoke',
      });
    }
    if (feature.id === 'grinder') {
      return parityFeatureFromCriterion(feature, criteriaById.get('vanity-options'), {
        passBadge: 'Options',
      });
    }
    if (feature.id === 'token') {
      return parityFeatureFromCriterion(feature, criteriaById.get('token-config-parity'), {
        passBadge: 'Model',
      });
    }
    if (feature.id === 'funding') {
      const fundingCriterion = criteriaById.get('funding-and-quote');
      const heldReserveCriterion = criteriaById.get('held-reserve-backing');
      return parityFeatureFromCriterion(feature, fundingCriterion?.pass && heldReserveCriterion && !heldReserveCriterion.pass
        ? heldReserveCriterion
        : fundingCriterion, {
        passBadge: 'Ready',
      });
    }
    if (feature.id === 'pool-model') {
      return parityFeatureFromCriterion(feature, criteriaById.get('pool-config-parity'));
    }
    if (feature.id === 'execution') {
      const demoExecutionReady = state.apiStatus === 'connected' && state.demoActive;
      const realBridgeReady = state.apiStatus === 'connected'
        && !state.demoActive
        && state.executionReadiness?.status === 'ready'
        && state.executionReadiness?.nextEndpoint;
      return {
        ...feature,
        state: liveProofPassed ? 'pass' : 'warn',
        badge: liveProofPassed ? 'Live proof' : state.lastRealExecution ? 'In progress' : state.lastDemoLaunchRun ? 'Demo only' : demoExecutionReady ? 'Demo ready' : realBridgeReady ? 'Ready' : 'Bridge',
        detail: liveProofPassed
          ? 'A non-demo launch record has token, liquidity, and final sweep evidence.'
          : state.lastRealExecution
            ? `${state.lastRealExecution.action || 'Classic operation'} completed; keep running until token, liquidity, and final sweep proof are all present.`
            : state.lastDemoLaunchRun
              ? `Test launch completed for ${shortAddress(state.lastDemoLaunchRun.token?.tokenMint)}; live parity still needs a real proof.`
              : demoExecutionReady
                ? 'Trebuchet can run the complete demo token, LP, and sweep path; real launch routing remains guarded.'
                : realBridgeReady
                  ? `Next real classic operation is ${state.executionReadiness.nextEndpoint}.`
                  : 'Trebuchet stages decoded local run envelopes and dispatches real work only after readiness confirmation.',
      };
    }
    if (feature.id === 'sweep-report') {
      return parityFeatureFromCriterion(feature, criteriaById.get('sweep-report-proof'));
    }
    return {
      ...feature,
      state: feature.preview || feature.real ? 'warn' : 'danger',
      badge: feature.preview || feature.real ? 'Needs proof' : 'Gap',
      detail: feature.preview || feature.real
        ? 'Replacement evidence is not available for this feature yet.'
        : feature.detail,
    };
  });
  const visibleRows = rows.filter((item) => ['wallet', 'grinder', 'token', 'pool-model', 'funding', 'execution', 'recovery'].includes(item.id));
  const missingCount = rows.filter((item) => item.state === 'danger').length;
  const previewCount = rows.filter((item) => item.state === 'warn').length;
  const retirementIcon = retirementGate.state === 'pass' ? 'fa-check' : 'fa-ban';
  const fieldVerification = buildV2FieldVerification({
    proof,
    config,
    audit: reportAudit,
    retirementGate,
  });
  const finalSweepComplete = transferHasWalletEmptyFinalSweepEvidence(proof?.transfer);
  const operationalTitle = finalSweepComplete ? 'Launch record saved' : 'Finish the launch first';
  const operationalDetail = finalSweepComplete
    ? 'The operational launch is complete. Open the release proof audit only when preparing to retire the older workflow.'
    : state.launchWorkspace === 'mint'
      ? 'Finish the existing token, then continue to liquidity. Release-comparison checks are not launch blockers.'
      : state.launchWorkspace === 'liquidity'
        ? 'Create and lock the configured liquidity positions. Release-comparison checks are not launch blockers.'
        : state.launchWorkspace === 'finish'
          ? 'Complete the sweep and save the launch record. Release-comparison checks are secondary.'
          : 'Continue the six launch phases. Release-comparison checks stay collapsed until you need them.';

  // Release-comparison evidence is useful only after the operational launch
  // is complete. Showing its warnings during Phase 6 made optional retirement
  // checks look like unsatisfied launch blockers and pushed the actual sweep
  // authorization below the fold.
  if (!finalSweepComplete) {
    $('#parityPanel').innerHTML = `
      <div class="parity-summary launch-audit-deferred">
        <span>
          <strong>${escapeHtml(operationalTitle)}</strong>
          <small>${escapeHtml(operationalDetail)}</small>
        </span>
        ${state.launchWorkspace === 'finish'
          ? '<button class="secondary-button compact" type="button" data-launch-workspace="finish"><span>Return to final sweep</span><i class="fa-solid fa-arrow-up"></i></button>'
          : '<span class="risk-badge">Non-blocking audit hidden</span>'}
      </div>`;
    return;
  }

  $('#parityPanel').innerHTML = `
    <div class="parity-summary">
      <strong>${escapeHtml(operationalTitle)}</strong>
      <span>${escapeHtml(operationalDetail)}</span>
    </div>
    <details class="drawer release-proof-details">
      <summary>
        <span>Optional release proof audit</span>
        <strong>${fieldVerification.passCount}/${fieldVerification.itemCount} core checks · ${missingCount + previewCount} open</strong>
      </summary>
      <article class="parity-row parity-gate ${retirementGate.state}">
        <i class="fa-solid ${retirementIcon}" aria-hidden="true"></i>
        <span>
          <h3>${escapeHtml(retirementGate.state === 'pass' ? 'Release evidence complete' : 'Release evidence incomplete')}</h3>
          <p>${retirementGate.passCount}/${retirementGate.itemCount} proof checks passing. This audit does not block completing the active launch.</p>
        </span>
        <span class="risk-badge ${retirementGate.state === 'danger' ? 'danger' : ''}">${escapeHtml(retirementGate.badge)}</span>
      </article>
      ${renderClassicRetirementProofRail(retirementGate)}
      ${renderReplacementCriteriaStrip(retirementGate.replacementCriteria)}
      ${visibleRows.map((item) => {
        const icon = item.state === 'pass' ? 'fa-check' : item.state === 'warn' ? 'fa-triangle-exclamation' : 'fa-screwdriver-wrench';
        const badgeClass = item.state === 'danger' ? 'danger' : item.state === 'warn' ? 'warn' : '';
        return `
          <article class="parity-row ${item.state}">
            <i class="fa-solid ${icon}" aria-hidden="true"></i>
            <span>
              <h3>${escapeHtml(item.title)}</h3>
              <p>${escapeHtml(item.detail)}</p>
            </span>
            <span class="risk-badge ${badgeClass}">${escapeHtml(item.badge)}</span>
          </article>
        `;
      }).join('')}
    </details>`;
}
