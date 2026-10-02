function buildReportPreview() {
  const config = currentLaunchConfig();
  return {
    generatedAt: new Date().toISOString(),
    token: config.token,
    vanity: config.vanity,
    poolTopology: config.poolTopology,
    walletPublicKey: selectedLaunchWalletPublicKey(),
  };
}

function demoRunLaunchConfig(run = state.lastDemoLaunchRun) {
  const fallback = typeof currentLaunchConfig === 'function'
    ? currentLaunchConfig()
    : { token: {}, poolTopology: {} };
  const plan = run?.readiness?.plan && typeof run.readiness.plan === 'object'
    ? run.readiness.plan
    : null;
  if (!plan) return fallback;
  return {
    ...fallback,
    token: plan.token || fallback.token || {},
    vanity: plan.vanity || fallback.vanity || {},
    poolTopology: plan.poolTopology || fallback.poolTopology || {},
    recovery: plan.recovery || fallback.recovery || {},
    launchSol: plan.funding?.launchSol ?? fallback.launchSol,
    mode: plan.mode || fallback.mode || 'guarded',
  };
}

function proofFromDemoRun() {
  if (!state.lastDemoLaunchRun) return null;
  const config = demoRunLaunchConfig(state.lastDemoLaunchRun);
  const token = state.lastDemoLaunchRun.token || null;
  const liquidity = state.lastDemoLaunchRun.liquidity || {};
  const transfer = state.lastDemoLaunchRun.transfer || null;
  const results = Array.isArray(liquidity.results) ? liquidity.results : [];
  const airdrop = transfer?.airdrop || null;
  const plannedAirdropRows = Array.isArray(config?.poolTopology?.airdrop?.recipients)
    ? config.poolTopology.airdrop.recipients
    : [];
  const plannedAirdropCount = Math.max(
    Math.max(0, Math.floor(Number(config?.poolTopology?.airdrop?.recipientCount || 0))),
    plannedAirdropRows.length,
  );
  return {
    source: 'demo-run',
    journalId: state.lastDemoLaunchRun.id || null,
    status: 'completed',
    stage: 'demo_completed',
    readiness: state.lastDemoLaunchRun.readiness || null,
    walletPublicKey: state.lastDemoLaunchRun.walletPublicKey || selectedLaunchWalletPublicKey(),
    updatedAt: state.lastDemoLaunchRun.completedAt || null,
    token: token ? {
      mint: token.tokenMint || token.mint || null,
      name: token.name || config.token.name,
      symbol: token.symbol || config.token.symbol,
      decimals: token.decimals ?? config.token.decimals,
      totalSupply: token.totalSupply ?? config.token.supply,
      metadataUri: token.metadataUri || null,
      imageUri: token.imageUri || null,
      mintAuthorityRenounced: token.mintAuthorityRenounced === true,
      freezeAuthorityDisabled: token.freezeAuthorityDisabled === true,
      metadataUpdateAuthorityRevoked: token.metadataUpdateAuthorityRevoked === true,
      metadataImmutable: token.metadataImmutable === true,
    } : null,
    launchConfig: config,
    liquidity: {
      complete: results.length > 0,
      poolCount: results.length,
      poolIds: results.map((pool) => pool.poolId).filter(Boolean),
      positions: { main: 0, ladder: 0, support: 0, bootstrap: 0 },
      lockedPositionCount: 0,
      feeKeyCount: 0,
      results,
    },
    airdrop: {
      plannedRecipientCount: plannedAirdropCount,
      deliveredCount: Array.isArray(airdrop?.transferred) ? airdrop.transferred.length : 0,
      failedCount: Array.isArray(airdrop?.failed) ? airdrop.failed.length : 0,
      transferred: Array.isArray(airdrop?.transferred) ? airdrop.transferred : [],
      failed: Array.isArray(airdrop?.failed) ? airdrop.failed : [],
      recipients: plannedAirdropRows,
      tokenMint: token?.tokenMint || token?.mint || null,
      tokenDecimals: token?.decimals ?? config.token.decimals,
    },
    reportPublish: null,
    transfer,
    destinationWallet: transfer?.destinationWallet || config?.poolTopology?.sweepDestination || null,
    canPublishReport: Boolean(token?.tokenMint || token?.mint) && results.length > 0,
    canRunAirdrop: false,
    canRetryAirdrop: false,
    canSweep: false,
  };
}

function currentLaunchProof() {
  return state.launchProof || state.executionReadiness?.proof || proofFromDemoRun();
}

// Single source of truth for "is this proof from a simulated run?".
// proofFromDemoRun() stamps `source` and `stage` but never `demo`, so any check
// that reads only `proof.demo` mislabels a Practice-mode run as live proof.
function isDemoLaunchProof(proof) {
  return proof?.source === 'demo-run'
    || proof?.demo === true
    || proof?.stage === 'demo_completed';
}

function proofTokenMint(proof) {
  return String(proof?.token?.mint || proof?.tokenMint || '').trim();
}

function proofJournalId(proof) {
  return String(proof?.journalId || '').trim();
}

