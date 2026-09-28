function transferSweepErrorCount(transfer = {}) {
  const tokenErrors = Array.isArray(transfer.tokenTransferErrors)
    ? transfer.tokenTransferErrors
    : Array.isArray(transfer.tokenSweep?.errors) ? transfer.tokenSweep.errors : [];
  const nftErrors = Array.isArray(transfer.nftTransferErrors)
    ? transfer.nftTransferErrors
    : Array.isArray(transfer.nftSweep?.errors) ? transfer.nftSweep.errors : [];
  return tokenErrors.length + nftErrors.length + (transfer.solSweepError ? 1 : 0);
}

function transferSweptAssetCount(transfer = {}) {
  const tokenRows = Array.isArray(transfer.tokenSweep?.transferred) ? transfer.tokenSweep.transferred.length : 0;
  const nftRows = Array.isArray(transfer.nftSweep?.transferred) ? transfer.nftSweep.transferred.length : 0;
  const tokens = Number(transfer.tokensTransferred || 0);
  const nfts = Number(transfer.nftsTransferred || 0);
  const sol = Number(transfer.solTransferred || 0);
  return (Number.isFinite(tokens) ? tokens : 0)
    + (Number.isFinite(nfts) ? nfts : 0)
    + tokenRows
    + nftRows
    + (Number.isFinite(sol) && sol > 0 ? 1 : 0);
}

function transferHasFinalSweepEvidence(transfer = null) {
  if (!transfer || typeof transfer !== 'object') return false;
  if (!String(transfer.destinationWallet || '').trim()) return false;
  if (transfer.status === 'planned-before-sweep') return false;
  if (transfer.walletEmpty === true) return transferSweepErrorCount(transfer) === 0;
  if (transfer.walletEmpty === false) return false;
  if (transferSweepErrorCount(transfer) > 0) return false;
  return transferSweptAssetCount(transfer) > 0;
}

function transferHasWalletEmptyFinalSweepEvidence(transfer = null) {
  return Boolean(
    transfer
    && typeof transfer === 'object'
    && String(transfer.destinationWallet || '').trim()
    && transfer.status !== 'planned-before-sweep'
    && transfer.walletEmpty === true
    && transferSweepErrorCount(transfer) === 0
  );
}

function journalTransferHasTerminalSweepEvidence(transfer = null) {
  return transferHasWalletEmptyFinalSweepEvidence(transfer);
}

function proofTransferJournalEvidenceState(proofTransfer = null, journalTransfer = null) {
  const missing = [];
  const mismatches = [];
  const proofHash = comparisonTransferEvidenceHash(proofTransfer);
  const journalHash = comparisonTransferEvidenceHash(journalTransfer);
  if (!proofHash) return { missing, mismatches, proofHash: null, journalHash };
  if (!journalHash) {
    missing.push('journal sweep evidence hash');
  } else if (proofHash !== journalHash) {
    mismatches.push('sweep evidence hash');
  }
  return { missing, mismatches, proofHash, journalHash };
}

function finalSweepProofState(transfer = null) {
  const hasRecord = transfer && typeof transfer === 'object' && Object.keys(transfer).length > 0;
  const terminal = transferHasWalletEmptyFinalSweepEvidence(transfer);
  return {
    terminal,
    status: terminal ? 'terminal' : hasRecord ? 'needs-proof' : 'not-recorded',
    label: terminal ? 'Terminal' : hasRecord ? 'Needs proof' : 'Not recorded',
    walletEmpty: transfer?.walletEmpty === true ? true : transfer?.walletEmpty === false ? false : null,
    sweptAssetCount: transferSweptAssetCount(transfer || {}),
    errorCount: transferSweepErrorCount(transfer || {}),
  };
}

function proofHasTerminalLaunchJournal(proof = currentLaunchProof()) {
  const journalEvidence = proofJournalEvidenceState(proof);
  const matchingJournal = journalEvidence.journal;
  const status = String(proof?.status || '').trim().toLowerCase();
  const stage = String(proof?.stage || '').trim().toLowerCase();
  const journalStatus = String(matchingJournal?.status || '').trim().toLowerCase();
  const journalStage = String(matchingJournal?.stage || '').trim().toLowerCase();
  return status === 'completed'
    && stage === 'transfer_completed'
    && journalStatus === 'completed'
    && journalStage === 'transfer_completed'
    && journalEvidence.backed;
}

