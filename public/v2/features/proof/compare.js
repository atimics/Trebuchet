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

function classicComparisonMatchesProof(comparison, proof = currentLaunchProof(), config = currentLaunchConfig()) {
  if (!comparison || typeof comparison !== 'object') return false;
  if (!comparison.proofFingerprint) return false;
  return comparison.proofFingerprint === launchProofFingerprint(proof, config);
}

function classicComparisonProofRows(results = []) {
  return (Array.isArray(results) ? results : []).flatMap((pool) => [
    ...(Array.isArray(pool?.mainPositions) ? pool.mainPositions : []),
    ...(Array.isArray(pool?.ladderPositions) ? pool.ladderPositions : []),
    ...(Array.isArray(pool?.supportPositions) ? pool.supportPositions : []),
    ...(pool?.bootstrap ? [pool.bootstrap] : []),
  ]);
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

function classicComparisonRequiredRows(proof = currentLaunchProof(), config = currentLaunchConfig()) {
  const results = Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results : [];
  const comparisonPools = classicComparisonPoolRows(proof, config, results);
  const positions = classicComparisonProofRows(results);
  const poolIds = [
    ...(Array.isArray(proof?.liquidity?.poolIds) ? proof.liquidity.poolIds : []),
    ...results.map((pool) => pool?.poolId).filter(Boolean),
  ].filter((value, index, list) => value && list.indexOf(value) === index);
  const authorityFields = ['mintAuthorityRenounced', 'freezeAuthorityDisabled', 'metadataUpdateAuthorityRevoked', 'metadataImmutable'];
  const configAirdropRows = Array.isArray(config?.poolTopology?.airdrop?.recipients)
    ? config.poolTopology.airdrop.recipients
    : [];
  const proofAirdropRows = Array.isArray(proof?.airdrop?.recipients) && proof.airdrop.recipients.length
    ? proof.airdrop.recipients
    : configAirdropRows;
  const proofAirdropEvidence = comparisonAirdropDeliveryEvidenceState({
    ...(proof?.airdrop || {}),
    recipients: proofAirdropRows,
    plannedRecipientCount: proof?.airdrop?.plannedRecipientCount
      || config?.poolTopology?.airdrop?.recipientCount
      || proofAirdropRows.length
      || 0,
  });
  const liquidityEvidence = comparisonLiquidityEvidenceState(proof);
  const rows = [];
  const add = (id, label, required) => {
    if (required) rows.push({ id, label });
  };
  add('mint', 'Token mint', proof?.token?.mint);
  add('launch-wallet', 'Launch wallet', proof?.walletPublicKey);
  add('pools', 'Pool IDs', poolIds.length);
  add('pool-quote-mints', 'Pool quote mints', comparisonPools.some((pool) => pool?.quoteMint));
  add('pool-parameters', 'Pool parameters', comparisonPools.some((pool) => (
    pool?.supplyPercent != null
    || pool?.tickSpacing != null
    || pool?.initialPrice != null
    || pool?.launchedSide
  )));
  add('pool-create-transactions', 'Pool create transactions', results.some((pool) => pool?.txIds?.createPool || pool?.createPoolTx));
  add('authority-posture', 'Authority posture', authorityFields.some((field) => optionalBoolean(proof?.token?.[field]) !== null));
  add('positionCount', 'Position count', liquidityEvidence.positionCount > 0 || positions.length > 0);
  add('lockedPositionCount', 'Locked positions', liquidityEvidence.lockedPositionCount > 0 || positions.some((position) => position?.locked === true));
  add('feeKeyCount', 'Fee Keys', liquidityEvidence.feeKeyCount > 0 || positions.some((position) => position?.feeKeyNftMint || position?.feeKeyMint));
  add('position-nfts', 'Position NFTs', positions.some((position) => position?.positionNftMint || position?.nftMint || position?.positionMint));
  add('fee-key-nfts', 'Fee Key NFTs', positions.some((position) => position?.feeKeyNftMint || position?.feeKeyMint));
  add('fee-key-recipients', 'Fee Key recipients', positions.some((position) => position?.recipient || position?.transferredTo));
  add('position-transactions', 'Position transactions', positions.some((position) => (
    position?.openTx
    || position?.lockTx
    || position?.transferTx
    || position?.txIds?.open
    || position?.txIds?.lock
    || position?.txIds?.transfer
  )));
  add('position-liquidity-shape', 'Position liquidity shape', positions.some((position) => (
    position?.sharePercent != null
    || position?.supplyPercent != null
    || position?.lowerMultiplier != null
    || position?.upperMultiplier != null
    || position?.depthPct != null
  )));
  add(
    'destination',
    'Destination wallet',
    (transferHasWalletEmptyFinalSweepEvidence(proof?.transfer) ? proof?.transfer?.destinationWallet : null)
      || proof?.destinationWallet
      || config?.poolTopology?.sweepDestination,
  );
  add('airdrop-delivery', 'Airdrop delivery', proofAirdropEvidence.required);
  add('airdrop-recipients', 'Airdrop recipients', proofAirdropEvidence.required);
  add('airdrop-transactions', 'Airdrop transactions', proofAirdropEvidence.required);
  return rows;
}

function classicComparisonRequiredEvidence(comparison, proof = currentLaunchProof(), config = currentLaunchConfig()) {
  const requiredRows = classicComparisonRequiredRows(proof, config);
  const comparisonRows = Array.isArray(comparison?.rows) ? comparison.rows : [];
  const rowsById = new Map(comparisonRows.map((row) => [row?.id, row]));
  const missingRows = requiredRows.filter((row) => rowsById.get(row.id)?.state !== 'pass');
  const fieldCount = Math.max(0, Math.floor(Number(comparison?.fieldCount || 0)) || 0);
  const passCount = Math.max(0, Math.floor(Number(comparison?.passCount || 0)) || 0);
  const enoughFields = fieldCount >= requiredRows.length && passCount >= requiredRows.length;
  const structuredEvidence = comparison?.structuredEvidence === true;
  return {
    pass: Boolean(comparison && requiredRows.length > 0 && structuredEvidence && enoughFields && missingRows.length === 0),
    requiredCount: requiredRows.length,
    fieldCount,
    passCount,
    structuredEvidence,
    missingRows,
    detail: !structuredEvidence
      ? 'Classic comparison is missing structured Classic report evidence; load a Classic JSON export or HTML launch record, not loose text.'
      : missingRows.length
      ? `Classic comparison is missing required passing row${missingRows.length === 1 ? '' : 's'}: ${missingRows.map((row) => row.label).slice(0, 4).join(', ')}${missingRows.length > 4 ? ', ...' : ''}.`
      : enoughFields
        ? `${requiredRows.length}/${requiredRows.length} required Classic evidence rows are passing.`
        : `Classic comparison is too thin: ${passCount}/${requiredRows.length} required rows passing across ${fieldCount} field${fieldCount === 1 ? '' : 's'}.`,
  };
}

function classicComparisonIsRetirementGrade(comparison, proof = currentLaunchProof(), config = currentLaunchConfig()) {
  if (!comparison || typeof comparison !== 'object') return false;
  if (comparison.status !== 'pass') return false;
  if (comparison.artifactSource === 'trebuchet-v2') return false;
  if (!classicComparisonMatchesProof(comparison, proof, config)) return false;
  return classicComparisonRequiredEvidence(comparison, proof, config).pass;
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

function artifactContainsAddress(artifact, value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return artifact.addresses.includes(text) || artifact.text.includes(text);
}

function compareClassicReportArtifact(rawText, proof = currentLaunchProof(), config = currentLaunchConfig()) {
  const artifact = normalizeClassicReportArtifact(rawText);
  const current = currentClassicComparisonFields(proof, config);
  const rows = [];
  const addRow = (id, label, expected, actual, state, detail) => {
    rows.push({ id, label, expected, actual, state, detail });
  };
  if (artifact.sourceKind === 'trebuchet-v2') {
    addRow(
      'artifact-source',
      'Artifact source',
      'completed Classic artifact',
      'Trebuchet proof or launch record',
      'mismatch',
      'Load a completed Classic artifact, not the current Trebuchet proof or launch record.',
    );
  }
  if (!current.mint && !current.poolIds.length && Number(current.positionCount || 0) <= 0) {
    addRow(
      'current-proof',
      'Current Trebuchet proof',
      'token and liquidity proof',
      null,
      'missing',
      'Run or load a completed Trebuchet launch record before comparing a Classic artifact.',
    );
  }
  if (current.mint) {
    const actual = artifact.mint || (!artifact.structuredEvidence && artifactContainsAddress(artifact, current.mint) ? current.mint : null);
    addRow(
      'mint',
      'Token mint',
      current.mint,
      actual,
      actual === current.mint ? 'pass' : actual ? 'mismatch' : 'missing',
      actual === current.mint ? 'Mint matches.' : actual ? 'Classic artifact has a different mint.' : 'Current Trebuchet mint was not found in the artifact.',
    );
  }
  if (current.launchWallet) {
    const actual = artifact.launchWallet || (!artifact.structuredEvidence && artifactContainsAddress(artifact, current.launchWallet) ? current.launchWallet : null);
    addRow(
      'launch-wallet',
      'Launch wallet',
      current.launchWallet,
      actual,
      actual === current.launchWallet ? 'pass' : actual ? 'mismatch' : 'warn',
      actual === current.launchWallet ? 'Launch wallet matches.' : actual ? 'Classic artifact has a different launch wallet.' : 'Launch wallet was not found directly; verify report custody manually.',
    );
  }
  if (current.poolIds.length) {
    const structuredPoolIds = artifact.poolIds.length > 0;
    const matched = current.poolIds.filter((poolId) => (
      artifact.poolIds.includes(poolId)
      || (!structuredPoolIds && artifactContainsAddress(artifact, poolId))
    ));
    const poolState = comparisonExactEvidenceState({
      expectedCount: current.poolIds.length,
      matchedCount: matched.length,
      actualCount: artifact.poolIds.length,
      hasStructuredEvidence: structuredPoolIds,
    });
    addRow(
      'pools',
      'Pool IDs',
      `${matched.length}/${current.poolIds.length}`,
      String(artifact.poolIds.length || artifact.addresses.length),
      poolState,
      structuredPoolIds && poolState !== 'pass'
        ? `${matched.length}/${current.poolIds.length} current Trebuchet pool IDs matched, but the Classic artifact records ${artifact.poolIds.length} pool ID${artifact.poolIds.length === 1 ? '' : 's'}; the counts must match exactly.`
        : `${matched.length}/${current.poolIds.length} current Trebuchet pool IDs were found in the Classic artifact.`,
    );
  }
  const currentQuoteMints = [...new Set(current.pools.map((pool) => pool.quoteMint).filter(Boolean))];
  if (currentQuoteMints.length) {
    const artifactQuoteMints = new Set(artifact.pools.map((pool) => pool.quoteMint).filter(Boolean));
    const matched = currentQuoteMints.filter((quoteMint) => (
      artifactQuoteMints.has(quoteMint)
      || (artifactQuoteMints.size <= 0 && artifactContainsAddress(artifact, quoteMint))
    ));
    const quoteState = comparisonExactEvidenceState({
      expectedCount: currentQuoteMints.length,
      matchedCount: matched.length,
      actualCount: artifactQuoteMints.size,
      hasStructuredEvidence: artifactQuoteMints.size > 0,
    });
    addRow(
      'pool-quote-mints',
      'Pool quote mints',
      `${matched.length}/${currentQuoteMints.length}`,
      artifactQuoteMints.size ? String(artifactQuoteMints.size) : null,
      quoteState,
      quoteState === 'pass'
        ? 'Every current pool quote mint was found in the Classic artifact.'
        : artifactQuoteMints.size > 0
          ? `${matched.length}/${currentQuoteMints.length} current pool quote mints matched, but the Classic artifact records ${artifactQuoteMints.size}; the sets must match exactly.`
          : `${matched.length}/${currentQuoteMints.length} current pool quote mints were found in the Classic artifact.`,
    );
  }
  const poolParameterSummary = comparisonPoolParameterSummary(current.pools, artifact.pools);
  if (poolParameterSummary.total > 0) {
    addRow(
      'pool-parameters',
      'Pool parameters',
      `${poolParameterSummary.pass}/${poolParameterSummary.total}`,
      artifact.pools.length ? `${artifact.pools.length} pool record${artifact.pools.length === 1 ? '' : 's'}` : null,
      poolParameterSummary.mismatch > 0
        ? 'mismatch'
        : poolParameterSummary.missing > 0 ? 'missing' : 'pass',
      [
        `${poolParameterSummary.pass}/${poolParameterSummary.total} pool parameters match the current proof.`,
        poolParameterSummary.mismatched.length ? `Mismatched: ${poolParameterSummary.mismatched.join(', ')}.` : '',
        poolParameterSummary.missingLabels.length ? `Missing: ${poolParameterSummary.missingLabels.join(', ')}.` : '',
      ].filter(Boolean).join(' '),
    );
  }
  const currentCreatePoolTxs = [...new Set(current.pools.map((pool) => pool.createPoolTx).filter(Boolean))];
  if (currentCreatePoolTxs.length) {
    const artifactCreatePoolTxs = new Set(artifact.pools.map((pool) => pool.createPoolTx).filter(Boolean));
    const matched = currentCreatePoolTxs.filter((tx) => (
      artifactCreatePoolTxs.has(tx)
      || (artifactCreatePoolTxs.size <= 0 && artifactContainsAddress(artifact, tx))
    ));
    const createPoolState = comparisonExactEvidenceState({
      expectedCount: currentCreatePoolTxs.length,
      matchedCount: matched.length,
      actualCount: artifactCreatePoolTxs.size,
      hasStructuredEvidence: artifactCreatePoolTxs.size > 0,
    });
    addRow(
      'pool-create-transactions',
      'Pool create transactions',
      `${matched.length}/${currentCreatePoolTxs.length}`,
      artifactCreatePoolTxs.size ? String(artifactCreatePoolTxs.size) : null,
      createPoolState,
      createPoolState === 'pass'
        ? 'Every current pool-create transaction was found in the Classic artifact.'
        : artifactCreatePoolTxs.size > 0
          ? `${matched.length}/${currentCreatePoolTxs.length} current pool-create transactions matched, but the Classic artifact records ${artifactCreatePoolTxs.size}; the sets must match exactly.`
          : `${matched.length}/${currentCreatePoolTxs.length} current pool-create transactions were found in the Classic artifact.`,
    );
  }
  const currentAuthorityCount = authorityCount(current.authorities);
  if (currentAuthorityCount.pass > 0) {
    const artifactAuthorityCount = authorityComparisonSummary(current.authorities, artifact.authorities);
    addRow(
      'authority-posture',
      'Authority posture',
      `${currentAuthorityCount.pass}/${currentAuthorityCount.total}`,
      artifactAuthorityCount.known ? `${artifactAuthorityCount.pass}/${artifactAuthorityCount.total}` : null,
      artifactAuthorityCount.mismatch > 0
        ? 'mismatch'
        : artifactAuthorityCount.missing > 0 ? 'missing' : 'pass',
      artifactAuthorityCount.known
        ? [
          `${artifactAuthorityCount.pass}/${artifactAuthorityCount.total} authority fields match the current proof.`,
          artifactAuthorityCount.mismatchLabels.length ? `Mismatched: ${artifactAuthorityCount.mismatchLabels.join(', ')}.` : '',
          artifactAuthorityCount.missingLabels.length ? `Missing: ${artifactAuthorityCount.missingLabels.join(', ')}.` : '',
        ].filter(Boolean).join(' ')
        : 'Classic artifact did not expose authority posture directly.',
    );
  }
  [
    ['positionCount', 'Position count'],
    ['lockedPositionCount', 'Locked positions'],
    ['feeKeyCount', 'Fee Keys'],
  ].forEach(([key, label]) => {
    const expected = Number(current[key] || 0);
    const actual = Number(artifact[key]);
    if (expected <= 0) return;
    addRow(
      key,
      label,
      expected,
      Number.isFinite(actual) ? actual : null,
      Number.isFinite(actual) ? actual === expected ? 'pass' : 'mismatch' : 'warn',
      Number.isFinite(actual)
        ? `${actual}/${expected} recorded in classic artifact; the count must match exactly.`
        : 'Classic artifact did not expose this count directly; verify manually from rows.',
    );
  });
  const currentPositionMints = comparisonUniqueValues(current.positions, 'positionNftMint');
  if (currentPositionMints.length) {
    const artifactPositionMints = comparisonUniqueValues(artifact.positions, 'positionNftMint');
    const matched = comparisonMatchedStructuredValues(artifact, currentPositionMints, 'positionNftMint', artifact.positions.length > 0);
    const positionState = comparisonExactEvidenceState({
      expectedCount: currentPositionMints.length,
      matchedCount: matched.length,
      actualCount: artifactPositionMints.length,
      hasStructuredEvidence: artifact.positions.length > 0,
    });
    addRow(
      'position-nfts',
      'Position NFTs',
      `${matched.length}/${currentPositionMints.length}`,
      artifact.positions.length ? String(artifactPositionMints.length) : null,
      positionState,
      positionState === 'pass'
        ? 'Every current position NFT was found in the Classic artifact.'
        : artifact.positions.length
          ? `${matched.length}/${currentPositionMints.length} current position NFT mints matched, but the Classic artifact records ${artifactPositionMints.length}; the sets must match exactly.`
          : `${matched.length}/${currentPositionMints.length} current position NFT mints were found in the Classic artifact.`,
    );
  }
  const currentFeeKeyMints = comparisonUniqueValues(current.positions, 'feeKeyNftMint');
  if (currentFeeKeyMints.length) {
    const artifactFeeKeyMints = comparisonUniqueValues(artifact.positions, 'feeKeyNftMint');
    const matched = comparisonMatchedStructuredValues(artifact, currentFeeKeyMints, 'feeKeyNftMint', artifact.positions.length > 0);
    const feeKeyState = comparisonExactEvidenceState({
      expectedCount: currentFeeKeyMints.length,
      matchedCount: matched.length,
      actualCount: artifactFeeKeyMints.length,
      hasStructuredEvidence: artifact.positions.length > 0,
    });
    addRow(
      'fee-key-nfts',
      'Fee Key NFTs',
      `${matched.length}/${currentFeeKeyMints.length}`,
      artifact.positions.length ? String(artifactFeeKeyMints.length) : null,
      feeKeyState,
      feeKeyState === 'pass'
        ? 'Every current Fee Key NFT was found in the Classic artifact.'
        : artifact.positions.length
          ? `${matched.length}/${currentFeeKeyMints.length} current Fee Key NFT mints matched, but the Classic artifact records ${artifactFeeKeyMints.length}; the sets must match exactly.`
          : `${matched.length}/${currentFeeKeyMints.length} current Fee Key NFT mints were found in the Classic artifact.`,
    );
  }
  const currentFeeKeyRecipientWallets = comparisonUniqueValues(current.positions, ['recipient', 'transferredTo']);
  if (currentFeeKeyRecipientWallets.length) {
    const artifactFeeKeyRecipientWallets = comparisonUniqueValues(artifact.positions, ['recipient', 'transferredTo']);
    const matched = comparisonMatchedStructuredValues(artifact, currentFeeKeyRecipientWallets, ['recipient', 'transferredTo'], artifact.positions.length > 0);
    const recipientState = comparisonExactEvidenceState({
      expectedCount: currentFeeKeyRecipientWallets.length,
      matchedCount: matched.length,
      actualCount: artifactFeeKeyRecipientWallets.length,
      hasStructuredEvidence: artifact.positions.length > 0,
    });
    addRow(
      'fee-key-recipients',
      'Fee Key recipients',
      `${matched.length}/${currentFeeKeyRecipientWallets.length}`,
      artifact.positions.length ? String(artifactFeeKeyRecipientWallets.length) : null,
      recipientState,
      recipientState === 'pass'
        ? 'Every current Fee Key recipient or delivery wallet was found in the Classic artifact.'
        : artifact.positions.length
          ? `${matched.length}/${currentFeeKeyRecipientWallets.length} current Fee Key recipient or delivery wallets matched, but the Classic artifact records ${artifactFeeKeyRecipientWallets.length}; the sets must match exactly.`
          : `${matched.length}/${currentFeeKeyRecipientWallets.length} current Fee Key recipient or delivery wallets were found in the Classic artifact.`,
    );
  }
  const currentPositionTxs = comparisonUniqueValues(current.positions, ['openTx', 'lockTx', 'transferTx']);
  if (currentPositionTxs.length) {
    const artifactPositionTxs = comparisonUniqueValues(artifact.positions, ['openTx', 'lockTx', 'transferTx']);
    const matched = comparisonMatchedStructuredValues(artifact, currentPositionTxs, ['openTx', 'lockTx', 'transferTx'], artifact.positions.length > 0);
    const positionTxState = comparisonExactEvidenceState({
      expectedCount: currentPositionTxs.length,
      matchedCount: matched.length,
      actualCount: artifactPositionTxs.length,
      hasStructuredEvidence: artifact.positions.length > 0,
    });
    addRow(
      'position-transactions',
      'Position transactions',
      `${matched.length}/${currentPositionTxs.length}`,
      artifact.positions.length ? String(artifactPositionTxs.length) : null,
      positionTxState,
      positionTxState === 'pass'
        ? 'Every current open/lock/transfer transaction was found in the Classic artifact.'
        : artifact.positions.length
          ? `${matched.length}/${currentPositionTxs.length} current open/lock/transfer transactions matched, but the Classic artifact records ${artifactPositionTxs.length}; the sets must match exactly.`
        : `${matched.length}/${currentPositionTxs.length} current open/lock/transfer transactions were found in the Classic artifact.`,
    );
  }
  const positionShapeSummary = comparisonPositionShapeSummary(current.positions, artifact.positions);
  if (positionShapeSummary.total > 0) {
    addRow(
      'position-liquidity-shape',
      'Position liquidity shape',
      `${positionShapeSummary.pass}/${positionShapeSummary.total}`,
      artifact.positions.length ? `${artifact.positions.length} position record${artifact.positions.length === 1 ? '' : 's'}` : null,
      positionShapeSummary.mismatch > 0
        ? 'mismatch'
        : positionShapeSummary.missing > 0 ? 'missing' : 'pass',
      [
        `${positionShapeSummary.pass}/${positionShapeSummary.total} slice, ladder, and support shape fields match the current proof.`,
        positionShapeSummary.mismatched.length ? `Mismatched: ${positionShapeSummary.mismatched.join(', ')}.` : '',
        positionShapeSummary.missingLabels.length ? `Missing: ${positionShapeSummary.missingLabels.join(', ')}.` : '',
      ].filter(Boolean).join(' '),
    );
  }
  if (current.destinationWallet) {
    const actual = artifact.destinationWallet || (!artifact.structuredEvidence && artifactContainsAddress(artifact, current.destinationWallet) ? current.destinationWallet : null);
    addRow(
      'destination',
      'Destination wallet',
      current.destinationWallet,
      actual,
      actual === current.destinationWallet ? 'pass' : actual ? 'mismatch' : 'warn',
      actual === current.destinationWallet ? 'Destination matches.' : actual ? 'Classic artifact has a different destination.' : 'Destination was not found directly; final sweep may still be pending.',
    );
  }
  const plannedAirdrop = Number(current.airdrop.plannedRecipientCount || 0);
  const deliveredAirdrop = Number(current.airdrop.deliveredCount || 0);
  const failedAirdrop = Number(current.airdrop.failedCount || 0);
  const currentAirdropEvidence = comparisonAirdropDeliveryEvidenceState(current.airdrop);
  const currentAirdropWallets = comparisonAirdropWallets(current.airdrop);
  const matchedAirdropWallets = comparisonMatchedAirdropWallets(artifact, currentAirdropWallets);
  const currentAirdropTxs = comparisonAirdropTxs(current.airdrop);
  const matchedAirdropTxs = comparisonMatchedAirdropTxs(artifact, currentAirdropTxs);
  const structuredAirdropEvidence = comparisonHasStructuredAirdropEvidence(artifact);
  const artifactAirdropWallets = comparisonAirdropWallets(artifact.airdrop);
  const artifactAirdropTxs = comparisonAirdropTxs(artifact.airdrop);
  if (comparisonAirdropNeedsFullRows(current.airdrop)) {
    addRow(
      'airdrop-compact-evidence',
      'Airdrop row evidence',
      'full recipient and transaction rows',
      'hash-only compact proof',
      'missing',
      'This imported HTML proof stores full airdrop hashes with capped samples. Load the full JSON proof export or the original launch session before running exact Classic airdrop comparison.',
    );
  }
  if (plannedAirdrop > 0 || deliveredAirdrop > 0 || failedAirdrop > 0) {
    const actualDelivered = numberOrNull(artifact.airdrop.deliveredCount);
    const actualFailed = numberOrNull(artifact.airdrop.failedCount);
    const hasAirdropCounts = actualDelivered !== null || actualFailed !== null;
    const deliveredMatches = actualDelivered !== null && actualDelivered === deliveredAirdrop;
    const failedMatches = actualFailed !== null && actualFailed === failedAirdrop;
    const recipientEvidenceMatches = currentAirdropWallets.length > 0 && matchedAirdropWallets.length === currentAirdropWallets.length;
    const txEvidenceMatches = currentAirdropTxs.length <= 0 || matchedAirdropTxs.length === currentAirdropTxs.length;
    const structuredCountsMatch = structuredAirdropEvidence
      && (actualDelivered === null || actualDelivered === deliveredAirdrop)
      && (actualFailed === null || actualFailed === failedAirdrop)
      && (!artifactAirdropWallets.length || artifactAirdropWallets.length === currentAirdropWallets.length)
      && (!artifactAirdropTxs.length || artifactAirdropTxs.length === currentAirdropTxs.length);
    const deliveryState = !currentAirdropEvidence.complete
      ? 'missing'
      : hasAirdropCounts
        ? deliveredMatches && failedMatches && (!structuredAirdropEvidence || structuredCountsMatch) ? 'pass' : 'mismatch'
        : structuredAirdropEvidence
          ? recipientEvidenceMatches && txEvidenceMatches && structuredCountsMatch ? 'pass' : matchedAirdropWallets.length > 0 ? 'mismatch' : 'missing'
          : recipientEvidenceMatches && txEvidenceMatches ? 'pass' : matchedAirdropWallets.length > 0 ? 'warn' : 'missing';
    addRow(
      'airdrop-delivery',
      'Airdrop delivery',
      `${deliveredAirdrop}/${plannedAirdrop} delivered, ${failedAirdrop} failed`,
      hasAirdropCounts
        ? `${actualDelivered ?? '?'} delivered, ${actualFailed ?? '?'} failed`
        : recipientEvidenceMatches ? `${matchedAirdropWallets.length} recipient wallet${matchedAirdropWallets.length === 1 ? '' : 's'} found` : null,
      deliveryState,
      !currentAirdropEvidence.complete
        ? `Current Trebuchet proof is missing exact airdrop evidence: ${currentAirdropEvidence.missing.join(', ')}.`
      : deliveryState === 'pass'
        ? `Artifact records ${actualDelivered ?? deliveredAirdrop} delivered and ${actualFailed ?? failedAirdrop} failed recipients.`
        : structuredAirdropEvidence
          ? `Classic structured airdrop evidence must match exactly; artifact records ${actualDelivered ?? '?'} delivered, ${actualFailed ?? '?'} failed, ${artifactAirdropWallets.length} wallet${artifactAirdropWallets.length === 1 ? '' : 's'}, and ${artifactAirdropTxs.length} transaction${artifactAirdropTxs.length === 1 ? '' : 's'}.`
        : recipientEvidenceMatches && txEvidenceMatches
          ? 'Classic artifact exposed the expected airdrop recipient wallets and delivered transaction signatures.'
          : 'Classic artifact did not expose enough airdrop delivery evidence directly.',
    );
  }
  if (currentAirdropEvidence.required && currentAirdropEvidence.recipientCount < currentAirdropEvidence.expectedCount) {
    addRow(
      'airdrop-recipients',
      'Airdrop recipients',
      `${currentAirdropEvidence.recipientCount}/${currentAirdropEvidence.expectedCount}`,
      null,
      'missing',
      'Current Trebuchet proof is missing exact airdrop recipient wallet rows; load the full proof or original launch session before comparing Classic.',
    );
  } else if (currentAirdropWallets.length) {
    const recipientState = comparisonExactEvidenceState({
      expectedCount: currentAirdropWallets.length,
      matchedCount: matchedAirdropWallets.length,
      actualCount: artifactAirdropWallets.length,
      hasStructuredEvidence: structuredAirdropEvidence && artifactAirdropWallets.length > 0,
    });
    addRow(
      'airdrop-recipients',
      'Airdrop recipients',
      `${matchedAirdropWallets.length}/${currentAirdropWallets.length}`,
      artifact.airdrop.transferred.length || artifact.airdrop.failed.length
        ? `${comparisonAirdropWallets(artifact.airdrop).length} structured`
        : artifact.addresses.length ? 'text evidence' : null,
      recipientState,
      recipientState === 'pass'
        ? 'Every current airdrop recipient wallet was found in the Classic artifact.'
        : structuredAirdropEvidence && artifactAirdropWallets.length > 0
          ? `${matchedAirdropWallets.length}/${currentAirdropWallets.length} current airdrop recipient wallets matched, but the Classic artifact records ${artifactAirdropWallets.length}; the sets must match exactly.`
          : `${matchedAirdropWallets.length}/${currentAirdropWallets.length} current airdrop recipient wallets were found in the Classic artifact.`,
    );
  }
  if (currentAirdropEvidence.required && currentAirdropEvidence.transactionCount < currentAirdropEvidence.expectedCount) {
    addRow(
      'airdrop-transactions',
      'Airdrop transactions',
      `${currentAirdropEvidence.transactionCount}/${currentAirdropEvidence.expectedCount}`,
      null,
      'missing',
      'Current Trebuchet proof is missing exact delivered airdrop transaction signatures; load the full proof or original launch session before comparing Classic.',
    );
  } else if (currentAirdropTxs.length) {
    const txState = comparisonExactEvidenceState({
      expectedCount: currentAirdropTxs.length,
      matchedCount: matchedAirdropTxs.length,
      actualCount: artifactAirdropTxs.length,
      hasStructuredEvidence: structuredAirdropEvidence && artifactAirdropTxs.length > 0,
    });
    addRow(
      'airdrop-transactions',
      'Airdrop transactions',
      `${matchedAirdropTxs.length}/${currentAirdropTxs.length}`,
      artifact.airdrop.transferred.length || artifact.airdrop.failed.length
        ? `${artifactAirdropTxs.length} structured`
        : artifact.signatures.length ? 'text evidence' : null,
      txState,
      txState === 'pass'
        ? 'Every current airdrop transaction signature was found in the Classic artifact.'
        : structuredAirdropEvidence && artifactAirdropTxs.length > 0
          ? `${matchedAirdropTxs.length}/${currentAirdropTxs.length} current airdrop transaction signatures matched, but the Classic artifact records ${artifactAirdropTxs.length}; the sets must match exactly.`
          : `${matchedAirdropTxs.length}/${currentAirdropTxs.length} current airdrop transaction signatures were found in the Classic artifact.`,
    );
  }
  const passCount = rows.filter((row) => row.state === 'pass').length;
  const mismatchCount = rows.filter((row) => row.state === 'mismatch').length;
  const missingCount = rows.filter((row) => row.state === 'missing').length;
  const warnCount = rows.filter((row) => row.state === 'warn').length;
  const status = classicComparisonStatusFromCounts({ mismatchCount, missingCount, warnCount });
  return {
    status,
    comparedAt: new Date().toISOString(),
    artifactKind: artifact.kind,
    artifactSource: artifact.sourceKind,
    structuredEvidence: artifact.structuredEvidence === true,
    proofFingerprint: classicComparisonProofFingerprint(current),
    passCount,
    warnCount,
    missingCount,
    mismatchCount,
    fieldCount: rows.length,
    classicMint: artifact.mint || null,
    classicPoolCount: artifact.poolIds.length,
    rows,
  };
}