function proofWalletPublicKey(proof) {
  return String(proof?.walletPublicKey || '').trim();
}

function journalTokenMint(journal = {}) {
  return String(journal?.token?.mint || journal?.token?.tokenMint || journal?.poolPlan?.tokenMint || '').trim();
}

function proofTokenJournalEvidenceState(proof = {}, journal = {}) {
  const fields = [
    ['mintAuthorityRenounced', 'mint authority'],
    ['freezeAuthorityDisabled', 'freeze authority'],
    ['metadataUpdateAuthorityRevoked', 'metadata update authority'],
    ['metadataImmutable', 'metadata immutability'],
  ];
  const missing = [];
  const mismatches = [];
  const proofToken = proof?.token || {};
  const journalToken = journal?.token || {};
  fields.forEach(([field, label]) => {
    if (proofToken?.[field] !== true) return;
    if (!journalToken || typeof journalToken !== 'object' || typeof journalToken[field] !== 'boolean') {
      missing.push(`journal token authority ${label}`);
      return;
    }
    if (journalToken[field] !== true) mismatches.push(`token authority ${label}`);
  });
  return { missing, mismatches };
}

function normalizedProofStringSet(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
    .sort();
}

function launchProofPoolIds(proof = {}) {
  const results = Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results : [];
  return normalizedProofStringSet([
    ...(Array.isArray(proof?.liquidity?.poolIds) ? proof.liquidity.poolIds : []),
    ...results.map((pool) => pool?.poolId || pool?.id),
  ]);
}

function launchJournalLiquidityResults(journal = {}) {
  return typeof journalPriorResults === 'function'
    ? journalPriorResults(journal)
    : journalResultList(journal);
}

function launchJournalPoolIds(journal = {}) {
  return normalizedProofStringSet(launchJournalLiquidityResults(journal).map((pool) => pool?.poolId || pool?.id));
}

function sameProofStringSet(left = [], right = []) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function launchPoolFingerprints(results = []) {
  return (Array.isArray(results) ? results : [])
    .map((pool) => JSON.stringify({
      poolId: pool?.poolId || pool?.id || null,
      quoteMint: pool?.quoteMint || pool?.quoteAddress || null,
      supplyPercent: numberOrNull(pool?.supplyPercent),
      tickSpacing: numberOrNull(pool?.tickSpacing),
      initialPrice: pool?.initialPrice == null ? null : String(pool.initialPrice),
      launchedSide: pool?.launchedSide || null,
      createPoolTx: pool?.createPoolTx || pool?.txIds?.createPool || null,
    }))
    .sort();
}

function launchResultPositionCount(results = [], fallback = 0) {
  const aggregate = (Array.isArray(results) ? results : [])
    .reduce((sum, pool) => sum + Number(pool?.positionCount || pool?.totalPositions || 0), 0);
  const explicit = Number(fallback || 0);
  return Math.max(
    proofPositions(results),
    Number.isFinite(aggregate) ? aggregate : 0,
    Number.isFinite(explicit) ? explicit : 0,
  );
}

function launchPositionFingerprints(results = []) {
  return comparisonPositionFingerprint(comparisonPositionsFromPools(results))
    .map((position) => JSON.stringify(position));
}

function proofLiquidityJournalEvidenceState(proof = {}, journal = {}) {
  const proofResults = Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results : [];
  const journalResults = launchJournalLiquidityResults(journal);
  const missing = [];
  const mismatches = [];
  const proofPoolRows = launchPoolFingerprints(proofResults);
  const journalPoolRows = launchPoolFingerprints(journalResults);
  if (proofPoolRows.length && !journalPoolRows.length) {
    missing.push('journal pool records');
  } else if (proofPoolRows.length && journalPoolRows.length && !sameProofStringSet(proofPoolRows, journalPoolRows)) {
    mismatches.push('pool records');
  }

  const proofPositionCount = launchResultPositionCount(proofResults, proof?.liquidity?.positionCount);
  const journalPositionCount = launchResultPositionCount(journalResults);
  if (proofPositionCount > 0) {
    if (journalPositionCount <= 0) missing.push('journal positions');
    else if (journalPositionCount !== proofPositionCount) mismatches.push('position count');
  }

  const proofPositionsFingerprint = launchPositionFingerprints(proofResults);
  const journalPositionsFingerprint = launchPositionFingerprints(journalResults);
  if (proofPositionsFingerprint.length && !journalPositionsFingerprint.length) {
    missing.push('journal position records');
  } else if (
    proofPositionsFingerprint.length
    && journalPositionsFingerprint.length
    && !sameProofStringSet(proofPositionsFingerprint, journalPositionsFingerprint)
  ) {
    mismatches.push('position records');
  }

  const proofLocked = Math.max(Number(proof?.liquidity?.lockedPositionCount || 0), proofLockedPositionCount(proofResults));
  const journalLocked = proofLockedPositionCount(journalResults);
  if (proofLocked > 0) {
    if (journalLocked <= 0) missing.push('journal lock proof');
    else if (journalLocked !== proofLocked) mismatches.push('lock count');
  }

  const proofFeeKeys = Math.max(Number(proof?.liquidity?.feeKeyCount || 0), proofFeeKeyCount(proofResults));
  const journalFeeKeys = proofFeeKeyCount(journalResults);
  if (proofFeeKeys > 0) {
    if (journalFeeKeys <= 0) missing.push('journal Fee Key proof');
    else if (journalFeeKeys !== proofFeeKeys) mismatches.push('Fee Key count');
  }

  const proofLockSummary = v2ReportLockSummary(proofResults);
  if (Number(proofLockSummary.totalRecipient || 0) > 0) {
    const journalLockSummary = v2ReportLockSummary(journalResults);
    if (Number(journalLockSummary.totalRecipient || 0) <= 0) {
      missing.push('journal Fee Key recipients');
    } else if (Number(journalLockSummary.totalRecipient || 0) !== Number(proofLockSummary.totalRecipient || 0)) {
      mismatches.push('Fee Key recipient count');
    }
    if (Number(proofLockSummary.transferred || 0) > 0) {
      if (Number(journalLockSummary.transferred || 0) <= 0) {
        missing.push('journal Fee Key transfers');
      } else if (Number(journalLockSummary.transferred || 0) !== Number(proofLockSummary.transferred || 0)) {
        mismatches.push('Fee Key transfer count');
      }
    }
  }

  return { missing, mismatches };
}

