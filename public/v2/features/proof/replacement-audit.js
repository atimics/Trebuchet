function buildClassicRetirementGate(proof = currentLaunchProof(), audit = null, config = currentLaunchConfig()) {
  config = proofConfigForFingerprint(proof, config);
  const expectedAuditFingerprint = launchProofFingerprint(proof, config);
  audit = reportParityAuditMatchesProof(audit, proof, config)
    ? audit
    : buildV2ReportParityAudit(proof, config);
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
  const requirements = [
    {
      id: 'live-proof',
      pass: hasCompletedLiveProof,
      detail: hasCompletedLiveProof
        ? `Live Trebuchet proof has ${poolCount} pool${poolCount === 1 ? '' : 's'} and ${positionCount} position${positionCount === 1 ? '' : 's'}.`
        : isDemoProof
          ? 'Test launch record proves wiring only; run a real Trebuchet launch.'
          : proof && proofLaunchConfigSnapshot.state === 'missing'
            ? 'Completed proof is missing its frozen launch-config snapshot; load proof-bound config.'
            : proof && proofLaunchConfigSnapshot.state === 'mismatch'
              ? `Completed proof has a mismatched frozen launch-config snapshot (${proofLaunchConfigSnapshot.mismatches.join(', ')}); load the journal-bound token and pool configuration.`
            : proof && !proofLaunchConfigSnapshot.complete
              ? `Completed proof has an incomplete frozen launch-config snapshot (${proofLaunchConfigSnapshot.missing.join(', ')}); load proof-bound token and pool configuration.`
            : proof && !proofJournalEvidence
              ? 'Completed proof is missing its launch journal id; load journal-backed proof.'
            : proof && !matchingLocalJournal
              ? `Completed proof journal ${proof.journalId} is not loaded from the local launch-journal store; refresh local recovery state.`
            : proof && localJournalEvidenceState.mismatches.length
              ? `Loaded launch journal does not match proof (${localJournalEvidenceState.mismatches.join(', ')}); refresh local recovery state.`
            : proof && localJournalEvidenceState.missing.length
              ? `Loaded launch journal is missing proof backing (${localJournalEvidenceState.missing.join(', ')}); refresh local recovery state.`
            : proof && !proofTerminalJournalEvidence
              ? `Launch journal is not terminal (${proof?.status || 'unknown'} / ${proof?.stage || 'unknown'}); refresh proof after final sweep.`
            : proof && !proofWalletEvidence
              ? 'Completed proof is missing its launch wallet; load wallet-bound proof.'
          : proof?.token?.mint && !liveTokenAuthorityComplete
                ? `Token authority proof is ${liveTokenAuthorityPassCount}/${liveTokenAuthorityFields.length}; complete authority evidence.`
          : proof && (!livePoolIdentityComplete && (recordedPoolIds.length !== plannedPoolCount || poolCount !== plannedPoolCount || liquidityEvidence.missing.includes('pool count')))
            ? `Pool identity proof is ${recordedPoolIds.length}/${plannedPoolCount}; load exact recorded pool IDs.`
          : proof && txEvidence.poolCreateTxCount < plannedPoolCount
            ? `Pool-create transaction proof is ${txEvidence.poolCreateTxCount}/${plannedPoolCount}; refresh journal-backed liquidity proof.`
          : proof && !livePositionProofComplete && (recordedPositionCount < plannedPositionCount || liquidityEvidence.missing.some((item) => ['position count', 'position records'].includes(item)))
            ? `Position proof is ${recordedPositionCount}/${plannedPositionCount}; load exact position records.`
          : proof && txEvidence.openTxCount < recordedPositionCount
            ? `Position-open transaction proof is ${txEvidence.openTxCount}/${recordedPositionCount}; refresh journal-backed liquidity proof.`
          : proof && !liveLockProofComplete && (lockedPositionCount < recordedPositionCount || liquidityEvidence.missing.includes('lock count'))
            ? `Burn & Earn lock proof is ${lockedPositionCount}/${recordedPositionCount}; complete lock evidence.`
          : proof && txEvidence.lockTxCount < recordedPositionCount
            ? `Burn & Earn lock transaction proof is ${txEvidence.lockTxCount}/${recordedPositionCount}; refresh journal-backed liquidity proof.`
          : proof && !liveLockProofComplete && (feeKeyCount < lockedPositionCount || liquidityEvidence.missing.includes('fee key count'))
            ? `Fee Key NFT proof is ${feeKeyCount}/${lockedPositionCount}; complete Fee Key mint evidence.`
          : proof && txEvidence.feeKeyRecipientTransferred < feeKeyRecipientTarget
            ? `Fee Key recipient transfer proof is ${txEvidence.feeKeyRecipientTransferred}/${feeKeyRecipientTarget}; complete recipient delivery evidence.`
          : proof?.transfer && !finalSweepComplete
            ? 'Final sweep record is not terminal; verify wallet-empty, error-free sweep evidence.'
            : 'Run a real Trebuchet launch through token, liquidity, and final sweep.',
    },
    {
      id: 'report-proof',
      pass: Boolean(reportArtifact && reportArtifactSweepBound),
      detail: reportUri
        ? reportArtifactSweepBound
          ? `Permanent report proof is attached: ${fullAddress(reportUri)}.`
          : 'Permanent report proof is missing the terminal sweep evidence hash; republish after final sweep.'
        : localDossier
          ? reportArtifactSweepBound
            ? `Saved launch record proof is attached: ${localDossier.filename}.`
            : 'Saved launch record proof is missing the terminal sweep evidence hash; download a fresh launch record after final sweep.'
        : staleReport
          ? reportPublishMatchesProof(staleReport, proof, config) && !reportArtifactMatchesTerminalSweep(staleReport, proof)
            ? localDossierHasEvidence(staleReport)
              ? 'Saved launch record proof is missing the terminal sweep evidence hash; download a fresh launch record after final sweep.'
              : 'Permanent report proof is missing the terminal sweep evidence hash; republish after final sweep.'
            : 'Report artifact belongs to another Trebuchet proof; regenerate it.'
          : 'Publish or attach a proof-bound Trebuchet launch report.',
    },
    {
      id: 'audit',
      pass: audit?.status === 'pass',
      detail: audit?.status === 'pass'
        ? 'The generated Trebuchet proof audit is fully passing.'
        : `Proof audit is ${audit?.status || 'missing'} with ${audit?.missingCount || 0} missing and ${audit?.warnCount || 0} warning checks.`,
    },
  ];
  const missing = requirements.filter((item) => !item.pass);
  const passCount = requirements.length - missing.length;
  return {
    id: 'classic-retirement',
    source: 'trebuchet-v2-classic-retirement-gate',
    proofFingerprint: expectedAuditFingerprint,
    auditFingerprint: audit?.proofFingerprint || null,
    title: missing.length ? 'Release evidence' : 'Ready to release',
    state: missing.length ? 'danger' : 'pass',
    badge: missing.length ? 'Blocked' : 'Ready',
    detail: missing.length ? missing[0].detail : 'Live launch, report and proof audit pass.',
    passCount,
    itemCount: requirements.length,
    requirements,
    replacementCriteria: [],
    criteriaPassCount: 0,
    criteriaItemCount: 0,
  };
}