function buildV2ReportParityAudit(proof = currentLaunchProof(), config = currentLaunchConfig()) {
  const proofLaunchConfigSnapshot = proofLaunchConfigSnapshotState(proof);
  config = proofConfigForFingerprint(proof, config);
  const token = proof?.token || {};
  const results = Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results : [];
  const plannedPools = buildV2ReportPoolPlan(config, results, proof);
  const plannedPoolCount = plannedPools.length;
  const recordedPoolCount = launchProofPoolIds(proof).length;
  const plannedPositionCount = plannedPools.reduce((sum, pool) => sum + Number(pool.plannedPositionCount || 0), 0);
  const liquidityEvidence = comparisonLiquidityEvidenceState(proof, {
    plannedPoolCount,
    plannedPositionCount,
  });
  const recordedPositionCount = liquidityEvidence.positionCount;
  const lockedPositionCount = liquidityEvidence.lockedPositionCount;
  const feeKeyCount = liquidityEvidence.feeKeyCount;
  const txEvidence = v2LiquidityTransactionEvidenceCounts(results);
  const poolTxCount = txEvidence.poolCreateTxCount;
  const openTxCount = txEvidence.openTxCount;
  const lockTxCount = txEvidence.lockTxCount;
  const transferTxCount = txEvidence.feeKeyRecipientTransferred;
  const feeKeyRecipientTarget = txEvidence.feeKeyRecipientRows.length;
  const feeKeyRecipientTransferred = txEvidence.feeKeyRecipientTransferred;
  const feeKeyMintComplete = recordedPositionCount > 0 && lockedPositionCount > 0 && feeKeyCount >= lockedPositionCount;
  const feeKeyRecipientComplete = feeKeyRecipientTarget <= 0 || feeKeyRecipientTransferred >= feeKeyRecipientTarget;
  const report = currentReportPublish(proof, config);
  const localDossier = currentLocalDossier(proof, config);
  const staleReport = staleReportPublishForProof(proof, config);
  const reportArtifactRecord = report || localDossier || null;
  const transfer = proof?.transfer || null;
  const sweepComplete = transferHasWalletEmptyFinalSweepEvidence(transfer);
  const reportArtifactSweepBound = Boolean(
    sweepComplete
    && reportArtifactRecord
    && reportArtifactMatchesTerminalSweep(reportArtifactRecord, proof)
  );
  const reportUri = report?.htmlUri || report?.jsonUri || null;
  const localJournalEvidenceState = proofJournalEvidenceState(proof);
  const matchingLocalJournal = localJournalEvidenceState.journal;
  const terminalJournalComplete = proofHasTerminalLaunchJournal(proof);
  const airdropAudit = buildV2ReportAirdropAudit(proof, config);
  const plannedAirdrop = Number(airdropAudit.plannedRecipientCount || 0);
  const deliveredAirdrop = Number(airdropAudit.deliveredCount || 0);
  const failedAirdrop = Number(airdropAudit.failedCount || 0);
  const airdropProofEvidence = comparisonAirdropDeliveryEvidenceState({
    ...(proof?.airdrop || {}),
    recipients: Array.isArray(proof?.airdrop?.recipients) && proof.airdrop.recipients.length
      ? proof.airdrop.recipients
      : Array.isArray(config?.poolTopology?.airdrop?.recipients)
        ? config.poolTopology.airdrop.recipients
        : [],
    plannedRecipientCount: plannedAirdrop,
    deliveredCount: deliveredAirdrop,
    failedCount: failedAirdrop,
  });
  const classicComparison = currentClassicComparisonForProof(proof, config);
  const selfArtifactCompared = classicComparison?.artifactSource === 'trebuchet-v2';
  const comparisonMatchesProof = classicComparisonMatchesProof(classicComparison, proof, config);
  const comparisonEvidence = classicComparisonRequiredEvidence(classicComparison, proof, config);
  const comparedToClassic = !selfArtifactCompared
    && comparisonMatchesProof
    && comparisonEvidence.pass
    && classicComparison?.status === 'pass';
  const authorityValues = [
    token.mintAuthorityRenounced,
    token.freezeAuthorityDisabled,
    token.metadataUpdateAuthorityRevoked,
    token.metadataImmutable,
  ];
  const authorityPassCount = authorityValues.filter((value) => value === true).length;
  const hasProofLaunchWallet = Boolean(proof?.walletPublicKey);
  const items = [
    v2ReportParityItem(
      'token-proof',
      'Token proof',
      token.mint && hasProofLaunchWallet ? 'pass' : token.mint ? 'warn' : 'missing',
      token.mint
        ? hasProofLaunchWallet
          ? `Mint ${shortAddress(token.mint)} / wallet ${shortAddress(proof.walletPublicKey)}.`
          : `Mint ${shortAddress(token.mint)} is recorded, but launch wallet proof is missing.`
        : 'Token mint is not recorded yet.',
    ),
    v2ReportParityItem(
      'launch-config-proof',
      'Launch config snapshot',
      proofLaunchConfigSnapshot.complete ? 'pass' : proof ? 'warn' : 'missing',
      proofLaunchConfigSnapshot.complete
        ? 'Proof carries the frozen non-secret launch configuration snapshot.'
        : proof
          ? proofLaunchConfigSnapshot.state === 'missing'
            ? 'Proof is missing its frozen non-secret launch configuration snapshot.'
            : proofLaunchConfigSnapshot.state === 'mismatch'
              ? `Proof launch-config snapshot does not match launch evidence: ${proofLaunchConfigSnapshot.mismatches.join(', ')}.`
              : `Proof launch-config snapshot is incomplete: ${proofLaunchConfigSnapshot.missing.join(', ')}.`
          : 'No launch record is loaded yet.',
    ),
    v2ReportParityItem(
      'authority-proof',
      'Authority proof',
      authorityPassCount === authorityValues.length ? 'pass' : authorityPassCount > 0 ? 'warn' : 'missing',
      `${authorityPassCount}/${authorityValues.length} token authority checks confirmed.`,
    ),
    v2ReportParityItem(
      'pool-proof',
      'Pool proof',
      plannedPoolCount > 0
        && recordedPoolCount === plannedPoolCount
        && liquidityEvidence.poolCount === recordedPoolCount
        && poolTxCount >= plannedPoolCount
        && !liquidityEvidence.missing.includes('pool count')
        ? 'pass'
        : recordedPoolCount > 0 ? 'warn' : 'missing',
      `${recordedPoolCount}/${plannedPoolCount || recordedPoolCount || 0} pool IDs recorded; ${poolTxCount} create transaction${poolTxCount === 1 ? '' : 's'} captured.`,
    ),
    v2ReportParityItem(
      'position-proof',
      'Position proof',
      plannedPositionCount > 0
        && recordedPositionCount >= plannedPositionCount
        && openTxCount >= recordedPositionCount
        && !liquidityEvidence.missing.some((item) => ['position count', 'position records'].includes(item))
        ? 'pass'
        : recordedPositionCount > 0 || liquidityEvidence.positionRowCount > 0 ? 'warn' : 'missing',
      `${recordedPositionCount}/${plannedPositionCount || recordedPositionCount || 0} planned position records captured; ${openTxCount} open transaction${openTxCount === 1 ? '' : 's'} linked${liquidityEvidence.missing.includes('position count') ? '; position count does not match recorded rows.' : '.'}`,
    ),
    v2ReportParityItem(
      'lock-proof',
      'Burn & Earn locks',
      recordedPositionCount > 0
        && lockedPositionCount >= recordedPositionCount
        && lockTxCount >= recordedPositionCount
        && !liquidityEvidence.missing.includes('lock count')
        ? 'pass'
        : lockedPositionCount > 0 || liquidityEvidence.lockedRowCount > 0 ? 'warn' : 'missing',
      `${lockedPositionCount}/${recordedPositionCount || 0} positions locked; ${lockTxCount} lock transaction${lockTxCount === 1 ? '' : 's'} linked${liquidityEvidence.missing.includes('lock count') ? '; lock count does not match recorded rows.' : '.'}`,
    ),
    v2ReportParityItem(
      'fee-key-proof',
      'Fee Key transfer proof',
      feeKeyMintComplete && feeKeyRecipientComplete && !liquidityEvidence.missing.includes('fee key count')
        ? 'pass'
        : feeKeyCount > 0 || liquidityEvidence.feeKeyRowCount > 0 || feeKeyRecipientTransferred > 0 ? 'warn' : 'missing',
      feeKeyRecipientTarget > 0
        ? `${feeKeyCount} Fee Key NFT${feeKeyCount === 1 ? '' : 's'} recorded; ${feeKeyRecipientTransferred}/${feeKeyRecipientTarget} recipient transfer${feeKeyRecipientTarget === 1 ? '' : 's'} delivered; ${transferTxCount} transfer proof${transferTxCount === 1 ? '' : 's'} linked.`
        : `${feeKeyCount} Fee Key NFT${feeKeyCount === 1 ? '' : 's'} recorded; no external Fee Key recipients configured.`,
    ),
    v2ReportParityItem(
      'airdrop-proof',
      'Airdrop proof',
      plannedAirdrop <= 0
        ? 'pass'
        : airdropProofEvidence.complete
          ? 'pass'
        : deliveredAirdrop + failedAirdrop > 0 ? 'warn' : 'missing',
      plannedAirdrop <= 0
        ? 'No airdrop planned.'
        : airdropProofEvidence.complete
          ? `${deliveredAirdrop}/${plannedAirdrop} delivered with exact recipient and transaction proof.`
          : `${deliveredAirdrop}/${plannedAirdrop} delivered; ${failedAirdrop} failed; missing ${airdropProofEvidence.missing.join(', ')}.`,
    ),
    v2ReportParityItem(
      'recovery-proof',
      'Recovery evidence',
      proof?.journalId ? 'pass' : proof ? 'warn' : state.recovery?.journalCount ? 'warn' : 'missing',
      proof?.journalId
        ? `Journal ${proof.journalId} is attached.`
        : state.recovery?.journalCount
          ? `${state.recovery.journalCount} local journal${state.recovery.journalCount === 1 ? '' : 's'} loaded; attach the completed launch journal id to the proof before retiring Classic.`
          : 'No local journal evidence is attached yet.',
    ),
    v2ReportParityItem(
      'terminal-journal-proof',
      'Terminal journal proof',
      terminalJournalComplete ? 'pass' : proof?.journalId ? 'warn' : proof ? 'warn' : 'missing',
      terminalJournalComplete
        ? `Loaded launch journal ${proof.journalId} reached transfer_completed and backs the pool/sweep proof.`
        : proof?.journalId && !matchingLocalJournal
          ? `Launch journal ${proof.journalId} is not loaded locally; refresh recovery state before retiring Classic.`
        : proof?.journalId && localJournalEvidenceState.mismatches.length
          ? `Loaded launch journal ${proof.journalId} does not match proof: ${localJournalEvidenceState.mismatches.join(', ')}.`
        : proof?.journalId && localJournalEvidenceState.missing.length
          ? `Loaded launch journal ${proof.journalId} is missing proof backing: ${localJournalEvidenceState.missing.join(', ')}.`
        : proof?.journalId
          ? `Launch journal ${proof.journalId} is not terminal yet; refresh proof after final sweep.`
          : 'Completed launch journal status is not attached yet.',
    ),
    v2ReportParityItem(
      'report-proof',
      'Report artifact',
      reportUri || localDossier
        ? reportArtifactSweepBound ? 'pass' : 'warn'
        : staleReport ? 'warn' : proof?.canPublishReport || token.mint ? 'warn' : 'missing',
      reportUri
        ? reportArtifactSweepBound
          ? `Published at ${shortAddress(reportUri)}.`
          : 'Published report is missing terminal sweep evidence hash; republish after final sweep.'
        : localDossier
          ? reportArtifactSweepBound
            ? `Saved launch record downloaded: ${localDossier.filename}.`
            : 'Saved launch record is missing terminal sweep evidence hash; download a fresh launch record after final sweep.'
        : staleReport
          ? 'Report artifact belongs to another Trebuchet proof; regenerate it for the current launch.'
          : 'Local proof can be exported; permanent report publish is pending or disabled.',
    ),
    v2ReportParityItem(
      'sweep-proof',
      'Final sweep proof',
      sweepComplete ? 'pass' : transfer || proof?.canSweep ? 'warn' : 'missing',
      sweepComplete
        ? `Sweep recorded to ${shortAddress(transfer.destinationWallet || proof?.destinationWallet || config?.poolTopology?.sweepDestination || '')}.`
        : transfer
          ? 'Sweep record exists but is missing wallet-empty, error-free final-sweep evidence.'
        : proof?.canSweep ? 'Sweep is ready but not recorded.' : 'Final sweep is not recorded yet.',
    ),
    v2ReportParityItem(
      'classic-comparison',
      'Live classic comparison',
      comparedToClassic ? 'pass' : 'warn',
      comparedToClassic
        ? 'A completed Classic artifact was compared against Trebuchet report output.'
        : selfArtifactCompared
          ? 'Loaded artifact was generated by Trebuchet; compare against completed Classic output.'
          : classicComparison && !comparisonMatchesProof
            ? 'Classic comparison belongs to another Trebuchet proof; rerun it for the current launch.'
          : classicComparison
            && classicComparison.status === 'pass'
            && !comparisonEvidence.pass
            ? comparisonEvidence.detail
          : classicComparison
            ? `Classic artifact compared with ${classicComparison.passCount || 0}/${classicComparison.fieldCount || 0} fields matching; ${classicComparison.mismatchCount || 0} mismatched, ${classicComparison.missingCount || 0} missing.`
            : 'Compare the next completed live Trebuchet launch against a Classic launch artifact before retiring Classic.',
    ),
  ];
  const passCount = items.filter((item) => item.state === 'pass').length;
  const warnCount = items.filter((item) => item.state === 'warn').length;
  const missingCount = items.filter((item) => item.state === 'missing').length;
  return {
    version: 1,
    source: 'trebuchet-v2-report-parity-audit',
    generatedAt: new Date().toISOString(),
    proofFingerprint: launchProofFingerprint(proof, config),
    status: missingCount ? 'missing' : warnCount ? 'warn' : 'pass',
    score: items.length ? Math.round((passCount / items.length) * 100) : 0,
    passCount,
    warnCount,
    missingCount,
    itemCount: items.length,
    items,
  };
}

