function compactLedgerText(value, maxLength = 180) {
  const text = String(value || '')
    .replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, (match) => `${match.slice(0, 4)}...${match.slice(-4)}`)
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function normalizeExecutionLedgerEntry(entry, { restoring = false } = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const startedAt = Number(entry.startedAt || Date.parse(entry.startedIso || ''));
  if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
  if (Date.now() - startedAt > EXECUTION_LEDGER_MAX_AGE_MS) return null;
  const validStatuses = new Set(['running', 'complete', 'warn', 'error']);
  const status = validStatuses.has(entry.status) ? entry.status : 'warn';
  const endedAt = Number(entry.endedAt || Date.parse(entry.endedIso || ''));
  const normalized = {
    id: compactLedgerText(entry.id || `ledger-${startedAt}`, 80),
    endpoint: entry.endpoint ? compactLedgerText(entry.endpoint, 80) : null,
    status,
    startedAt,
    startedIso: new Date(startedAt).toISOString(),
    phase: compactLedgerText(entry.phase || 'run', 32) || 'run',
    label: compactLedgerText(entry.label || 'Launch operation', 90) || 'Launch operation',
    detail: compactLedgerText(entry.detail || entry.error || 'Guarded local-wallet execution.'),
    estimatedCostSol: Number.isFinite(Number(entry.estimatedCostSol)) ? Number(entry.estimatedCostSol) : null,
    balanceDeltaSol: Number.isFinite(Number(entry.balanceDeltaSol)) ? Number(entry.balanceDeltaSol) : null,
    observedOutflowSol: Number.isFinite(Number(entry.observedOutflowSol)) ? Number(entry.observedOutflowSol) : null,
    balanceBeforeSol: Number.isFinite(Number(entry.balanceBeforeSol)) ? Number(entry.balanceBeforeSol) : null,
    balanceAfterSol: Number.isFinite(Number(entry.balanceAfterSol)) ? Number(entry.balanceAfterSol) : null,
    balanceObservationError: entry.balanceObservationError ? compactLedgerText(entry.balanceObservationError) : null,
    attempt: Math.max(1, Math.min(99, Math.floor(Number(entry.attempt || 1)) || 1)),
  };
  if (entry.error) normalized.error = compactLedgerText(entry.error);
  if (Number.isFinite(endedAt) && endedAt >= startedAt) {
    normalized.endedAt = endedAt;
    normalized.endedIso = new Date(endedAt).toISOString();
    normalized.durationMs = Math.max(0, Number(entry.durationMs || endedAt - startedAt));
  } else if (Number.isFinite(Number(entry.durationMs))) {
    normalized.durationMs = Math.max(0, Number(entry.durationMs));
  }
  if (restoring && normalized.status === 'running') {
    const interruptedAt = Date.now();
    normalized.status = 'warn';
    normalized.endedAt = interruptedAt;
    normalized.endedIso = new Date(interruptedAt).toISOString();
    normalized.durationMs = Math.max(0, interruptedAt - startedAt);
    normalized.detail = 'Interrupted before completion; check journals and recovery state before retrying.';
  }
  return normalized;
}

