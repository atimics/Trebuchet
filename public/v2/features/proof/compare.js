function currentClassicComparisonFields(proof = currentLaunchProof(), config = currentLaunchConfig()) {
  const results = Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results : [];
  const comparisonPools = classicComparisonPoolRows(proof, config, results);
  const poolIds = [
    ...(Array.isArray(proof?.liquidity?.poolIds) ? proof.liquidity.poolIds : []),
    ...results.map((pool) => pool?.poolId).filter(Boolean),
  ].filter((value, index, list) => value && list.indexOf(value) === index);
  const transfer = proof?.transfer || {};
  const terminalTransferDestination = transferHasWalletEmptyFinalSweepEvidence(transfer)
    ? transfer.destinationWallet
    : null;
  const terminalTransferEvidenceHash = transferHasWalletEmptyFinalSweepEvidence(transfer)
    ? comparisonTransferEvidenceHash(transfer)
    : null;
  const proofAirdrop = proof?.airdrop || {};
  const configAirdropRows = Array.isArray(config?.poolTopology?.airdrop?.recipients)
    ? config.poolTopology.airdrop.recipients
    : [];
  const proofAirdropRows = Array.isArray(proofAirdrop.recipients) && proofAirdrop.recipients.length
    ? proofAirdrop.recipients
    : configAirdropRows;
  const normalizedAirdrop = normalizeComparisonAirdrop({
    ...proofAirdrop,
    recipients: proofAirdropRows,
  });
  const liquidityEvidence = comparisonLiquidityEvidenceState(proof);
  return {
    mint: proof?.token?.mint || null,
    launchWallet: proof?.walletPublicKey || selectedLaunchWalletPublicKey() || null,
    destinationWallet: terminalTransferDestination || proof?.destinationWallet || config?.poolTopology?.sweepDestination || null,
    terminalTransferEvidenceHash,
    poolIds,
    pools: comparisonPools,
    positionCount: liquidityEvidence.positionCount,
    lockedPositionCount: liquidityEvidence.lockedPositionCount,
    feeKeyCount: liquidityEvidence.feeKeyCount,
    positions: comparisonPositionsFromPools(results),
    authorities: {
      mintAuthorityRenounced: optionalBoolean(proof?.token?.mintAuthorityRenounced),
      freezeAuthorityDisabled: optionalBoolean(proof?.token?.freezeAuthorityDisabled),
      metadataUpdateAuthorityRevoked: optionalBoolean(proof?.token?.metadataUpdateAuthorityRevoked),
      metadataImmutable: optionalBoolean(proof?.token?.metadataImmutable),
    },
    airdrop: {
      plannedRecipientCount: Number(
        proofAirdrop.plannedRecipientCount
        || config?.poolTopology?.airdrop?.recipientCount
        || proofAirdropRows.length
        || 0,
      ),
      deliveredCount: Number(proofAirdrop.deliveredCount || 0),
      failedCount: Number(proofAirdrop.failedCount || 0),
      ...normalizedAirdrop,
    },
  };
}

function classicComparisonProofFingerprint(fields = currentClassicComparisonFields()) {
  const poolIds = Array.isArray(fields.poolIds) ? [...new Set(fields.poolIds)].sort() : [];
  return JSON.stringify({
    mint: fields.mint || null,
    launchWallet: fields.launchWallet || null,
    destinationWallet: fields.destinationWallet || null,
    terminalTransferEvidenceHash: fields.terminalTransferEvidenceHash || null,
    poolIds,
    pools: comparisonPoolFingerprint(fields.pools),
    positionCount: Number(fields.positionCount || 0),
    lockedPositionCount: Number(fields.lockedPositionCount || 0),
    feeKeyCount: Number(fields.feeKeyCount || 0),
    positions: comparisonPositionFingerprint(fields.positions),
    authorities: CLASSIC_AUTHORITY_COMPARISON_FIELDS.reduce((record, field) => {
      record[field.key] = optionalBoolean(fields.authorities?.[field.key]);
      return record;
    }, {}),
    airdrop: {
      plannedRecipientCount: Number(fields.airdrop?.plannedRecipientCount || 0),
      deliveredCount: Number(fields.airdrop?.deliveredCount || 0),
      failedCount: Number(fields.airdrop?.failedCount || 0),
      ...comparisonAirdropFingerprint(fields.airdrop || {}),
    },
  });
}