function reportParityAuditMatchesProof(audit = null, proof = currentLaunchProof(), config = currentLaunchConfig()) {
  if (!audit || typeof audit !== 'object') return false;
  const proofConfig = proofConfigForFingerprint(proof, config);
  const expectedFingerprint = launchProofFingerprint(proof, proofConfig);
  const expectedAudit = buildV2ReportParityAudit(proof, proofConfig);
  const expectedItems = Array.isArray(expectedAudit.items) ? expectedAudit.items : [];
  const items = Array.isArray(audit.items) ? audit.items : [];
  const itemCount = Number(audit.itemCount);
  const passCount = Number(audit.passCount || 0);
  const warnCount = Number(audit.warnCount || 0);
  const missingCount = Number(audit.missingCount || 0);
  return Boolean(
    String(audit.source || '').trim() === 'trebuchet-v2-report-parity-audit'
      && String(audit.proofFingerprint || '').trim() === expectedFingerprint
      && Number(audit.version) >= 1
      && items.length > 0
      && Number.isInteger(itemCount)
      && itemCount === items.length
      && itemCount === expectedItems.length
      && Number.isInteger(passCount)
      && Number.isInteger(warnCount)
      && Number.isInteger(missingCount)
      && passCount >= 0
      && warnCount >= 0
      && missingCount >= 0
      && passCount === Number(expectedAudit.passCount || 0)
      && warnCount === Number(expectedAudit.warnCount || 0)
      && missingCount === Number(expectedAudit.missingCount || 0)
      && passCount + warnCount + missingCount === itemCount
      && String(audit.status || '').trim() === String(expectedAudit.status || '').trim()
      && items.every((item, index) => (
        item
        && typeof item === 'object'
        && String(item.id || '').trim()
        && ['pass', 'warn', 'missing'].includes(String(item.state || '').trim())
        && String(item.id || '').trim() === String(expectedItems[index]?.id || '').trim()
        && String(item.state || '').trim() === String(expectedItems[index]?.state || '').trim()
        && generatedEvidenceTextMatches(item, expectedItems[index], ['label', 'detail'])
      ))
  );
}