function launchAirdropRows(airdrop = {}, key = 'transferred') {
  return Array.isArray(airdrop?.[key]) ? airdrop[key] : [];
}

function launchAirdropCount(airdrop = {}, key = 'deliveredCount', fallbackRows = []) {
  const value = Number(airdrop?.[key]);
  return Number.isFinite(value) ? Math.max(0, value) : fallbackRows.length;
}

function launchAirdropWalletSet(rows = []) {
  return normalizedProofStringSet((Array.isArray(rows) ? rows : [])
    .map((row) => row?.wallet || row?.recipient || row?.address));
}

function launchAirdropTxSet(rows = []) {
  return normalizedProofStringSet((Array.isArray(rows) ? rows : [])
    .map((row) => row?.txId || row?.signature || row?.tx));
}

function proofAirdropJournalEvidenceState(proof = {}, journal = {}) {
  const proofAirdrop = proof?.airdrop || {};
  const journalAirdrop = journal?.airdrop || {};
  const proofTransferred = launchAirdropRows(proofAirdrop, 'transferred');
  const proofFailedRows = launchAirdropRows(proofAirdrop, 'failed');
  const proofRecipients = launchAirdropRows(proofAirdrop, 'recipients');
  const proofDelivered = launchAirdropCount(proofAirdrop, 'deliveredCount', proofTransferred);
  const proofFailed = launchAirdropCount(proofAirdrop, 'failedCount', proofFailedRows);
  const planned = Math.max(
    launchAirdropCount(proofAirdrop, 'plannedRecipientCount', proofRecipients),
    proofRecipients.length,
    proofDelivered + proofFailed,
  );
  const missing = [];
  const mismatches = [];
  if (planned <= 0) return { required: false, missing, mismatches };

  const journalTransferred = launchAirdropRows(journalAirdrop, 'transferred');
  const journalFailedRows = launchAirdropRows(journalAirdrop, 'failed');
  const journalDelivered = journalTransferred.length;
  const journalFailed = journalFailedRows.length;
  if (!journalAirdrop || typeof journalAirdrop !== 'object' || (!journalDelivered && !journalFailed)) {
    missing.push('journal airdrop');
    return { required: true, missing, mismatches };
  }
  if (proofDelivered !== journalDelivered || proofFailed !== journalFailed) {
    mismatches.push('airdrop counts');
  }

  const proofWallets = launchAirdropWalletSet(proofTransferred);
  const journalWallets = launchAirdropWalletSet(journalTransferred);
  if (proofWallets.length && !journalWallets.length) {
    missing.push('journal airdrop recipients');
  } else if (proofWallets.length && journalWallets.length && !sameProofStringSet(proofWallets, journalWallets)) {
    mismatches.push('airdrop recipients');
  }

  const proofTxs = launchAirdropTxSet(proofTransferred);
  const journalTxs = launchAirdropTxSet(journalTransferred);
  if (proofTxs.length && !journalTxs.length) {
    missing.push('journal airdrop transactions');
  } else if (proofTxs.length && journalTxs.length && !sameProofStringSet(proofTxs, journalTxs)) {
    mismatches.push('airdrop transactions');
  }

  return { required: true, missing, mismatches };
}

function proofMatchingLocalLaunchJournal(proof = currentLaunchProof()) {
  const journalId = proofJournalId(proof);
  if (!journalId) return null;
  const journals = Array.isArray(state.recovery?.journals) ? state.recovery.journals : [];
  const proofWallet = proofWalletPublicKey(proof);
  const proofMint = proofTokenMint(proof);
  return journals.find((journal) => {
    if (String(journal?.id || '').trim() !== journalId) return false;
    const journalWallet = String(journal?.walletPublicKey || '').trim();
    if (proofWallet && journalWallet && proofWallet !== journalWallet) return false;
    const mint = journalTokenMint(journal);
    if (proofMint && mint && proofMint !== mint) return false;
    return true;
  }) || null;
}