function persistExecutionLedger() {
  const storage = v2LocalStorage();
  if (!storage) return;
  try {
    const entries = state.executionLedger
      .map((entry) => normalizeExecutionLedgerEntry(entry))
      .filter(Boolean)
      .slice(0, EXECUTION_LEDGER_MAX_ENTRIES);
    storage.setItem(EXECUTION_LEDGER_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Local audit persistence is best-effort and must never block launch recovery.
  }
}

function restoreExecutionLedger() {
  const storage = v2LocalStorage();
  if (!storage) return;
  try {
    const parsed = JSON.parse(storage.getItem(EXECUTION_LEDGER_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return;
    state.executionLedger = parsed
      .map((entry) => normalizeExecutionLedgerEntry(entry, { restoring: true }))
      .filter(Boolean)
      .sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0))
      .slice(0, EXECUTION_LEDGER_MAX_ENTRIES);
    persistExecutionLedger();
  } catch {
    state.executionLedger = [];
  }
}

function storedLaunchProofConfig(proof = null, config = currentLaunchConfig()) {
  return proofConfigForFingerprint(proof, config && typeof config === 'object' ? config : { poolTopology: {} });
}

function storedLaunchProofHasSignal(proof = null, config = currentLaunchConfig()) {
  if (!proof || typeof proof !== 'object') return false;
  const proofConfig = storedLaunchProofConfig(proof, config);
  return Boolean(
    proof.journalId
      || proof.token?.mint
      || proof.liquidity?.poolCount
      || proof.transfer
      || reportPublishIsProofCurrent(proof.reportPublish, proof, proofConfig)
      || localDossierIsProofCurrent(proof.localDossier, proof, proofConfig)
  );
}

function pruneStoredLaunchProofArtifacts(proof = null, config = currentLaunchConfig()) {
  return pruneLaunchProofEvidenceArtifacts(proof, storedLaunchProofConfig(proof, config));
}

function normalizeStoredLaunchProof(record = {}) {
  const source = record && typeof record === 'object' ? record : {};
  const rawProof = source.proof && typeof source.proof === 'object'
    ? source.proof
    : source;
  if (!rawProof || typeof rawProof !== 'object') return null;
  if (rawProof.source === 'demo-run') return null;
  const rawProofConfig = storedLaunchProofConfig(rawProof);
  if (!storedLaunchProofHasSignal(rawProof, rawProofConfig)) return null;
  const savedAt = Number(source.savedAt || Date.parse(source.savedIso || rawProof.updatedAt || '')) || Date.now();
  if (!Number.isFinite(savedAt) || Date.now() - savedAt > LAUNCH_PROOF_MAX_AGE_MS) return null;
  try {
    const serialized = JSON.stringify(rawProof);
    if (!serialized || serialized.length > LAUNCH_PROOF_STORAGE_LIMIT) return null;
    const parsedProof = JSON.parse(serialized);
    const proofConfig = storedLaunchProofConfig(parsedProof, rawProofConfig);
    const proof = pruneStoredLaunchProofArtifacts(parsedProof, proofConfig);
    if (!storedLaunchProofHasSignal(proof, proofConfig)) return null;
    return {
      proof,
      savedAt,
      savedIso: new Date(savedAt).toISOString(),
    };
  } catch {
    return null;
  }
}

function persistLaunchProof(proof = state.launchProof) {
  const storage = v2LocalStorage();
  if (!storage) return;
  try {
    const normalized = normalizeStoredLaunchProof({ proof, savedAt: Date.now() });
    if (!normalized) {
      storage.removeItem(LAUNCH_PROOF_STORAGE_KEY);
      return;
    }
    storage.setItem(LAUNCH_PROOF_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Proof persistence is a local convenience; journals remain the source of truth.
  }
}

function restoreLaunchProof() {
  const storage = v2LocalStorage();
  if (!storage) return;
  try {
    const parsed = JSON.parse(storage.getItem(LAUNCH_PROOF_STORAGE_KEY) || '{}');
    const normalized = normalizeStoredLaunchProof(parsed);
    if (!normalized) {
      storage.removeItem(LAUNCH_PROOF_STORAGE_KEY);
      return;
    }
    state.launchProof = normalized.proof;
    const proofConfig = storedLaunchProofConfig(normalized.proof);
    state.lastReportPublish = reportPublishIsProofCurrent(normalized.proof?.reportPublish, normalized.proof, proofConfig)
      ? normalized.proof.reportPublish
      : null;
    state.lastLocalDossier = localDossierIsProofCurrent(normalized.proof?.localDossier, normalized.proof, proofConfig)
      ? normalized.proof.localDossier
      : null;
    storage.setItem(LAUNCH_PROOF_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    storage.removeItem(LAUNCH_PROOF_STORAGE_KEY);
  }
}

function clearStoredLaunchProof() {
  const storage = v2LocalStorage();
  if (!storage) return;
  try {
    storage.removeItem(LAUNCH_PROOF_STORAGE_KEY);
  } catch {
    // Clearing local proof cache is best-effort.
  }
}