function generatedEvidenceTextMatches(row = {}, expectedRow = {}, keys = []) {
  return keys.every((key) => (
    String(row?.[key] ?? '').trim() === String(expectedRow?.[key] ?? '').trim()
  ));
}

function v2ReportAuditNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function buildV2ReportPositionAuditRecord(position = {}, type, extra = {}) {
  const txIds = position.txIds || {};
  return {
    type,
    ...(extra || {}),
    tickLower: v2ReportAuditNumber(position.tickLower),
    tickUpper: v2ReportAuditNumber(position.tickUpper),
    lowerMultiplier: v2ReportAuditNumber(position.lowerMultiplier),
    upperMultiplier: v2ReportAuditNumber(position.upperMultiplier),
    positionNftMint: position.positionNftMint || position.nftMint || position.positionMint || null,
    feeKeyNftMint: position.feeKeyNftMint || position.feeKeyMint || null,
    locked: position.locked === true,
    openTx: txIds.open || position.openTx || null,
    lockTx: txIds.lock || position.lockTx || null,
    transferTx: txIds.transfer || position.transferTx || null,
  };
}

function buildV2ReportHeldReserveAudit(config = currentLaunchConfig(), estimate = currentClassicFundingEstimateForConfig(config)) {
  const topology = config?.poolTopology || {};
  const pools = Array.isArray(topology.pools) ? topology.pools : [];
  const preallocationPercent = Math.max(0, Number(topology.preallocation?.supplyPercent || 0));
  const airdrop = topology.airdrop || {};
  const airdropReservePercent = airdrop.enabled
    ? Math.max(0, Number(airdrop.supplyPercent || 0), Number(airdrop.requiredSupplyPercent || 0))
    : 0;
  const heldReservePercent = preallocationPercent + airdropReservePercent;
  const supportSol = pools.reduce((sum, pool) => {
    const support = pool?.support || {};
    return support.mode === 'custom' ? sum + Math.max(0, Number(support.solValue || 0)) : sum;
  }, 0);
  const targetMarketCapUsd = Math.max(0, Number(topology.targetMarketCapUsd || config?.funding?.targetMarketCapUsd || 0));
  const solUsd = Math.max(0, Number(estimate?.solUsd || 0));
  const reserveUsd = targetMarketCapUsd > 0 ? targetMarketCapUsd * heldReservePercent / 100 : null;
  const requiredSupportSol = reserveUsd != null && solUsd > 0 ? reserveUsd / solUsd : null;
  const supportUsd = solUsd > 0 ? supportSol * solUsd : null;
  const coverage = requiredSupportSol && requiredSupportSol > 0 ? supportSol / requiredSupportSol : null;
  let state = 'pass';
  let detail = 'No held reserve is configured.';

  if (heldReservePercent > 0 && targetMarketCapUsd <= 0) {
    state = 'warn';
    detail = 'Target market cap is missing, so Trebuchet cannot size equal-value support backing for held reserves.';
  } else if (heldReservePercent > 0 && supportSol <= 0) {
    state = 'danger';
    detail = 'Held reserve is configured without support liquidity backing.';
  } else if (heldReservePercent > 0 && solUsd <= 0) {
    state = 'warn';
    detail = 'Held reserve has support liquidity configured, but no current funding-estimate SOL/USD rate is attached for coverage math.';
  } else if (heldReservePercent > 0 && coverage != null && coverage < 0.995) {
    state = 'danger';
    detail = `Held reserve support is underbacked; add ${reportNumber(Math.max(0, requiredSupportSol - supportSol), { maximumFractionDigits: 3 })} SOL of support or lower held supply.`;
  } else if (heldReservePercent > 0) {
    detail = 'Held reserve is backed by equal-value support liquidity according to the current funding estimate.';
  }

  return {
    state,
    detail,
    heldReservePercent: Number(heldReservePercent.toFixed(4)),
    explicitPreallocationPercent: Number(preallocationPercent.toFixed(4)),
    airdropReservePercent: Number(airdropReservePercent.toFixed(4)),
    unallocatedReservePercent: Number(Math.max(0, Number(topology.reservePercent || 0)).toFixed(4)),
    supportSol: Number(supportSol.toFixed(9)),
    targetMarketCapUsd: targetMarketCapUsd > 0 ? Number(targetMarketCapUsd.toFixed(2)) : null,
    solUsd: solUsd > 0 ? Number(solUsd.toFixed(6)) : null,
    reserveUsd: reserveUsd == null ? null : Number(reserveUsd.toFixed(2)),
    requiredSupportSol: requiredSupportSol == null ? null : Number(requiredSupportSol.toFixed(9)),
    supportUsd: supportUsd == null ? null : Number(supportUsd.toFixed(2)),
    coverage: coverage == null ? null : Number(coverage.toFixed(6)),
    fundingEstimateMatched: Boolean(estimate && solUsd > 0),
  };
}