function proofConfigForFingerprint(proof = currentLaunchProof(), config = currentLaunchConfig()) {
  const proofConfig = proof?.launchConfig && typeof proof.launchConfig === 'object' ? proof.launchConfig : null;
  if (!proofConfig) return config;
  const proofTopology = { ...(proofConfig.poolTopology || {}) };
  const configDestination = String(config?.poolTopology?.sweepDestination || '').trim();
  const destinationFinalized = Boolean(
    proofReportArtifactFinalizesDestination(proof, proofConfig)
    || transferHasWalletEmptyFinalSweepEvidence(proof?.transfer)
  );
  if (configDestination && !destinationFinalized) {
    proofTopology.sweepDestination = config.poolTopology.sweepDestination;
  }
  return {
    ...proofConfig,
    token: { ...(proofConfig.token || {}) },
    poolTopology: proofTopology,
    funding: proofConfig.funding ? { ...proofConfig.funding } : proofConfig.funding,
    recovery: proofConfig.recovery ? { ...proofConfig.recovery } : proofConfig.recovery,
  };
}

function launchProofFingerprint(proof = currentLaunchProof(), config = currentLaunchConfig()) {
  const proofConfig = proof?.launchConfig && typeof proof.launchConfig === 'object'
    ? proof.launchConfig
    : null;
  const effectiveConfig = proofConfig && config === proofConfig
    ? proofConfig
    : proofConfigForFingerprint(proof, config);
  return classicComparisonProofFingerprint(currentClassicComparisonFields(proof, effectiveConfig));
}

function classicComparisonPoolRows(proof = currentLaunchProof(), config = currentLaunchConfig(), results = []) {
  const resultRows = Array.isArray(results) ? results : [];
  const planRows = buildV2ReportPoolPlan(config, resultRows, proof);
  if (!planRows.length) return resultRows.map(normalizeComparisonPool);
  return planRows.map((plan, index) => {
    const result = resultRows.find((row) => Number(row?.allocationIndex) === index)
      || resultRows[index]
      || {};
    const recorded = plan.recorded || {};
    return normalizeComparisonPool({
      poolId: result.poolId || result.id || null,
      quote: plan.quoteSymbol || plan.quoteToken || result.quoteSymbol || result.quote || null,
      quoteMint: plan.quoteMint || result.quoteMint || result.quoteAddress || null,
      supplyPercent: plan.supplyPercent ?? result.supplyPercent,
      tickSpacing: recorded.tickSpacing ?? result.tickSpacing,
      initialPrice: recorded.initialPrice ?? result.initialPrice,
      launchedSide: recorded.launchedSide ?? result.launchedSide,
      createPoolTx: recorded.createPoolTx || result.txIds?.createPool || result.createPoolTx || null,
    });
  });
}

function attachProofFingerprint(record, proof = currentLaunchProof(), config = currentLaunchConfig()) {
  if (!record || typeof record !== 'object') return record;
  return {
    ...record,
    proofFingerprint: launchProofFingerprint(proof, config),
  };
}

function reportPublishMatchesProof(report, proof = currentLaunchProof(), config = currentLaunchConfig()) {
  if (!report || typeof report !== 'object') return false;
  if (!report.proofFingerprint) return false;
  return report.proofFingerprint === launchProofFingerprint(proof, config);
}

function terminalSweepEvidenceHashForProof(proof = currentLaunchProof()) {
  return transferHasWalletEmptyFinalSweepEvidence(proof?.transfer)
    ? comparisonTransferEvidenceHash(proof.transfer)
    : null;
}

function reportArtifactMatchesTerminalSweep(report, proof = currentLaunchProof()) {
  if (!report || typeof report !== 'object') return false;
  const sweepEvidenceHash = terminalSweepEvidenceHashForProof(proof);
  if (!sweepEvidenceHash) return true;
  const reportSweepHash = String(
    report.sweepEvidenceHash
    || report.transferEvidenceHash
    || report.finalSweep?.transferEvidenceHash
    || '',
  ).trim();
  return reportSweepHash === sweepEvidenceHash;
}