function proofJournalEvidenceState(proof = currentLaunchProof()) {
  const journal = proofMatchingLocalLaunchJournal(proof);
  const missing = [];
  const mismatches = [];
  if (!proofJournalId(proof)) missing.push('journal id');
  if (!journal) {
    if (proofJournalId(proof)) missing.push('local journal');
    return { journal: null, backed: false, missing, mismatches };
  }

  const proofPoolIds = launchProofPoolIds(proof);
  const journalPoolIds = launchJournalPoolIds(journal);
  if (proofPoolIds.length && !journalPoolIds.length) {
    missing.push('journal pool ids');
  } else if (proofPoolIds.length && journalPoolIds.length && !sameProofStringSet(proofPoolIds, journalPoolIds)) {
    mismatches.push('pool ids');
  }

  const proofTransfer = proof?.transfer || null;
  const journalTransfer = journal?.transfer || null;
  const proofSweepComplete = transferHasFinalSweepEvidence(proofTransfer);
  const proofTerminalSweepComplete = transferHasWalletEmptyFinalSweepEvidence(proofTransfer);
  const journalTerminalSweepComplete = journalTransferHasTerminalSweepEvidence(journalTransfer);
  const proofDestination = String(proofTransfer?.destinationWallet || proof?.destinationWallet || '').trim();
  const journalDestination = String(journalTransfer?.destinationWallet || '').trim();
  if (proofSweepComplete) {
    if (!journalTransfer || typeof journalTransfer !== 'object') {
      missing.push('journal sweep transfer');
    } else if (!journalTerminalSweepComplete) {
      missing.push('terminal journal sweep');
    }
    if (proofDestination && !journalDestination) missing.push('journal return wallet');
    const tokenEvidence = proofTokenJournalEvidenceState(proof, journal);
    missing.push(...tokenEvidence.missing);
    mismatches.push(...tokenEvidence.mismatches);
    const liquidityEvidence = proofLiquidityJournalEvidenceState(proof, journal);
    missing.push(...liquidityEvidence.missing);
    mismatches.push(...liquidityEvidence.mismatches);
	    const airdropEvidence = proofAirdropJournalEvidenceState(proof, journal);
	    missing.push(...airdropEvidence.missing);
	    mismatches.push(...airdropEvidence.mismatches);
	  }
  if (
    proofTerminalSweepComplete
    && journalTerminalSweepComplete
    && (!proofDestination || !journalDestination || proofDestination === journalDestination)
  ) {
    const transferEvidence = proofTransferJournalEvidenceState(proofTransfer, journalTransfer);
    missing.push(...transferEvidence.missing);
    mismatches.push(...transferEvidence.mismatches);
  }
	  if (proofDestination && journalDestination && proofDestination !== journalDestination) {
	    mismatches.push('return wallet');
	  }

  return {
    journal,
    backed: missing.length === 0 && mismatches.length === 0,
    missing,
    mismatches,
    proofPoolIds,
    journalPoolIds,
  };
}

function sameLaunchProofIdentity(existing, incoming) {
  if (!existing || !incoming || existing.source === 'demo-run' || incoming.source === 'demo-run') return false;
  const existingMint = proofTokenMint(existing);
  const incomingMint = proofTokenMint(incoming);
  const existingJournal = proofJournalId(existing);
  const incomingJournal = proofJournalId(incoming);
  const existingWallet = proofWalletPublicKey(existing);
  const incomingWallet = proofWalletPublicKey(incoming);
  if (existingWallet && incomingWallet && existingWallet !== incomingWallet) return false;
  if (existingJournal && incomingJournal && existingJournal !== incomingJournal) return false;
  if (existingMint && incomingMint) return existingMint === incomingMint;
  if (existingJournal && incomingJournal) return existingJournal === incomingJournal;
  return Boolean(existingWallet && incomingWallet && existingWallet === incomingWallet && (existingMint || incomingMint));
}

function proofAirdropHasDelivery(airdrop = {}) {
  return Boolean(
    Number(airdrop?.deliveredCount || 0) > 0
      || Number(airdrop?.failedCount || 0) > 0
      || (Array.isArray(airdrop?.transferred) && airdrop.transferred.length > 0)
      || (Array.isArray(airdrop?.failed) && airdrop.failed.length > 0),
  );
}

function mergeProofAirdropEvidence(existing = null, incoming = null) {
  if (!existing) return incoming || null;
  if (!incoming) return existing;
  const merged = { ...existing, ...incoming };
  if (!Array.isArray(incoming.recipients) && Array.isArray(existing.recipients)) {
    merged.recipients = existing.recipients;
  }
  if (!incoming.tokenMint && existing.tokenMint) merged.tokenMint = existing.tokenMint;
  if (incoming.tokenDecimals == null && existing.tokenDecimals != null) {
    merged.tokenDecimals = existing.tokenDecimals;
  }
  if (!proofAirdropHasDelivery(incoming) && proofAirdropHasDelivery(existing)) {
    merged.deliveredCount = existing.deliveredCount;
    merged.failedCount = existing.failedCount;
    merged.transferred = Array.isArray(existing.transferred) ? existing.transferred : [];
    merged.failed = Array.isArray(existing.failed) ? existing.failed : [];
  }
  return merged;
}