const V2_FIELD_VERIFICATION_REQUIREMENTS = Object.freeze({
  'live-proof': {
    label: 'Live launch',
    action: 'run-non-demo-v2-launch',
  },
  'report-proof': {
    label: 'Report or launch record',
    action: 'attach-terminal-report',
  },
  'classic-comparison': {
    label: 'Classic artifact',
    action: 'compare-classic-artifact',
  },
  audit: {
    label: 'Proof audit',
    action: 'resolve-proof-audit',
  },
  'replacement-criteria': {
    label: 'Replacement criteria',
    action: 'complete-replacement-criteria',
  },
});

const V2_FIELD_VERIFICATION_CRITERIA = Object.freeze({
  'demo-end-to-end': {
    label: 'Full demo launch',
    action: 'run-demo-launch',
  },
  'wallet-lifecycle': {
    label: 'Wallet generation and recovery',
    action: 'generate-or-unlock-wallet',
  },
  'vanity-options': {
    label: 'Vanity CA options',
    action: 'grind-or-select-vanity-ca',
  },
  'token-config-parity': {
    label: 'Token configuration parity',
    action: 'stage-launch-plan',
  },
  'charts-and-viewport': {
    label: 'Charts and viewport smoke',
    action: 'run-viewport-smoke',
  },
  'pool-config-parity': {
    label: 'Pool configuration parity',
    action: 'fix-pool-topology',
  },
  'funding-and-quote': {
    label: 'Funding and quote readiness',
    action: 'run-funding-and-quote-checks',
  },
  'held-reserve-backing': {
    label: 'Held reserve backing',
    action: 'back-held-reserve',
  },
  'run-and-resume': {
    label: 'Run and resume safety',
    action: 'load-or-resume-journal',
  },
  'sweep-report-proof': {
    label: 'Sweep and report proof',
    action: 'publish-report-and-sweep',
  },
  'classic-artifact-comparison': {
    label: 'Classic artifact comparison',
    action: 'compare-classic-artifact',
  },
  'proof-audit': {
    label: 'Proof audit checklist',
    action: 'resolve-proof-audit',
  },
});