function reportPublishUri(report = null) {
  return String(report?.jsonUri || report?.htmlUri || '').trim();
}

function reportPublishUriHasPermanentScheme(uri = '') {
  const value = String(uri || '').trim();
  return Boolean(
    /^https?:\/\//i.test(value)
      || /^ar:\/\//i.test(value)
      || /^ipfs:\/\//i.test(value)
  );
}

function reportPublishHasPermanentEvidence(report = null) {
  if (!report || typeof report !== 'object') return false;
  const uri = reportPublishUri(report);
  const dataVersion = Number(report.dataVersion);
  const generatedMetadata = Boolean(
    report.status === 'done'
      || report.alreadyPublished === true
      || String(report.publishedAt || '').trim()
      || (Number.isInteger(dataVersion) && dataVersion > 0)
  );
  return Boolean(uri && reportPublishUriHasPermanentScheme(uri) && generatedMetadata);
}

function reportPublishFinalizationIssue(report = null, proof = currentLaunchProof(), config = currentLaunchConfig()) {
  if (!report || typeof report !== 'object') return 'missing';
  const uri = reportPublishUri(report);
  if (!uri) return 'permanent URI missing';
  if (!reportPublishUriHasPermanentScheme(uri)) return 'unsupported report URI';
  if (!reportPublishHasPermanentEvidence(report)) return 'publish metadata missing';
  const proofFingerprint = String(report.proofFingerprint || '').trim();
  if (!proofFingerprint) return 'proof fingerprint missing';
  if (proofFingerprint !== launchProofFingerprint(proof, config)) return 'proof fingerprint mismatch';
  const proofMint = String(proof?.token?.mint || '').trim();
  const reportMint = String(report.mint || '').trim();
  if (proofMint && !reportMint) return 'token mint missing';
  if (proofMint && reportMint !== proofMint) return 'token mint mismatch';
  if (!reportArtifactMatchesTerminalSweep(report, proof)) return 'terminal sweep evidence hash mismatch';
  return null;
}

function reportPublishIsProofCurrent(report = null, proof = currentLaunchProof(), config = currentLaunchConfig()) {
  return !reportPublishFinalizationIssue(report, proof, config);
}

function localDossierFilenameMatchesKind(filename, kind) {
  const normalized = String(filename || '').trim().toLowerCase();
  if (kind === 'local-proof-json') return normalized.endsWith('.json');
  if (kind === 'local-dossier-html') return normalized.endsWith('.html');
  return false;
}

function localDossierHasEvidence(dossier = null) {
  if (!dossier || typeof dossier !== 'object') return false;
  const kind = String(dossier.kind || '').trim();
  const filename = String(dossier.filename || '').trim();
  const downloadedAt = String(dossier.downloadedAt || '').trim();
  const dataVersion = Number(dossier.dataVersion);
  return Boolean(
    dossier.status === 'downloaded'
      && ['local-dossier-html', 'local-proof-json'].includes(kind)
      && filename
      && localDossierFilenameMatchesKind(filename, kind)
      && String(dossier.proofFingerprint || '').trim()
      && downloadedAt
      && Number.isInteger(dataVersion)
      && dataVersion > 0
  );
}