function proofReportArtifactFinalizesDestination(proof = {}, fallbackConfig = currentLaunchConfig()) {
  if (!proof || typeof proof !== 'object') return false;
  const proofConfig = proof.launchConfig && typeof proof.launchConfig === 'object'
    ? proof.launchConfig
    : fallbackConfig;
  const report = proof.reportPublish || null;
  const localDossier = proof.localDossier || null;
  return Boolean(
    !reportPublishFinalizationIssue(report, proof, proofConfig)
      || !localDossierFinalizationIssue(localDossier, proof, proofConfig)
  );
}

function mergeLaunchConfigSnapshot(existing = null, incoming = null, existingProof = {}, incomingProof = {}) {
  const base = existing && typeof existing === 'object'
    ? existing
    : incoming && typeof incoming === 'object'
      ? incoming
      : null;
  if (!base) return null;
  const merged = {
    ...base,
    token: { ...(base.token || {}) },
    poolTopology: { ...(base.poolTopology || {}) },
  };
  const incomingDestination = String(
    incomingProof?.transfer?.destinationWallet
    || incomingProof?.destinationWallet
    || incoming?.poolTopology?.sweepDestination
    || '',
  ).trim();
  const existingDestination = String(merged.poolTopology.sweepDestination || '').trim();
  const existingDestinationFinalized = Boolean(
    proofReportArtifactFinalizesDestination(existingProof, existing)
    || transferHasFinalSweepEvidence(existingProof?.transfer)
  );
  const incomingDestinationFinalized = Boolean(
    proofReportArtifactFinalizesDestination(incomingProof, incoming)
    || transferHasFinalSweepEvidence(incomingProof?.transfer)
  );
  if (incomingDestination && (!existingDestination || !existingDestinationFinalized || incomingDestinationFinalized)) {
    merged.poolTopology.sweepDestination = incomingDestination;
  }
  return merged;
}

function classicComparisonResultObject(comparison = null) {
  if (!comparison || typeof comparison !== 'object') return null;
  if (
    comparison.status
    || comparison.proofFingerprint
    || Array.isArray(comparison.rows)
    || Number(comparison.fieldCount || 0) > 0
  ) {
    return comparison;
  }
  return null;
}

function reportParityClassicComparison(reportParity = null) {
  if (!reportParity || typeof reportParity !== 'object') return null;
  const comparison = classicComparisonResultObject(reportParity.comparison);
  if (comparison) return comparison;
  const classicComparison = classicComparisonResultObject(reportParity.classicComparison);
  if (classicComparison) return classicComparison;
  return null;
}

function currentClassicComparisonForProof(proof = currentLaunchProof(), config = currentLaunchConfig()) {
  const normalizedComparison = normalizeClassicReportComparison(state.classicReportComparison).result;
  const proofComparison = reportParityClassicComparison(proof?.reportParity);
  if (normalizedComparison && classicComparisonMatchesProof(normalizedComparison, proof, config)) {
    return normalizedComparison;
  }
  if (proofComparison && classicComparisonMatchesProof(proofComparison, proof, config)) {
    return proofComparison;
  }
  return normalizedComparison || proofComparison || null;
}

function pruneLaunchProofReportParity(reportParity = null, proof = currentLaunchProof(), config = currentLaunchConfig()) {
  if (!reportParity || typeof reportParity !== 'object') return null;
  const cleaned = { ...reportParity };
  const comparison = classicComparisonResultObject(cleaned.comparison);
  const classicComparison = classicComparisonResultObject(cleaned.classicComparison);
  if (Object.prototype.hasOwnProperty.call(cleaned, 'comparison') && !comparison) delete cleaned.comparison;
  else if (comparison && !classicComparisonMatchesProof(comparison, proof, config)) delete cleaned.comparison;
  if (Object.prototype.hasOwnProperty.call(cleaned, 'classicComparison') && !classicComparison) delete cleaned.classicComparison;
  else if (classicComparison && !classicComparisonMatchesProof(classicComparison, proof, config)) delete cleaned.classicComparison;
  if (!cleaned.comparison && cleaned.classicComparison) cleaned.comparison = cleaned.classicComparison;
  if (!reportParityClassicComparison(cleaned) && cleaned.classicArtifactCompared) {
    cleaned.classicArtifactCompared = false;
    cleaned.comparedAt = null;
  }
  return Object.keys(cleaned).length ? cleaned : null;
}