function fieldVerificationRequirementRecord(item = {}, index = 0) {
  const id = String(item.id || `requirement-${index + 1}`);
  const meta = V2_FIELD_VERIFICATION_REQUIREMENTS[id] || {};
  return {
    id,
    label: meta.label || item.label || item.title || id,
    pass: item.pass === true,
    action: item.pass === true ? 'none' : (meta.action || 'review-blocker'),
    detail: String(item.detail || item.evidence || '').trim() || (item.pass === true ? 'Proof attached.' : 'Evidence is missing.'),
  };
}

function fieldVerificationCriterionRecord(item = {}, index = 0) {
  const id = String(item.id || `criterion-${index + 1}`);
  const meta = V2_FIELD_VERIFICATION_CRITERIA[id] || {};
  return {
    id,
    label: meta.label || item.label || id,
    pass: item.pass === true,
    action: item.pass === true ? 'none' : (meta.action || 'review-replacement-criterion'),
    detail: String(item.evidence || item.detail || '').trim() || (item.pass === true ? 'Evidence attached.' : 'Evidence is missing.'),
  };
}

function buildV2FieldVerification({
  proof = currentLaunchProof(),
  config = currentLaunchConfig(),
  audit = null,
  retirementGate = null,
} = {}) {
  config = proofConfigForFingerprint(proof, config);
  const expectedFingerprint = launchProofFingerprint(proof, config);
  audit = reportParityAuditMatchesProof(audit, proof, config)
    ? audit
    : buildV2ReportParityAudit(proof, config);
  const gateFingerprint = String(retirementGate?.proofFingerprint || '').trim();
  retirementGate = gateFingerprint === expectedFingerprint
    && classicRetirementGateMatchesProof(retirementGate, proof, audit, config)
    ? retirementGate
    : buildClassicRetirementGate(proof, audit, config);
  const requirements = (Array.isArray(retirementGate.requirements) ? retirementGate.requirements : [])
    .map(fieldVerificationRequirementRecord);
  const replacementCriteria = (Array.isArray(retirementGate.replacementCriteria) ? retirementGate.replacementCriteria : [])
    .map(fieldVerificationCriterionRecord);
  const blockers = requirements.filter((item) => !item.pass);
  const criteriaBlockers = replacementCriteria.filter((item) => !item.pass);
  const firstBlocker = blockers[0] || criteriaBlockers[0] || null;
  const passCount = requirements.filter((item) => item.pass).length;
  const criteriaPassCount = replacementCriteria.filter((item) => item.pass).length;

  return {
    version: 1,
    source: 'trebuchet-v2-field-verification',
    generatedAt: new Date().toISOString(),
    proofFingerprint: expectedFingerprint,
    state: blockers.length || criteriaBlockers.length ? 'blocked' : 'pass',
    ready: blockers.length === 0 && criteriaBlockers.length === 0,
    passCount,
    itemCount: requirements.length,
    criteriaPassCount,
    criteriaItemCount: replacementCriteria.length,
    blockerCount: blockers.length,
    criteriaBlockerCount: criteriaBlockers.length,
    nextAction: firstBlocker?.action || 'none',
    nextDetail: firstBlocker?.detail || 'Field verification is complete.',
    requirements,
    blockers,
    replacementCriteria,
    criteriaBlockers,
  };
}

function classicRetirementGateMatchesProof(gate = null, proof = currentLaunchProof(), audit = null, config = currentLaunchConfig()) {
  if (!gate || typeof gate !== 'object') return false;
  config = proofConfigForFingerprint(proof, config);
  const expected = buildClassicRetirementGate(proof, audit, config);
  const requirements = Array.isArray(gate.requirements) ? gate.requirements : [];
  const expectedRequirements = Array.isArray(expected.requirements) ? expected.requirements : [];
  const criteria = Array.isArray(gate.replacementCriteria) ? gate.replacementCriteria : [];
  const expectedCriteria = Array.isArray(expected.replacementCriteria) ? expected.replacementCriteria : [];
  const sameRows = (rows, expectedRows) => (
    rows.length === expectedRows.length
    && rows.every((row, index) => (
      String(row?.id || '').trim() === String(expectedRows[index]?.id || '').trim()
      && row?.pass === expectedRows[index]?.pass
      && generatedEvidenceTextMatches(row, expectedRows[index], ['label', 'detail', 'evidence'])
    ))
  );
  return Boolean(
    String(gate.source || '').trim() === 'trebuchet-v2-classic-retirement-gate'
      && String(gate.proofFingerprint || '').trim() === launchProofFingerprint(proof, config)
      && String(gate.state || '').trim() === String(expected.state || '').trim()
      && Number(gate.passCount || 0) === Number(expected.passCount || 0)
      && Number(gate.itemCount || 0) === Number(expected.itemCount || 0)
      && Number(gate.criteriaPassCount || 0) === Number(expected.criteriaPassCount || 0)
      && Number(gate.criteriaItemCount || 0) === Number(expected.criteriaItemCount || 0)
      && sameRows(requirements, expectedRequirements)
      && sameRows(criteria, expectedCriteria)
  );
}

