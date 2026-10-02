function downloadTextFile(filename, contents, mimeType, label) {
  if (typeof Blob !== 'function' || !URL?.createObjectURL) {
    notify(`${label || 'Download'} is unavailable in this runtime`);
    return false;
  }
  const blob = new Blob([String(contents || '')], { type: mimeType || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return true;
}

function downloadJsonFile(filename, payload, label) {
  return downloadTextFile(
    filename,
    JSON.stringify(payload, null, 2),
    'application/json',
    label,
  );
}

function updateLastFullRunCompletionFromProof(proof = currentLaunchProof(), config = currentLaunchConfig()) {
  if (!state.lastFullRun) return;
  const completion = fullRunCompletionAudit(proof, config);
  state.lastFullRun = {
    ...state.lastFullRun,
    status: completion.complete ? 'complete' : 'needs-proof',
    completion,
    proof,
    completedAt: completion.complete
      ? state.lastFullRun.completedAt || new Date().toISOString()
      : null,
  };
}

function localDossierEvidenceRecord({
  proof = currentLaunchProof(),
  config = currentLaunchConfig(),
  filename,
  kind = 'local-dossier-html',
  dataVersion = null,
  downloadedAt = new Date().toISOString(),
} = {}) {
  config = proofConfigForFingerprint(proof, config);
  if (!proof || typeof proof !== 'object' || proof.source === 'demo-run') return null;
  if (!String(filename || '').trim()) return null;
  if (!proofCanCreateLocalDossier(proof, config)) return null;
  const sweepEvidenceHash = terminalSweepEvidenceHashForProof(proof);
  return attachProofFingerprint({
    status: 'downloaded',
    kind,
    filename,
    mint: proof.token.mint,
    downloadedAt,
    dataVersion,
    heldReserveAudit: buildV2ReportHeldReserveAudit(config, currentClassicFundingEstimateForConfig(config)),
    ...(sweepEvidenceHash ? { sweepEvidenceHash } : {}),
  }, proof, config);
}

function proofWithLocalDossierEvidence({
  proof = currentLaunchProof(),
  config = currentLaunchConfig(),
  filename,
  kind = 'local-dossier-html',
  dataVersion = null,
  downloadedAt,
} = {}) {
  const record = localDossierEvidenceRecord({
    proof,
    config,
    filename,
    kind,
    dataVersion,
    downloadedAt,
  });
  if (!record) return { proof, record: null };
  return {
    proof: {
      ...proof,
      localDossier: record,
      launchConfig: exportableLaunchConfigSnapshot(proofConfigForFingerprint(proof, config)),
    },
    record,
  };
}

function recordLocalDossierEvidence({
  proof = currentLaunchProof(),
  config = currentLaunchConfig(),
  filename,
  kind = 'local-dossier-html',
  dataVersion = null,
  downloadedAt,
} = {}) {
  const { proof: proofWithEvidence, record } = proofWithLocalDossierEvidence({
    proof,
    config,
    filename,
    kind,
    dataVersion,
    downloadedAt,
  });
  if (!record) return null;
  state.lastLocalDossier = record;
  const mergedProof = rememberLaunchProof(proofWithEvidence);
  updateLastFullRunCompletionFromProof(mergedProof || proof, config);
  return record;
}

function downloadReportPreview() {
  const report = buildReportPreview();
  const ok = downloadJsonFile(
    `trebuchet-${String(report.token.symbol || 'token').toLowerCase()}-launch-preview.json`,
    report,
    'Report download',
  );
  if (!ok) return;
  notify('Launch report preview downloaded');
}

function exportableLaunchConfigSnapshot(config = currentLaunchConfig()) {
  const token = config?.token || {};
  const logo = token.logo && typeof token.logo === 'object'
    ? {
      name: token.logo.name || null,
      type: token.logo.type || null,
      size: Number.isFinite(Number(token.logo.size)) ? Number(token.logo.size) : null,
    }
    : null;
  return {
    schema: 'trebuchet-v2-launch-config',
    source: 'trebuchet-v2',
    token: {
      name: token.name || null,
      symbol: token.symbol || null,
      supply: token.supply || null,
      description: token.description || null,
      decimals: token.decimals ?? 9,
      mintFormat: token.mintFormat === 'classic-spl' ? 'classic-spl' : 'token-2022',
      tokenProgram: token.tokenProgram || null,
      metadataStandard: token.metadataStandard || null,
      sealedLaunch: token.sealedLaunch === true,
      logo,
    },
    launchSol: Number.isFinite(Number(config?.launchSol)) ? Number(config.launchSol) : null,
    mode: config?.mode || null,
    vanity: config?.vanity || null,
    poolTopology: config?.poolTopology || null,
    funding: {
      launchSol: Number.isFinite(Number(config?.funding?.launchSol ?? config?.launchSol))
        ? Number(config.funding?.launchSol ?? config.launchSol)
        : null,
      targetMarketCapUsd: Number.isFinite(Number(config?.funding?.targetMarketCapUsd ?? config?.poolTopology?.targetMarketCapUsd))
        ? Number(config?.funding?.targetMarketCapUsd ?? config?.poolTopology?.targetMarketCapUsd)
        : null,
    },
  };
}

function v2JsonClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function compactAirdropEvidenceForHtml(airdrop = {}, limit = V2_HTML_PROOF_AIRDROP_SAMPLE_LIMIT) {
  if (!airdrop || typeof airdrop !== 'object') return airdrop;
  const compact = { ...airdrop };
  ['recipients', 'transferred', 'failed'].forEach((key) => {
    const rows = Array.isArray(airdrop[key]) ? airdrop[key] : [];
    const storedHash = typeof airdrop[`${key}Hash`] === 'string' ? airdrop[`${key}Hash`].trim() : '';
    compact[`${key}Hash`] = storedHash || comparisonAirdropListHash(rows);
    if (rows.length > limit) {
      compact[key] = [];
      compact[`${key}Sample`] = rows.slice(0, limit);
      compact[`${key}TruncatedCount`] = rows.length - limit;
    } else {
      compact[key] = rows;
      delete compact[`${key}Sample`];
      delete compact[`${key}TruncatedCount`];
    }
  });
  compact.compactRows = true;
  compact.sampleLimit = limit;
  return compact;
}

function compactLaunchConfigForHtml(config = null) {
  if (!config || typeof config !== 'object') return config;
  const compact = { ...config };
  if (config.poolTopology && typeof config.poolTopology === 'object') {
    compact.poolTopology = { ...config.poolTopology };
    if (config.poolTopology.airdrop && typeof config.poolTopology.airdrop === 'object') {
      compact.poolTopology.airdrop = compactAirdropEvidenceForHtml(config.poolTopology.airdrop);
    }
  }
  return compact;
}

function compactV2ProofPayloadForHtml(payload = {}) {
  const compact = v2JsonClone(payload);
  if (!compact || typeof compact !== 'object') return payload;
  compact.compactForHtml = {
    airdropSampleLimit: V2_HTML_PROOF_AIRDROP_SAMPLE_LIMIT,
    fullAirdropRowsHashed: true,
  };
  if (compact.proof?.airdrop) {
    compact.proof.airdrop = compactAirdropEvidenceForHtml(compact.proof.airdrop);
  }
  if (compact.proof?.launchConfig) {
    compact.proof.launchConfig = compactLaunchConfigForHtml(compact.proof.launchConfig);
  }
  if (compact.launchConfig) {
    compact.launchConfig = compactLaunchConfigForHtml(compact.launchConfig);
  }
  if (compact.launchData?.airdrop) {
    compact.launchData.airdrop = compactAirdropEvidenceForHtml(compact.launchData.airdrop);
  }
  if (compact.launchData?.poolTopology?.airdrop) {
    compact.launchData.poolTopology = {
      ...compact.launchData.poolTopology,
      airdrop: compactAirdropEvidenceForHtml(compact.launchData.poolTopology.airdrop),
    };
  }
  return compact;
}

function proofExportParityBundle(proof = currentLaunchProof(), config = currentLaunchConfig(), data = {}) {
  const proofConfig = proofConfigForFingerprint(proof, config);
  const expectedFingerprint = launchProofFingerprint(proof, proofConfig);
  const dataAudit = data?.reportParityAudit && typeof data.reportParityAudit === 'object'
    ? data.reportParityAudit
    : null;
  const dataGate = data?.classicRetirementGate && typeof data.classicRetirementGate === 'object'
    ? data.classicRetirementGate
    : null;
  const dataFieldVerification = data?.fieldVerification && typeof data.fieldVerification === 'object'
    ? data.fieldVerification
    : null;
  const audit = reportParityAuditMatchesProof(dataAudit, proof, proofConfig)
    ? dataAudit
    : buildV2ReportParityAudit(proof, proofConfig);
  const retirementGate = dataGate?.proofFingerprint === expectedFingerprint
    && classicRetirementGateMatchesProof(dataGate, proof, audit, proofConfig)
    ? dataGate
    : buildClassicRetirementGate(proof, audit, proofConfig);
  const fieldVerification = dataFieldVerification?.proofFingerprint === expectedFingerprint
    && fieldVerificationMatchesProof(dataFieldVerification, proof, proofConfig, audit, retirementGate)
    ? dataFieldVerification
    : buildV2FieldVerification({
      proof,
      config: proofConfig,
      audit,
      retirementGate,
    });
  return {
    reportParityAudit: audit,
    classicRetirementGate: retirementGate,
    fieldVerification,
  };
}

function classicReportComparisonForProofExport(proof = currentLaunchProof(), config = currentLaunchConfig()) {
  const normalized = normalizeClassicReportComparison(state.classicReportComparison);
  if (!normalized.result) return null;
  if (!classicComparisonIsRetirementGrade(normalized.result, proof, config)) return null;
  return normalized;
}

function pruneLaunchDataEvidenceArtifactsForExport(data = null, proof = currentLaunchProof(), config = currentLaunchConfig()) {
  if (!data || typeof data !== 'object') return data;
  const cleaned = { ...data };
  const comparison = classicComparisonResultObject(cleaned.classicReportComparison?.result || cleaned.classicReportComparison);
  if (
    Object.prototype.hasOwnProperty.call(cleaned, 'classicReportComparison')
    && !classicComparisonIsRetirementGrade(comparison, proof, config)
  ) {
    delete cleaned.classicReportComparison;
  }
  if (cleaned.proof && typeof cleaned.proof === 'object') {
    delete cleaned.proof;
  }
  return cleaned;
}

function buildV2ProofExportPayload({
  proof = currentLaunchProof(),
  config = currentLaunchConfig(),
  launchData = null,
  compactForHtml = false,
} = {}) {
  const proofConfig = proofConfigForFingerprint(proof, config);
  const proofForPayload = proof && typeof proof === 'object'
    ? pruneLaunchProofEvidenceArtifactsForExport(proof, proofConfig)
    : proof;
  const exportLaunchConfig = exportableLaunchConfigSnapshot(proofConfig);
  const exportProof = proofForPayload && typeof proofForPayload === 'object'
    ? { ...proofForPayload, launchConfig: exportLaunchConfig }
    : proofForPayload;
  const data = launchData || buildV2LaunchReportData(proofForPayload, proofConfig);
  const parityBundle = proofExportParityBundle(proofForPayload, proofConfig, data);
  const exportLaunchData = data && typeof data === 'object'
    ? { ...pruneLaunchDataEvidenceArtifactsForExport(data, proofForPayload, proofConfig), ...parityBundle }
    : data;
  const payload = {
    schema: 'trebuchet-v2-proof',
    source: 'trebuchet-v2',
    dataVersion: data?.dataVersion || V2_REPORT_DATA_VERSION,
    exportedAt: data?.generatedAt || new Date().toISOString(),
    proof: exportProof || null,
    launchConfig: exportLaunchConfig,
    launchData: exportLaunchData,
    reportParityAudit: parityBundle.reportParityAudit,
    classicRetirementGate: parityBundle.classicRetirementGate,
    fieldVerification: parityBundle.fieldVerification,
    classicReportComparison: classicReportComparisonForProofExport(proofForPayload, proofConfig),
  };
  return compactForHtml ? compactV2ProofPayloadForHtml(payload) : payload;
}

function htmlScriptJson(value) {
  return JSON.stringify(value || null)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function proofPayloadFromImportText(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Proof import is empty');
  try {
    return JSON.parse(raw);
  } catch {
    // Keep going: Trebuchet HTML dossiers embed the same non-secret proof payload.
  }
  const match = raw.match(/<script\b(?=[^>]*\bid=["']trebuchet-v2-proof["'])[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) {
    throw new Error('Proof import does not contain a Trebuchet JSON proof or HTML launch record payload');
  }
  try {
    return JSON.parse(String(match[1] || '').trim());
  } catch {
    throw new Error('Embedded Trebuchet proof payload could not be parsed');
  }
}

function importedProofPayloadHasV2Provenance(payload = {}) {
  if (!payload || typeof payload !== 'object') return false;
  const source = String(payload.source || '').trim();
  const schema = String(payload.schema || '').trim();
  const kind = String(payload.kind || '').trim();
  const launchData = payload.launchData && typeof payload.launchData === 'object'
    ? payload.launchData
    : {};
  const proof = payload.proof && typeof payload.proof === 'object'
    ? payload.proof
    : launchData.proof && typeof launchData.proof === 'object'
      ? launchData.proof
      : null;
  return Boolean(
    source === 'trebuchet-v2'
      || schema === 'trebuchet-v2-proof'
      || kind === 'trebuchet-v2-proof'
      || String(launchData.source || '').trim() === 'trebuchet-v2'
      || String(launchData.schema || '').trim() === 'trebuchet-v2-proof'
      || String(launchData.kind || '').trim() === 'trebuchet-v2-proof'
      || String(proof?.source || '').trim() === 'trebuchet-v2'
      || String(proof?.schema || '').trim() === 'trebuchet-v2-proof'
      || String(proof?.kind || '').trim() === 'trebuchet-v2-proof'
  );
}

function importedProofPayloadHasClassicSource(payload = {}, proof = null) {
  return String(payload?.source || '').trim() === 'classic'
    || String(payload?.launch?.source || '').trim() === 'classic'
    || String(payload?.launchData?.source || '').trim() === 'classic'
    || String(proof?.source || '').trim() === 'classic';
}

function importedLaunchConfigSnapshotIsV2Export(config = null) {
  return Boolean(
    config
      && typeof config === 'object'
      && String(config.schema || '').trim() === 'trebuchet-v2-launch-config'
      && String(config.source || '').trim() === 'trebuchet-v2'
  );
}

function downloadV2Proof() {
  const proof = currentLaunchProof();
  const config = proofConfigForFingerprint(proof, currentLaunchConfig());
  const symbolBase = String(proof?.token?.symbol || config.token.symbol || 'token').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const filename = `trebuchet-${symbolBase || 'token'}-proof.json`;
  const downloadedAt = new Date().toISOString();
  const { proof: proofForExport } = proofWithLocalDossierEvidence({
    proof,
    config,
    filename,
    kind: 'local-proof-json',
    dataVersion: V2_REPORT_DATA_VERSION,
    downloadedAt,
  });
  const launchData = buildV2LaunchReportData(proofForExport, config);
  const payload = buildV2ProofExportPayload({ proof: proofForExport, config, launchData });
  const symbol = String(payload.launchData.symbol || config.token.symbol || 'token').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const ok = downloadJsonFile(filename || `trebuchet-${symbol || 'token'}-proof.json`, payload, 'Proof download');
  if (!ok) return;
  recordLocalDossierEvidence({
    proof,
    config,
    filename,
    kind: 'local-proof-json',
    dataVersion: launchData.dataVersion,
    downloadedAt,
  });
  renderAll();
  notify('Launch record downloaded');
}

function downloadV2DossierHtml() {
  const proof = currentLaunchProof();
  const config = proofConfigForFingerprint(proof, currentLaunchConfig());
  if (proof?.token?.mint) {
    if (!proofCanCreateLocalDossier(proof, config)) {
      notify('Record the token and pool IDs before downloading the launch record');
      return;
    }
    const airdropIssue = airdropCompletionIssue(
      airdropCompletionStatus(proof, config.poolTopology),
      'downloading the launch record',
    );
    if (airdropIssue) {
      notify(airdropIssue);
      return;
    }
  }
  const initialLaunchData = buildV2LaunchReportData(proof, config);
  const symbol = String(initialLaunchData.symbol || config.token.symbol || 'token').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const suffix = proof?.token?.mint ? 'dossier' : 'dossier-preview';
  const filename = `trebuchet-${symbol || 'token'}-${suffix}.html`;
  const downloadedAt = new Date().toISOString();
  const { proof: proofForReport } = proofWithLocalDossierEvidence({
    proof,
    config,
    filename,
    kind: 'local-dossier-html',
    dataVersion: V2_REPORT_DATA_VERSION,
    downloadedAt,
  });
  const launchData = buildV2LaunchReportData(proofForReport, config);
  const html = buildV2LaunchReportHtml({ proof: proofForReport, config, launchData });
  const ok = downloadTextFile(
    filename,
    html,
    'text/html;charset=utf-8',
    'Dossier download',
  );
  if (!ok) return;
  recordLocalDossierEvidence({
    proof,
    config,
    filename,
    kind: 'local-dossier-html',
    dataVersion: launchData.dataVersion,
    downloadedAt,
  });
  renderAll();
  checkExecutionReadiness().catch(() => null);
  notify('Saved launch record attached · final sweep can continue without publishing');
}

function proofFromImportedPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Proof JSON could not be parsed');
  }
  if (!importedProofPayloadHasV2Provenance(payload)) {
    throw new Error('Proof JSON is not a Trebuchet proof export');
  }
  if (importedProofPayloadHasClassicSource(payload)) {
    throw new Error('Proof JSON is a Classic artifact, not a Trebuchet proof export');
  }
  const proof = payload.proof || payload.launchData?.proof || null;
  if (!proof || typeof proof !== 'object') {
    throw new Error('Proof JSON does not contain a Trebuchet launch record');
  }
  if (importedProofPayloadHasClassicSource(payload, proof)) {
    throw new Error('Proof JSON is a Classic artifact, not a Trebuchet proof export');
  }
  const explicitLaunchConfig = importedExplicitLaunchConfig(payload);
  if (!importedLaunchConfigSnapshotIsV2Export(explicitLaunchConfig)) {
    throw new Error('Proof JSON is missing a Trebuchet launch-config snapshot');
  }
  const proofForImport = { ...proof };
  if (proofForImport.reportParity && typeof proofForImport.reportParity === 'object') {
    proofForImport.reportParity = {
      ...proofForImport.reportParity,
      classicArtifactCompared: false,
      comparedAt: null,
      comparison: null,
      classicComparison: null,
      importedComparisonRequiresArtifact: true,
    };
  }
  proofForImport.launchConfig = exportableLaunchConfigSnapshot(importedProofComparisonConfig(payload));
  const reportPublish = importedReportPublishEvidence(payload, proofForImport);
  if (reportPublish) {
    proofForImport.reportPublish = reportPublish;
  } else if (proofForImport.reportPublish) {
    delete proofForImport.reportPublish;
  }
  const localDossier = importedLocalDossierEvidence(payload, proofForImport);
  if (localDossier) {
    proofForImport.localDossier = localDossier;
  } else if (proofForImport.localDossier) {
    delete proofForImport.localDossier;
  }
  const normalized = normalizeStoredLaunchProof({ proof: proofForImport, savedAt: Date.now() });
  if (!normalized) {
    throw new Error('Proof JSON does not contain a real Trebuchet launch record');
  }
  return normalized.proof;
}

function importedExplicitLaunchConfig(payload = {}) {
  const proof = payload?.proof && typeof payload.proof === 'object'
    ? payload.proof
    : payload?.launchData?.proof && typeof payload.launchData.proof === 'object'
      ? payload.launchData.proof
      : payload?.token?.mint || payload?.liquidity
        ? payload
        : null;
  const proofLaunchConfig = proof?.launchConfig && typeof proof.launchConfig === 'object'
    ? proof.launchConfig
    : null;
  if (proofLaunchConfig) return proofLaunchConfig;
  if (payload?.launchConfig && typeof payload.launchConfig === 'object') return payload.launchConfig;
  if (payload?.launchData?.launchConfig && typeof payload.launchData.launchConfig === 'object') {
    return payload.launchData.launchConfig;
  }
  return null;
}

function importedProofComparisonConfig(payload = {}) {
  const current = currentLaunchConfig();
  const launchData = payload?.launchData && typeof payload.launchData === 'object' ? payload.launchData : {};
  const exportedConfig = importedExplicitLaunchConfig(payload) || {};
  const token = {
    ...(current.token || {}),
    ...(exportedConfig.token || {}),
  };
  if (launchData.name) token.name = launchData.name;
  if (launchData.symbol) token.symbol = launchData.symbol;
  if (launchData.totalSupply != null) token.supply = launchData.totalSupply;
  if (launchData.decimals != null) token.decimals = launchData.decimals;

  const exportedPoolTopology = exportedConfig.poolTopology || launchData.poolTopology || {};
  const exportedSweepDestination = String(exportedPoolTopology.sweepDestination || '').trim();
  const poolTopology = {
    ...(current.poolTopology || {}),
    ...exportedPoolTopology,
  };
  if (!exportedSweepDestination && launchData.destinationWallet) {
    poolTopology.sweepDestination = launchData.destinationWallet;
  }

  return {
    ...current,
    ...exportedConfig,
    token,
    poolTopology,
  };
}

function importedReportPublishEvidence(payload = {}, proof = null) {
  if (!importedExplicitLaunchConfig(payload)) return null;
  const candidates = [
    proof?.reportPublish,
    payload?.launchData?.reportPublish,
    payload?.reportPublish,
  ].filter((candidate, index, list) => candidate && list.indexOf(candidate) === index);
  if (!candidates.length) return null;
  const config = importedProofComparisonConfig(payload);
  for (const candidate of candidates) {
    const record = { ...candidate };
    const proofWithCandidate = proof && typeof proof === 'object'
      ? { ...proof, reportPublish: record }
      : proof;
    if (!reportPublishFinalizationIssue(record, proofWithCandidate || proof, config)) {
      return record;
    }
  }
  return null;
}

function importedLocalDossierEvidence(payload = {}, proof = null) {
  if (!importedExplicitLaunchConfig(payload)) return null;
  const candidates = [
    proof?.localDossier,
    payload?.launchData?.localDossier,
    payload?.localDossier,
  ].filter((candidate, index, list) => candidate && list.indexOf(candidate) === index);
  if (!candidates.length) return null;
  const config = importedProofComparisonConfig(payload);
  for (const candidate of candidates) {
    const record = { ...candidate };
    const proofWithCandidate = proof && typeof proof === 'object'
      ? { ...proof, localDossier: record }
      : proof;
    if (!localDossierFinalizationIssue(record, proofWithCandidate || proof, config)) {
      return record;
    }
  }
  return null;
}

function restoreImportedProofComparison(payload, proof) {
  const comparisonWrapper = payload?.classicReportComparison || payload?.launchData?.classicReportComparison || null;
  const comparisonFrom = (candidate = null) => {
    if (!candidate || typeof candidate !== 'object') return null;
    if (
      candidate.status
      || candidate.proofFingerprint
      || Array.isArray(candidate.rows)
      || Number(candidate.fieldCount || 0) > 0
    ) {
      return candidate;
    }
    return null;
  };
  const importedComparison =
    comparisonFrom(comparisonWrapper?.result)
    || comparisonFrom(comparisonWrapper)
    || comparisonFrom(payload?.proof?.reportParity?.comparison)
    || comparisonFrom(payload?.proof?.reportParity?.classicComparison)
    || comparisonFrom(payload?.launchData?.proof?.reportParity?.comparison)
    || comparisonFrom(payload?.launchData?.proof?.reportParity?.classicComparison)
    || null;
  if (!importedComparison || typeof importedComparison !== 'object') return;
  const importedInput = String(
    comparisonWrapper?.input
    || payload?.classicArtifactInput
    || payload?.launchData?.classicArtifactInput
    || '',
  ).trim();
  if (!importedInput) {
    state.classicReportComparison = {
      input: '',
      result: null,
      comparedAt: null,
      error: 'Imported proof comparison needs the original Classic artifact text; paste or load it to compare locally.',
    };
    persistClassicReportComparison();
    return;
  }
  try {
    const result = compareClassicReportArtifact(importedInput, proof, importedProofComparisonConfig(payload));
    state.classicReportComparison = {
      input: importedInput,
      result,
      comparedAt: result.comparedAt,
      error: null,
    };
    persistClassicReportComparison();
    const retirementGradeComparison = classicComparisonIsRetirementGrade(result, proof, importedProofComparisonConfig(payload));
    if (retirementGradeComparison) {
      rememberLaunchProof({
        ...proof,
        reportParity: {
          ...(proof.reportParity || {}),
          classicArtifactCompared: true,
          comparedAt: result.comparedAt,
          comparison: result,
        },
      });
    }
  } catch (error) {
    state.classicReportComparison = {
      input: importedInput,
      result: null,
      comparedAt: null,
      error: error.message || 'Imported Classic artifact comparison failed',
    };
    persistClassicReportComparison();
  }
}

async function loadV2ProofFile(file) {
  try {
    const safeFile = validateProofFile(file);
    if (!safeFile) return;
    const text = await readFileAsText(safeFile, 'Proof import');
    const payload = proofPayloadFromImportText(text);
    const proof = proofFromImportedPayload(payload);
    const mergedProof = rememberLaunchProof(proof) || proof;
    const mergedConfig = proofConfigForFingerprint(mergedProof, currentLaunchConfig());
    state.lastReportPublish = reportPublishIsProofCurrent(mergedProof?.reportPublish, mergedProof, mergedConfig)
      ? mergedProof.reportPublish
      : null;
    state.lastLocalDossier = localDossierIsProofCurrent(mergedProof?.localDossier, mergedProof, mergedConfig)
      ? mergedProof.localDossier
      : null;
    restoreImportedProofComparison(payload, mergedProof);
    renderAll();
    notify('Launch record loaded');
  } catch (error) {
    notify(error.message || 'Launch record import failed');
  }
}

function requestV2ProofImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,text/html,.json,.html,.htm';
  input.addEventListener('change', () => {
    loadV2ProofFile(input.files?.[0] || null).finally(() => {
      input.value = '';
    });
  }, { once: true });
  input.click();
}

async function loadClassicArtifactFile(file) {
  try {
    const safeFile = validateClassicArtifactFile(file);
    if (!safeFile) return;
    const text = await readFileAsText(safeFile, 'Classic artifact');
    state.classicReportComparison = {
      input: text,
      result: null,
      comparedAt: null,
      error: null,
    };
    persistClassicReportComparison();
    renderAll();
    notify('Classic artifact loaded');
  } catch (error) {
    state.classicReportComparison = {
      ...state.classicReportComparison,
      result: null,
      comparedAt: null,
      error: error.message || 'Classic artifact import failed',
    };
    persistClassicReportComparison();
    renderAll();
    notify(state.classicReportComparison.error);
  }
}

function requestClassicArtifactImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,text/html,text/plain,.json,.html,.htm,.txt';
  input.addEventListener('change', () => {
    loadClassicArtifactFile(input.files?.[0] || null).finally(() => {
      input.value = '';
    });
  }, { once: true });
  input.click();
}

function runClassicArtifactComparison() {
  try {
    const input = state.classicReportComparison.input || document.querySelector('.classic-artifact-text')?.value || '';
    const proof = currentLaunchProof();
    const config = proofConfigForFingerprint(proof, currentLaunchConfig());
    const result = compareClassicReportArtifact(input, proof, config);
    state.classicReportComparison = {
      input,
      result,
      comparedAt: result.comparedAt,
      error: null,
    };
    persistClassicReportComparison();
    if (proof && typeof proof === 'object') {
      const retirementGradeComparison = classicComparisonIsRetirementGrade(result, proof, config);
      rememberLaunchProof({
        ...proof,
        reportParity: {
          ...(proof.reportParity || {}),
          classicArtifactCompared: retirementGradeComparison,
          comparedAt: result.comparedAt,
          comparison: result,
        },
      });
    }
    renderAll();
    notify(result.status === 'pass' ? 'Classic artifact matches the Trebuchet proof' : 'Classic artifact needs review');
  } catch (error) {
    state.classicReportComparison = {
      ...state.classicReportComparison,
      input: state.classicReportComparison.input || document.querySelector('.classic-artifact-text')?.value || '',
      result: null,
      comparedAt: null,
      error: error.message || 'Classic artifact comparison failed',
    };
    persistClassicReportComparison();
    renderAll();
    notify(state.classicReportComparison.error);
  }
}

function clearClassicArtifactComparison() {
  state.classicReportComparison = {
    input: '',
    result: null,
    comparedAt: null,
    error: null,
  };
  persistClassicReportComparison();
  const proof = currentLaunchProof();
  if (proof?.reportParity) {
    rememberLaunchProof({
      ...proof,
      reportParity: {
        ...proof.reportParity,
        classicArtifactCompared: false,
        comparison: null,
        classicComparison: null,
        comparedAt: null,
      },
    });
  }
  renderAll();
  notify('Classic artifact comparison cleared');
}

async function publishV2LaunchReport({ quiet = false, refreshReadiness = true, ledger = true } = {}) {
  const proof = currentLaunchProof();
  if (!proof?.token?.mint) {
    if (!quiet) notify('Create the token before publishing a report');
    return;
  }
  const config = proofConfigForFingerprint(proof, currentLaunchConfig());
  const recordedPoolIds = launchProofPoolIds(proof);
  if (!proofHasReportPublishEvidence(proof, config)) {
    if (!quiet) notify('Complete liquidity proof before publishing a report');
    return;
  }
  if (!proof?.journalId) {
    const reason = 'Refresh journal-backed launch record before publishing a report';
    if (!quiet) notify(reason);
    return { skipped: true, reason, launchJournalMissing: true };
  }
  if (state.prefs.publishLaunchReport === false) {
    if (!quiet) notify('Report publishing is disabled');
    return;
  }
  if (state.apiStatus !== 'connected' || !state.apiClient?.publishLaunchReport) {
    if (!quiet) notify('Report publishing requires the Trebuchet desktop app');
    return;
  }

  const airdropStatus = airdropCompletionStatus(proof, config.poolTopology);
  if (airdropStatus.retryRequired) {
    const reason = `Airdrop has ${airdropStatus.failed} failed recipient${airdropStatus.failed === 1 ? '' : 's'}; retry before publishing the launch report.`;
    if (!quiet) notify(reason);
    return { skipped: true, reason, airdropIncomplete: true };
  }
  if (airdropStatus.pending > 0) {
    const reason = `${airdropStatus.pending} airdrop recipient${airdropStatus.pending === 1 ? '' : 's'} still pending; run airdrop before publishing the launch report.`;
    if (!quiet) notify(reason);
    return { skipped: true, reason, airdropIncomplete: true };
  }
  if (!airdropStatus.complete) {
    const reason = airdropCompletionIssue(airdropStatus) || 'Airdrop proof is incomplete; refresh or rerun airdrop before publishing the launch report.';
    if (!quiet) notify(reason);
    return { skipped: true, reason, airdropIncomplete: true };
  }
  const proofFingerprint = launchProofFingerprint(proof, config);
  const launchData = {
    ...buildV2LaunchReportData(proof, config),
    proofFingerprint,
  };
  const expectedSweepEvidenceHash = terminalSweepEvidenceHashForProof(proof);
  const reportHtml = buildV2LaunchReportHtml({ proof, config, launchData });

  state.reportPublishing = true;
  state.lastReportPublish = attachProofFingerprint({ status: 'pending' }, proof, config);
  const ledgerId = ledger ? startExecutionLedgerEntry({ kind: 'report' }) : null;
  renderAll();
  try {
    const result = await state.apiClient.publishLaunchReport({
      walletPublicKey: proof.walletPublicKey || selectedLaunchWalletPublicKey(),
      mint: proof.token.mint,
      poolIds: recordedPoolIds,
      reportHtml,
      launchData,
      proofFingerprint,
    });
    if (result.skipped) {
      state.lastReportPublish = attachProofFingerprint({ status: 'skipped', reason: result.reason }, proof, config);
      finishExecutionLedgerEntry(ledgerId, {
        status: 'warn',
        detail: result.reason || 'Report publishing skipped by the desktop app.',
      });
      if (!quiet) notify('Launch report publishing skipped');
    } else if (result.failed) {
      state.lastReportPublish = attachProofFingerprint({ status: 'failed', error: result.error }, proof, config);
      finishExecutionLedgerEntry(ledgerId, {
        status: 'error',
        error: result.error || 'Report publish failed',
        detail: result.error || 'Report publish failed.',
      });
      if (!quiet) notify(result.error || 'Launch report publish failed');
    } else {
      const returnedFingerprint = typeof result.proofFingerprint === 'string' ? result.proofFingerprint : null;
      const returnedSweepEvidenceHash = typeof result.sweepEvidenceHash === 'string'
        ? result.sweepEvidenceHash
        : typeof result.transferEvidenceHash === 'string' ? result.transferEvidenceHash : null;
      if (result.alreadyPublished === true && returnedFingerprint !== proofFingerprint) {
        state.lastReportPublish = {
          status: 'stale',
          mint: proof.token.mint,
          jsonUri: result.jsonUri || null,
          htmlUri: result.htmlUri || null,
          alreadyPublished: true,
          publishedAt: result.publishedAt || null,
          proofFingerprint: returnedFingerprint,
          ...(returnedSweepEvidenceHash ? { sweepEvidenceHash: returnedSweepEvidenceHash } : {}),
        };
        finishExecutionLedgerEntry(ledgerId, {
          status: 'warn',
          detail: 'Existing launch report is not bound to the current proof.',
        });
        if (!quiet) notify('Existing launch report belongs to another proof');
        return {
          ...result,
          failed: true,
          staleProof: true,
          error: 'Existing launch report is not bound to the current proof.',
        };
      }
      if (result.alreadyPublished === true && expectedSweepEvidenceHash && returnedSweepEvidenceHash !== expectedSweepEvidenceHash) {
        state.lastReportPublish = {
          status: 'stale',
          mint: proof.token.mint,
          jsonUri: result.jsonUri || null,
          htmlUri: result.htmlUri || null,
          alreadyPublished: true,
          publishedAt: result.publishedAt || null,
          proofFingerprint: returnedFingerprint,
          ...(returnedSweepEvidenceHash ? { sweepEvidenceHash: returnedSweepEvidenceHash } : {}),
        };
        finishExecutionLedgerEntry(ledgerId, {
          status: 'warn',
          detail: 'Existing launch report does not include the current terminal sweep evidence.',
        });
        if (!quiet) notify('Existing launch report is missing final sweep evidence');
        return {
          ...result,
          failed: true,
          staleProof: true,
          error: 'Existing launch report does not include the current terminal sweep evidence.',
        };
      }
      if (!result.jsonUri && !result.htmlUri) {
        state.lastReportPublish = attachProofFingerprint({
          status: 'failed',
          error: 'Launch report publisher returned no permanent URI.',
        }, proof, config);
        finishExecutionLedgerEntry(ledgerId, {
          status: 'error',
          error: 'Launch report publisher returned no permanent URI.',
          detail: 'Report publishing did not return a jsonUri or htmlUri, so Trebuchet will not treat it as proof.',
        });
        if (!quiet) notify('Launch report publish returned no URI');
        return {
          ...result,
          failed: true,
          error: 'Launch report publisher returned no permanent URI.',
        };
      }
      state.lastReportPublish = attachProofFingerprint({
        status: 'done',
        mint: proof.token.mint,
        jsonUri: result.jsonUri || null,
        htmlUri: result.htmlUri || null,
        alreadyPublished: result.alreadyPublished === true,
        publishedAt: result.publishedAt || new Date().toISOString(),
        dataVersion: launchData.dataVersion,
        heldReserveAudit: launchData.heldReserveAudit,
        ...(returnedSweepEvidenceHash || expectedSweepEvidenceHash
          ? { sweepEvidenceHash: returnedSweepEvidenceHash || expectedSweepEvidenceHash }
          : {}),
      }, proof, config);
      finishExecutionLedgerEntry(ledgerId, {
        status: 'complete',
        detail: result.alreadyPublished ? 'Existing report proof loaded.' : 'Launch report proof published.',
      });
      rememberLaunchProof({
        ...proof,
        launchConfig: exportableLaunchConfigSnapshot(proofConfigForFingerprint(proof, config)),
        reportPublish: state.lastReportPublish,
      });
      if (!quiet) notify(result.alreadyPublished ? 'Existing launch report loaded' : 'Launch report published');
    }
    if (refreshReadiness) await checkExecutionReadiness();
    return result;
  } catch (error) {
    state.lastReportPublish = attachProofFingerprint({ status: 'failed', error: error.message || 'Publish failed' }, proof, config);
    finishExecutionLedgerEntry(ledgerId, {
      status: 'error',
      error: error.message || 'Publish failed',
      detail: error.message || 'Report publish failed.',
    });
    if (!quiet) notify(error.message || 'Launch report publish failed');
  } finally {
    state.reportPublishing = false;
    renderAll();
  }
}