function pruneLaunchProofReportParityForExport(reportParity = null, proof = currentLaunchProof(), config = currentLaunchConfig()) {
  const cleaned = pruneLaunchProofReportParity(reportParity, proof, config);
  if (!cleaned || typeof cleaned !== 'object') return cleaned;
  const comparison = classicComparisonResultObject(cleaned.comparison);
  const classicComparison = classicComparisonResultObject(cleaned.classicComparison);
  if (comparison && !classicComparisonIsRetirementGrade(comparison, proof, config)) delete cleaned.comparison;
  if (classicComparison && !classicComparisonIsRetirementGrade(classicComparison, proof, config)) delete cleaned.classicComparison;
  if (!cleaned.comparison && cleaned.classicComparison) cleaned.comparison = cleaned.classicComparison;
  if (!reportParityClassicComparison(cleaned) && cleaned.classicArtifactCompared) {
    cleaned.classicArtifactCompared = false;
    cleaned.comparedAt = null;
  }
  return Object.keys(cleaned).length ? cleaned : null;
}

function pruneLaunchProofEvidenceArtifacts(proof = null, config = currentLaunchConfig()) {
  if (!proof || typeof proof !== 'object') return proof;
  const cleaned = { ...proof };
  if (cleaned.reportPublish && !reportPublishIsProofCurrent(cleaned.reportPublish, cleaned, config)) {
    delete cleaned.reportPublish;
  }
  if (cleaned.localDossier && !localDossierIsProofCurrent(cleaned.localDossier, cleaned, config)) {
    delete cleaned.localDossier;
  }
  if (cleaned.reportParity && typeof cleaned.reportParity === 'object') {
    const reportParity = pruneLaunchProofReportParity(cleaned.reportParity, cleaned, config);
    if (reportParity) cleaned.reportParity = reportParity;
    else delete cleaned.reportParity;
  }
  return cleaned;
}

function pruneLaunchProofEvidenceArtifactsForExport(proof = null, config = currentLaunchConfig()) {
  const cleaned = pruneLaunchProofEvidenceArtifacts(proof, config);
  if (!cleaned || typeof cleaned !== 'object') return cleaned;
  if (cleaned.reportParity && typeof cleaned.reportParity === 'object') {
    const reportParity = pruneLaunchProofReportParityForExport(cleaned.reportParity, cleaned, config);
    if (reportParity) cleaned.reportParity = reportParity;
    else delete cleaned.reportParity;
  }
  return cleaned;
}

function mergeLaunchProofEvidence(existing, incoming) {
  if (!incoming || typeof incoming !== 'object') return null;
  if (!sameLaunchProofIdentity(existing, incoming)) {
    const incomingConfig = incoming.launchConfig && typeof incoming.launchConfig === 'object'
      ? incoming.launchConfig
      : currentLaunchConfig();
    return pruneLaunchProofEvidenceArtifacts(incoming, incomingConfig);
  }

  const merged = {
    ...existing,
    ...incoming,
    token: { ...(existing.token || {}), ...(incoming.token || {}) },
    liquidity: { ...(existing.liquidity || {}), ...(incoming.liquidity || {}) },
    airdrop: mergeProofAirdropEvidence(existing.airdrop, incoming.airdrop),
  };
  merged.launchConfig = mergeLaunchConfigSnapshot(existing.launchConfig, incoming.launchConfig, existing, incoming);
  const mergedConfig = merged.launchConfig && typeof merged.launchConfig === 'object'
    ? merged.launchConfig
    : currentLaunchConfig();

  if (
    !incoming.reportPublish
    && !reportPublishFinalizationIssue(existing.reportPublish, merged, mergedConfig)
  ) {
    merged.reportPublish = existing.reportPublish;
  }
  if (
    !incoming.localDossier
    && !localDossierFinalizationIssue(existing.localDossier, merged, mergedConfig)
  ) {
    merged.localDossier = existing.localDossier;
  }
  if (
    merged.reportPublish
    && reportPublishFinalizationIssue(merged.reportPublish, merged, mergedConfig)
  ) {
    delete merged.reportPublish;
  }
  if (
    merged.localDossier
    && localDossierFinalizationIssue(merged.localDossier, merged, mergedConfig)
  ) {
    delete merged.localDossier;
  }
  if (!incoming.reportParity && existing.reportParity) {
    const comparison = reportParityClassicComparison(existing.reportParity);
    if (!comparison || classicComparisonMatchesProof(comparison, merged, mergedConfig)) {
      merged.reportParity = existing.reportParity;
    }
  }
  if (!incoming.transfer && existing.transfer) merged.transfer = existing.transfer;
  if (!incoming.destinationWallet && existing.destinationWallet) merged.destinationWallet = existing.destinationWallet;
  return pruneLaunchProofEvidenceArtifacts(merged, mergedConfig);
}

function rememberLaunchProof(readinessOrProof) {
  const rawProof = readinessOrProof?.proof || readinessOrProof;
  if (rawProof && typeof rawProof === 'object') {
    state.launchProof = mergeLaunchProofEvidence(state.launchProof, rawProof);
    const proofConfig = proofConfigForFingerprint(state.launchProof, currentLaunchConfig());
    state.lastReportPublish = reportPublishIsProofCurrent(state.launchProof?.reportPublish, state.launchProof, proofConfig)
      ? state.launchProof.reportPublish
      : null;
    state.lastLocalDossier = localDossierIsProofCurrent(state.launchProof?.localDossier, state.launchProof, proofConfig)
      ? state.launchProof.localDossier
      : null;
    persistLaunchProof(state.launchProof);
    return state.launchProof;
  }
  return null;
}