function fieldVerificationMatchesProof(packet = null, proof = currentLaunchProof(), config = currentLaunchConfig(), audit = null, retirementGate = null) {
  if (!packet || typeof packet !== 'object') return false;
  const expected = buildV2FieldVerification({
    proof,
    config,
    audit,
    retirementGate,
  });
  const requirements = Array.isArray(packet.requirements) ? packet.requirements : [];
  const expectedRequirements = Array.isArray(expected.requirements) ? expected.requirements : [];
  const criteria = Array.isArray(packet.replacementCriteria) ? packet.replacementCriteria : [];
  const expectedCriteria = Array.isArray(expected.replacementCriteria) ? expected.replacementCriteria : [];
  const sameRows = (rows, expectedRows) => (
    rows.length === expectedRows.length
    && rows.every((row, index) => (
      String(row?.id || '').trim() === String(expectedRows[index]?.id || '').trim()
      && row?.pass === expectedRows[index]?.pass
      && generatedEvidenceTextMatches(row, expectedRows[index], ['label', 'action', 'detail'])
    ))
  );
  return Boolean(
    String(packet.source || '').trim() === 'trebuchet-v2-field-verification'
      && String(packet.proofFingerprint || '').trim() === String(expected.proofFingerprint || '').trim()
      && String(packet.state || '').trim() === String(expected.state || '').trim()
      && packet.ready === expected.ready
      && Number(packet.passCount || 0) === Number(expected.passCount || 0)
      && Number(packet.itemCount || 0) === Number(expected.itemCount || 0)
      && Number(packet.criteriaPassCount || 0) === Number(expected.criteriaPassCount || 0)
      && Number(packet.criteriaItemCount || 0) === Number(expected.criteriaItemCount || 0)
      && Number(packet.blockerCount || 0) === Number(expected.blockerCount || 0)
      && Number(packet.criteriaBlockerCount || 0) === Number(expected.criteriaBlockerCount || 0)
      && String(packet.nextAction || '').trim() === String(expected.nextAction || '').trim()
      && sameRows(requirements, expectedRequirements)
      && sameRows(criteria, expectedCriteria)
  );
}