function localDossierFinalizationIssue(dossier = null, proof = currentLaunchProof(), config = currentLaunchConfig()) {
  if (!dossier || typeof dossier !== 'object') return 'missing';
  const kind = String(dossier.kind || '').trim();
  const filename = String(dossier.filename || '').trim();
  const downloadedAt = String(dossier.downloadedAt || '').trim();
  const dataVersion = Number(dossier.dataVersion);
  const proofFingerprint = String(dossier.proofFingerprint || '').trim();
  if (dossier.status !== 'downloaded') return 'not downloaded';
  if (!['local-dossier-html', 'local-proof-json'].includes(kind)) return 'unknown artifact kind';
  if (!filename || !localDossierFilenameMatchesKind(filename, kind)) return 'filename does not match artifact kind';
  if (!downloadedAt) return 'download timestamp missing';
  if (!Number.isInteger(dataVersion) || dataVersion <= 0) return 'data version missing';
  if (!proofFingerprint) return 'proof fingerprint missing';
  if (proofFingerprint !== launchProofFingerprint(proof, config)) return 'proof fingerprint mismatch';
  const proofMint = String(proof?.token?.mint || '').trim();
  const dossierMint = String(dossier.mint || '').trim();
  if (proofMint && !dossierMint) return 'token mint missing';
  if (proofMint && dossierMint !== proofMint) return 'token mint mismatch';
  const terminalSweepHash = terminalSweepEvidenceHashForProof(proof);
  if (terminalSweepHash) {
    const dossierSweepHash = String(
      dossier.sweepEvidenceHash
      || dossier.transferEvidenceHash
      || dossier.finalSweep?.transferEvidenceHash
      || '',
    ).trim();
    if (dossierSweepHash !== terminalSweepHash) return 'terminal sweep evidence hash mismatch';
  }
  return null;
}

function localDossierIsProofCurrent(dossier = null, proof = currentLaunchProof(), config = currentLaunchConfig()) {
  return !localDossierFinalizationIssue(dossier, proof, config);
}

function currentLocalDossier(proof = currentLaunchProof(), config = currentLaunchConfig()) {
  const proofDossier = proof?.localDossier || null;
  if (localDossierIsProofCurrent(proofDossier, proof, config)) return proofDossier;
  const lastDossier = state.lastLocalDossier || null;
  if (localDossierIsProofCurrent(lastDossier, proof, config)) return lastDossier;
  return null;
}

function currentReportArtifact(proof = currentLaunchProof(), config = currentLaunchConfig(), { allowTransient = false } = {}) {
  const report = currentReportPublish(proof, config, { allowTransient });
  const reportUri = reportPublishUri(report) || null;
  if (reportUri) {
    return {
      type: 'published',
      label: 'Published report',
      record: report,
      uri: reportUri,
      filename: null,
    };
  }
  const dossier = currentLocalDossier(proof, config);
  if (dossier) {
    return {
      type: 'local-dossier',
      label: dossier.kind === 'local-proof-json' ? 'Local proof JSON' : 'Saved launch record',
      record: dossier,
      uri: null,
      filename: dossier.filename || null,
    };
  }
  return null;
}

function proofTerminalTransferDestination(proof = currentLaunchProof()) {
  const transfer = proof?.transfer || null;
  return transferHasWalletEmptyFinalSweepEvidence(transfer)
    ? String(transfer.destinationWallet || '').trim() || null
    : null;
}

function proofEffectiveDestination(proof = currentLaunchProof(), config = currentLaunchConfig()) {
  return proofTerminalTransferDestination(proof)
    || proof?.destinationWallet
    || config?.poolTopology?.sweepDestination
    || null;
}

function currentReportPublish(proof = currentLaunchProof(), config = currentLaunchConfig(), { allowTransient = false } = {}) {
  const proofReport = proof?.reportPublish || null;
  if (reportPublishIsProofCurrent(proofReport, proof, config)) return proofReport;
  const lastReport = state.lastReportPublish || null;
  if (reportPublishIsProofCurrent(lastReport, proof, config)) return lastReport;
  if (
    allowTransient
    && state.reportPublishing
    && lastReport
    && !reportPublishHasPermanentEvidence(lastReport)
    && reportPublishMatchesProof(lastReport, proof, config)
    && reportArtifactMatchesTerminalSweep(lastReport, proof)
  ) return lastReport;
  return null;
}

function staleReportPublishForProof(proof = currentLaunchProof(), config = currentLaunchConfig()) {
  const reports = [proof?.reportPublish, state.lastReportPublish, proof?.localDossier, state.lastLocalDossier].filter(Boolean);
  return reports.find((report) => (
    (reportPublishHasPermanentEvidence(report) && reportPublishFinalizationIssue(report, proof, config))
      || (localDossierHasEvidence(report) && localDossierFinalizationIssue(report, proof, config))
  )) || null;
}