function clearLaunchProof() {
  state.launchProof = null;
  state.lastReportPublish = null;
  state.lastLocalDossier = null;
  clearStoredLaunchProof();
}

function solscanAccountUrl(address) {
  return `https://solscan.io/account/${encodeURIComponent(String(address || ''))}`;
}

function solscanTxUrl(signature) {
  return `https://solscan.io/tx/${encodeURIComponent(String(signature || ''))}`;
}

function proofPositions(results = []) {
  return results.reduce((count, pool) => (
    count
    + (Array.isArray(pool?.mainPositions) ? pool.mainPositions.length : 0)
    + (Array.isArray(pool?.ladderPositions) ? pool.ladderPositions.length : 0)
    + (Array.isArray(pool?.supportPositions) ? pool.supportPositions.length : 0)
    + (pool?.bootstrap ? 1 : 0)
  ), 0);
}

function proofFeeKeyCount(results = []) {
  return results.reduce((count, pool) => {
    const positions = [
      ...(Array.isArray(pool?.mainPositions) ? pool.mainPositions : []),
      ...(Array.isArray(pool?.ladderPositions) ? pool.ladderPositions : []),
      ...(Array.isArray(pool?.supportPositions) ? pool.supportPositions : []),
      ...(pool?.bootstrap ? [pool.bootstrap] : []),
    ];
    return count + positions.filter((position) => position?.feeKeyNftMint || position?.feeKeyMint).length;
  }, 0);
}

function proofLockedPositionCount(results = []) {
  return results.reduce((count, pool) => {
    const positions = [
      ...(Array.isArray(pool?.mainPositions) ? pool.mainPositions : []),
      ...(Array.isArray(pool?.ladderPositions) ? pool.ladderPositions : []),
      ...(Array.isArray(pool?.supportPositions) ? pool.supportPositions : []),
      ...(pool?.bootstrap ? [pool.bootstrap] : []),
    ];
    return count + positions.filter((position) => position?.locked === true).length;
  }, 0);
}

function reportPositionPlanCount(pool = {}) {
  const distributionCount = Array.isArray(pool.distribution) && pool.distribution.length
    ? pool.distribution.length
    : 1;
  const ladder = pool.ladder || {};
  const ladderCount = ladder.mode === 'manual'
    ? (Array.isArray(ladder.bands) ? ladder.bands.length : 0)
    : ladder.mode === 'simple' ? Number(ladder.bandCount || 0) : 0;
  const supportCount = pool.support?.mode === 'custom' ? 1 : 0;
  const bootstrapCount = pool.bootstrap?.mode === 'custom' || Number(pool.bootstrap?.supplyPercent || 0) > 0 ? 1 : 0;
  return distributionCount + ladderCount + supportCount + bootstrapCount;
}

function reportPositionRecordCount(result = {}) {
  return (
    (Array.isArray(result.mainPositions) ? result.mainPositions.length : 0)
    + (Array.isArray(result.ladderPositions) ? result.ladderPositions.length : 0)
    + (Array.isArray(result.supportPositions) ? result.supportPositions.length : 0)
    + (result.bootstrap ? 1 : 0)
  );
}

function v2ReportPoolTopology(proof = currentLaunchProof(), config = currentLaunchConfig()) {
  const base = config?.poolTopology || {};
  const poolPlan = proof?.poolPlan && typeof proof.poolPlan === 'object' ? proof.poolPlan : null;
  const allocations = Array.isArray(poolPlan?.allocations) && poolPlan.allocations.length
    ? poolPlan.allocations
    : null;
  const airdropPlan = poolPlan?.airdropPlan && typeof poolPlan.airdropPlan === 'object'
    ? poolPlan.airdropPlan
    : null;
  if (!allocations && !airdropPlan) return base;
  return {
    ...base,
    targetMarketCapUsd: Number.isFinite(Number(poolPlan?.targetMarketCapUsd))
      ? Number(poolPlan.targetMarketCapUsd)
      : base.targetMarketCapUsd,
    pools: allocations || (Array.isArray(base.pools) ? base.pools : []),
    airdrop: airdropPlan
      ? {
        ...(base.airdrop || {}),
        ...airdropPlan,
        recipients: Array.isArray(airdropPlan.recipients)
          ? airdropPlan.recipients
          : (Array.isArray(base.airdrop?.recipients) ? base.airdrop.recipients : []),
      }
      : base.airdrop,
  };
}