function buildV2LaunchReportData(proof = currentLaunchProof(), config = currentLaunchConfig()) {
  config = proofConfigForFingerprint(proof, config);
  const results = Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results : [];
  const recordedPoolIds = launchProofPoolIds(proof);
  const token = proof?.token || {};
  const reportPoolTopology = v2ReportPoolTopology(proof, config);
  const targetMarketCapUsd = Number.isFinite(Number(reportPoolTopology?.targetMarketCapUsd ?? config?.funding?.targetMarketCapUsd))
    ? Number(reportPoolTopology?.targetMarketCapUsd ?? config?.funding?.targetMarketCapUsd)
    : null;
  const transfer = proof?.transfer || null;
  const finalSweep = finalSweepProofState(transfer);
  const transferEvidenceHash = comparisonTransferEvidenceHash(transfer);
  const reportPublish = currentReportPublish(proof, config, { allowTransient: true });
  const localDossier = currentLocalDossier(proof, config);
  const reportParityAudit = buildV2ReportParityAudit(proof, config);
  const classicRetirementGate = buildClassicRetirementGate(proof, reportParityAudit, config);
  const fieldVerification = buildV2FieldVerification({
    proof,
    config,
    audit: reportParityAudit,
    retirementGate: classicRetirementGate,
  });
  const classicReportComparison = normalizeClassicReportComparison(state.classicReportComparison).result;
  const allocatedPercent = results.reduce((sum, pool) => {
    const value = Number(pool?.supplyPercent);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
  const explicitPreallocationPercent = Number(reportPoolTopology?.preallocation?.supplyPercent || 0);
  const airdropReservePercent = Number(reportPoolTopology?.airdrop?.supplyPercent || 0);
  const unallocatedReservePercent = Number(
    Number.isFinite(Number(reportPoolTopology?.reservePercent))
      ? reportPoolTopology.reservePercent
      : Math.max(0, 100 - allocatedPercent - explicitPreallocationPercent - airdropReservePercent),
  );
  return {
    dataVersion: V2_REPORT_DATA_VERSION,
    source: 'trebuchet-v2',
    generatedAt: new Date().toISOString(),
    launchConfig: exportableLaunchConfigSnapshot(config),
    launchWallet: proof?.walletPublicKey || selectedLaunchWalletPublicKey() || null,
    mint: token.mint || null,
    name: token.name || config.token.name,
    symbol: token.symbol || config.token.symbol,
    decimals: token.decimals ?? config.token.decimals,
    totalSupply: token.totalSupply ?? config.token.supply,
    targetMarketCapUsd,
    token: {
      mint: token.mint || null,
      tokenProgram: token.tokenProgram
        || config?.token?.tokenProgram
        || ((token.mintFormat || config?.token?.mintFormat) === 'classic-spl'
          ? 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
          : 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
      mintFormat: token.mintFormat || config?.token?.mintFormat || 'token-2022',
      metadataStandard: token.metadataStandard
        || config?.token?.metadataStandard
        || ((token.mintFormat || config?.token?.mintFormat) === 'classic-spl'
          ? 'metaplex-pda'
          : 'token-2022-inline'),
      metadataUri: token.metadataUri || null,
      imageUri: token.imageUri || null,
      authorities: {
        mintAuthorityRenounced: token.mintAuthorityRenounced === true,
        freezeAuthorityDisabled: token.freezeAuthorityDisabled === true,
        metadataUpdateAuthorityRevoked: token.metadataUpdateAuthorityRevoked === true,
        metadataImmutable: token.metadataImmutable === true,
        metadataPointerAuthorityRevoked: token.metadataPointerAuthorityRevoked === true,
      },
    },
    supply: {
      allocatedToPoolsPercent: Number(allocatedPercent.toFixed(4)),
      preallocationPercent: Number(Math.max(0, 100 - allocatedPercent).toFixed(4)),
      explicitPreallocationPercent: Number(Math.max(0, explicitPreallocationPercent).toFixed(4)),
      airdropReservePercent: Number(Math.max(0, airdropReservePercent).toFixed(4)),
      unallocatedReservePercent: Number(Math.max(0, unallocatedReservePercent).toFixed(4)),
    },
    heldReserveAudit: buildV2ReportHeldReserveAudit(config, currentClassicFundingEstimateForConfig(config)),
    observedSpend: {
      source: 'execution-ledger',
      ...observedExecutionSpendSummary(),
    },
    plannedPools: buildV2ReportPoolPlan(config, results, proof),
    pools: results.map((pool) => ({
      poolId: pool.poolId || null,
      quote: pool.quoteSymbol || pool.quoteToken || null,
      quoteMint: pool.quoteMint || pool.quoteAddress || null,
      supplyPercent: Number.isFinite(Number(pool.supplyPercent)) ? Number(pool.supplyPercent) : null,
      createPoolTx: pool.txIds?.createPool || pool.createPoolTx || null,
      allocationIndex: Number.isFinite(Number(pool.allocationIndex)) ? Number(pool.allocationIndex) : null,
      tickSpacing: pool.tickSpacing ?? null,
      initialPrice: pool.initialPrice ?? null,
      launchedSide: pool.launchedSide || null,
      mainPositions: Array.isArray(pool.mainPositions) ? pool.mainPositions.length : 0,
      ladderPositions: Array.isArray(pool.ladderPositions) ? pool.ladderPositions.length : 0,
      supportPositions: Array.isArray(pool.supportPositions) ? pool.supportPositions.length : 0,
      hasBootstrap: Boolean(pool.bootstrap),
      positions: [
        ...(Array.isArray(pool.mainPositions) ? pool.mainPositions : []).map((position, index) => buildV2ReportPositionAuditRecord(position, 'main', {
          sliceIndex: Number.isFinite(Number(position.sliceIndex)) ? Number(position.sliceIndex) : index,
          sharePercent: v2ReportAuditNumber(position.sharePercent),
          recipient: position.recipient || null,
          transferredTo: position.transferredTo || null,
        })),
        ...(Array.isArray(pool.ladderPositions) ? pool.ladderPositions : []).map((position, index) => buildV2ReportPositionAuditRecord(position, 'ladder', {
          bandIndex: Number.isFinite(Number(position.bandIndex)) ? Number(position.bandIndex) : index,
          supplyPercent: v2ReportAuditNumber(position.supplyPercent),
        })),
        ...(Array.isArray(pool.supportPositions) ? pool.supportPositions : []).map((position, index) => buildV2ReportPositionAuditRecord(position, 'support', {
          supportIndex: Number.isFinite(Number(position.supportIndex)) ? Number(position.supportIndex) : index,
          depthPct: v2ReportAuditNumber(position.depthPct),
          quoteRaw: position.quoteRaw || null,
        })),
        ...(pool.bootstrap ? [buildV2ReportPositionAuditRecord(pool.bootstrap, 'bootstrap', {
          supplyPercent: v2ReportAuditNumber(pool.bootstrap.supplyPercent),
        })] : []),
      ],
    })),
    liquidity: {
      poolCount: recordedPoolIds.length,
      positionCount: proofPositions(results),
      lockedPositionCount: Number(proof?.liquidity?.lockedPositionCount || proofLockedPositionCount(results)),
      feeKeyCount: Number(proof?.liquidity?.feeKeyCount || proofFeeKeyCount(results)),
    },
    airdrop: {
      plannedRecipientCount: Number(proof?.airdrop?.plannedRecipientCount || 0),
      deliveredCount: Number(proof?.airdrop?.deliveredCount || 0),
      failedCount: Number(proof?.airdrop?.failedCount || 0),
      recipients: Array.isArray(proof?.airdrop?.recipients)
        ? proof.airdrop.recipients
        : Array.isArray(config?.poolTopology?.airdrop?.recipients)
          ? config.poolTopology.airdrop.recipients
          : [],
      transferred: Array.isArray(proof?.airdrop?.transferred) ? proof.airdrop.transferred : [],
      failed: Array.isArray(proof?.airdrop?.failed) ? proof.airdrop.failed : [],
    },
    airdropAudit: buildV2ReportAirdropAudit(proof, config),
    reportPublish,
    localDossier,
    reportParityAudit,
    classicRetirementGate,
    fieldVerification,
    classicReportComparison,
    transfer,
    transferEvidenceHash,
    finalSweep: {
      ...finalSweep,
      destinationWallet: proofEffectiveDestination(proof, config),
      transferEvidenceHash,
    },
    destinationWallet: proofEffectiveDestination(proof, config),
    recoveryAudit: buildV2ReportRecoveryAudit(proof),
    poolTopology: reportPoolTopology,
  };
}