function buildV2ReportPoolPlan(config, results = [], proof = currentLaunchProof()) {
  const topology = v2ReportPoolTopology(proof, config);
  const pools = Array.isArray(topology?.pools) ? topology.pools : [];
  return pools.map((pool, index) => {
    const result = results.find((row) => Number(row?.allocationIndex) === index)
      || results[index]
      || null;
    return {
      index,
      status: result?.poolId ? 'recorded' : 'planned',
      quoteToken: pool.quoteToken || null,
      quoteMint: pool.quoteMint || result?.quoteMint || result?.quoteAddress || null,
      quoteSymbol: pool.quoteSymbol || pool.quoteSymbolOverride || result?.quoteSymbol || pool.quoteToken || null,
      quoteSymbolOverride: pool.quoteSymbolOverride || null,
      supplyPercent: Number.isFinite(Number(pool.supplyPercent)) ? Number(pool.supplyPercent) : null,
      ammConfigIndex: pool.ammConfigIndex ?? null,
      distribution: Array.isArray(pool.distribution) ? pool.distribution.map((slice, sliceIndex) => ({
        sliceIndex,
        sharePercent: Number.isFinite(Number(slice.sharePercent)) ? Number(slice.sharePercent) : null,
        recipient: slice.recipient || topology?.feeKeyRecipient || null,
      })) : [],
      bootstrap: pool.bootstrap || { mode: 'off' },
      ladder: pool.ladder || { mode: 'off' },
      support: pool.support || { mode: 'off' },
      plannedPositionCount: reportPositionPlanCount(pool),
      recordedPositionCount: result ? reportPositionRecordCount(result) : 0,
      recorded: result ? {
        poolId: result.poolId || null,
        createPoolTx: result.txIds?.createPool || result.createPoolTx || null,
        tickSpacing: result.tickSpacing ?? null,
        initialPrice: result.initialPrice ?? null,
        launchedSide: result.launchedSide || null,
        lockedPositionCount: proofLockedPositionCount([result]),
        feeKeyCount: proofFeeKeyCount([result]),
      } : null,
    };
  });
}

function buildV2ReportAirdropAudit(proof, config) {
  const topology = v2ReportPoolTopology(proof, config);
  const plan = topology?.airdrop || {};
  const recipients = Array.isArray(plan.recipients) ? plan.recipients : [];
  const sampleLimit = 100;
  return {
    enabled: plan.enabled === true || recipients.length > 0 || Number(plan.recipientCount || 0) > 0,
    source: plan.source || (recipients.length ? 'csv' : 'manual-count'),
    requestedSupplyPercent: Number.isFinite(Number(plan.requestedSupplyPercent)) ? Number(plan.requestedSupplyPercent) : Number(plan.supplyPercent || 0),
    effectiveSupplyPercent: Number(plan.supplyPercent || 0),
    requiredSupplyPercent: Number(plan.requiredSupplyPercent || 0),
    budgetTokens: Number(plan.budgetTokens || 0),
    explicitTokens: Number(plan.explicitTokens || 0),
    remainingTokens: Number(plan.remainingTokens || 0),
    executionCostSol: Number(plan.executionCostSol || 0),
    budgetError: plan.budgetError || null,
    plannedRecipientCount: Number(proof?.airdrop?.plannedRecipientCount || plan.recipientCount || recipients.length || 0),
    deliveredCount: Number(proof?.airdrop?.deliveredCount || 0),
    failedCount: Number(proof?.airdrop?.failedCount || 0),
    recipientsPreview: recipients.slice(0, sampleLimit),
    recipientsPreviewLimit: sampleLimit,
    recipientsTruncated: recipients.length > sampleLimit,
  };
}

function buildV2ReportRecoveryAudit(proof = currentLaunchProof()) {
  const journals = Array.isArray(state.recovery?.journals) ? state.recovery.journals : [];
  const activeWallet = proof?.walletPublicKey || selectedLaunchWalletPublicKey() || null;
  const related = journals
    .filter((journal) => !activeWallet || !journal?.walletPublicKey || journal.walletPublicKey === activeWallet)
    .slice(0, 10)
    .map((journal) => {
      const plan = journalResumePlan(journal);
      return {
        id: journal.id || null,
        status: journal.status || null,
        stage: journal.stage || null,
        walletPublicKey: journal.walletPublicKey || null,
        tokenMint: journal.token?.mint || journal.token?.tokenMint || null,
        tokenSymbol: journal.token?.symbol || null,
        updatedAt: journal.updatedAt || journal.createdAt || null,
        poolProgress: {
          recordedPools: journalPriorResults(journal).length,
          plannedPools: journalPoolCount(journal),
        },
        resumePlan: {
          state: plan.state,
          title: plan.title,
          manualRecoveryRequired: plan.manualRecoveryRequired === true,
          items: plan.items || [],
        },
      };
    });
  return {
    journalId: proof?.journalId || null,
    status: proof?.status || null,
    stage: proof?.stage || null,
    updatedAt: proof?.updatedAt || null,
    activeJournalCount: Number(state.recovery?.activeJournalCount || 0),
    failedJournalCount: Number(state.recovery?.failedJournalCount || 0),
    pendingWalletCount: Number(state.recovery?.pendingWalletCount || 0),
    relatedJournals: related,
  };
}

function v2ReportParityItem(id, label, state, detail) {
  return { id, label, state, detail };
}
