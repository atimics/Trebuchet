function normalizeDiscoveryRecord(record, { restoring = false } = {}) {
  if (!record || typeof record !== 'object') return null;
  const mint = String(record.mint || record.id || '').trim();
  if (!mint || mint.length > 64) return null;
  const inspectedAtMs = Date.parse(record.inspectedAt || '');
  if (restoring && Number.isFinite(inspectedAtMs) && Date.now() - inspectedAtMs > DISCOVERY_STORAGE_MAX_AGE_MS) {
    return null;
  }
  return {
    ...record,
    id: mint,
    mint,
    name: String(record.name || record.symbol || shortAddress(mint)).slice(0, 120),
    symbol: String(record.symbol || shortAddress(mint)).slice(0, 24),
    score: Math.max(0, Math.min(100, Number(record.score) || 0)),
    status: ['Official', 'Unverified', 'Suspected copy', 'Counterfeit', 'Liquidity withdrawn', 'Ready', 'Review', 'Watch'].includes(record.status)
      ? record.status
      : 'Review',
    confidence: ['High', 'Medium', 'Low'].includes(record.confidence) ? record.confidence : 'Low',
    inspectedAt: Number.isFinite(inspectedAtMs) ? new Date(inspectedAtMs).toISOString() : new Date().toISOString(),
    notes: String(record.notes || '').slice(0, 500),
    evidence: Array.isArray(record.evidence) ? record.evidence.slice(0, 12) : [],
    warnings: Array.isArray(record.warnings)
      ? record.warnings.slice(0, 8).map((warning) => String(warning).slice(0, 1200))
      : [],
    market: record.market && typeof record.market === 'object' ? {
      ...record.market,
      history: record.market.history && typeof record.market.history === 'object' ? {
        ...record.market.history,
        points: Array.isArray(record.market.history.points)
          ? record.market.history.points.slice(-48)
          : [],
      } : null,
    } : null,
  };
}

function persistDiscoveryRegistry() {
  const storage = v2LocalStorage();
  if (!storage) return;
  try {
    storage.setItem(DISCOVERY_STORAGE_KEY, JSON.stringify({
      version: 1,
      selectedId: state.selectedDiscoveryId,
      records: state.discovery.records.slice(0, DISCOVERY_STORAGE_MAX_ENTRIES),
    }));
  } catch {
    // A full or unavailable localStorage must not block token inspection.
  }
}

function restoreDiscoveryRegistry() {
  const storage = v2LocalStorage();
  if (!storage) return;
  try {
    const saved = JSON.parse(storage.getItem(DISCOVERY_STORAGE_KEY) || 'null');
    const records = Array.isArray(saved?.records)
      ? saved.records.map((record) => normalizeDiscoveryRecord(record, { restoring: true })).filter(Boolean)
      : [];
    state.discovery.records = records.slice(0, DISCOVERY_STORAGE_MAX_ENTRIES);
    state.selectedDiscoveryId = state.discovery.records.some((record) => record.id === saved?.selectedId)
      ? saved.selectedId
      : state.discovery.records[0]?.id || null;
  } catch {
    state.discovery.records = [];
    state.selectedDiscoveryId = null;
  }
}

function upsertDiscoveryRecord(record) {
  const normalized = normalizeDiscoveryRecord(record);
  if (!normalized) return null;
  const existing = state.discovery.records.find((item) => item.id === normalized.id);
  if (existing?.notes && !normalized.notes) normalized.notes = existing.notes;
  state.discovery.records = [
    normalized,
    ...state.discovery.records.filter((item) => item.id !== normalized.id),
  ].slice(0, DISCOVERY_STORAGE_MAX_ENTRIES);
  state.selectedDiscoveryId = normalized.id;
  persistDiscoveryRegistry();
  return normalized;
}

function removeDiscoveryRecord(mint) {
  state.discovery.records = state.discovery.records.filter((record) => record.id !== mint);
  state.selectedDiscoveryId = state.discovery.records[0]?.id || null;
  persistDiscoveryRegistry();
  renderDiscovery();
  notify('Token removed from the local registry');
}

function discoveryLocalProvenance(record) {
  if (!record) return { proof: null, journal: null };
  const proofMint = String(state.launchProof?.token?.mint || state.launchProof?.mint || '');
  const proof = proofMint === record.mint ? state.launchProof : null;
  const journal = record.journal || state.recovery.journals.find((item) => String(item?.token?.mint || '') === record.mint) || null;
  return { proof, journal };
}

function discoveryWarningSummary(warning) {
  const raw = String(warning || '').trim();
  if (/market data/i.test(raw)) {
    return {
      title: 'Market feed unavailable',
      detail: 'On-chain checks completed, but price, liquidity, or chart data needs another refresh.',
      raw,
    };
  }
  if (/concentration/i.test(raw)) {
    return {
      title: 'Concentration check delayed',
      detail: /429|too many requests/i.test(raw)
        ? 'The public RPC throttled this check. Refresh later or use a dedicated RPC in Settings.'
        : 'Largest-account concentration could not be verified on this pass.',
      raw,
    };
  }
  if (/metadata/i.test(raw)) {
    return {
      title: 'Metadata check incomplete',
      detail: 'Token identity metadata could not be verified on this pass.',
      raw,
    };
  }
  if (/authority/i.test(raw)) {
    return {
      title: 'Authority check incomplete',
      detail: 'Mint and freeze authority evidence could not be verified on this pass.',
      raw,
    };
  }
  return {
    title: 'One check needs another pass',
    detail: 'Refresh the inspection or review the technical detail below.',
    raw,
  };
}

function filteredDiscoveryRecords() {
  const query = state.discovery.query.trim().toLowerCase();
  return state.discovery.records.filter((record) => {
    const status = record.status.toLowerCase();
    if (state.discovery.filter === 'official' && status !== 'official') return false;
    if (state.discovery.filter === 'review' && !['review', 'unverified'].includes(status)) return false;
    if (state.discovery.filter === 'risk' && !['watch', 'suspected copy', 'counterfeit', 'liquidity withdrawn'].includes(status)) return false;
    if (!['all', 'official', 'review', 'risk'].includes(state.discovery.filter) && status !== state.discovery.filter) return false;
    if (!query) return true;
    return [record.name, record.symbol, record.mint]
      .some((value) => String(value || '').toLowerCase().includes(query));
  });
}

function discoveryStatusClass(status) {
  const value = String(status || '').toLowerCase();
  if (['counterfeit', 'liquidity withdrawn', 'watch'].includes(value)) return 'danger';
  if (['suspected copy', 'unverified', 'review'].includes(value)) return 'warn';
  return '';
}

async function inspectDiscoveryMint(mint = $('#discoveryMintInput')?.value) {
  const value = String(mint || '').trim();
  if (!isProbablySolanaAddress(value)) {
    state.discovery.error = 'Enter a valid Solana token mint address.';
    renderDiscovery();
    return;
  }
  if (state.apiStatus !== 'connected' || !state.apiClient?.inspectDiscoveryToken) {
    state.discovery.error = 'Live inspection requires the Trebuchet desktop app.';
    renderDiscovery();
    return;
  }

  state.discovery.inspecting = true;
  state.discovery.error = null;
  state.discovery.lastInspectedMint = value;
  renderDiscovery();
  try {
    const record = await state.apiClient.inspectDiscoveryToken(value);
    upsertDiscoveryRecord(record);
    notify(`${record.symbol || shortAddress(value)} inspection saved`);
  } catch (error) {
    state.discovery.error = error.message || 'Token inspection failed.';
  } finally {
    state.discovery.inspecting = false;
    renderDiscovery();
  }
}

let personalDiscoveryPollTimer = null;

function applyPersonalDiscoveryState(payload = {}) {
  state.discovery.wallets = Array.isArray(payload.wallets) ? payload.wallets : [];
  state.discovery.limits = payload.limits && typeof payload.limits === 'object'
    ? payload.limits
    : {};
  state.discovery.snapshot = payload.snapshot && typeof payload.snapshot === 'object'
    ? payload.snapshot
    : null;
  state.discovery.brandShield = payload.brandShield && typeof payload.brandShield === 'object'
    ? payload.brandShield
    : null;
  state.discovery.job = payload.job && typeof payload.job === 'object'
    ? payload.job
    : { status: 'idle' };
  state.discovery.scanning = state.discovery.job.status === 'running';
  state.discovery.personalError = state.discovery.job.status === 'failed'
    ? state.discovery.job.error || 'Personal Discovery scan failed.'
    : payload.error || null;
}

function personalDiscoveryProgressLabel() {
  const job = state.discovery.job || {};
  if (job.status === 'failed') return job.error || 'Scan failed.';
  if (job.status !== 'running') return null;
  const progress = job.progress || {};
  const phaseLabels = {
    starting: 'Preparing wallet graph',
    'known-wallets': 'Scanning tracked wallets',
    'holder-network': 'Following qualifying holders',
    'known-details': 'Resolving known token details',
    'candidate-details': 'Scoring discoveries',
    complete: 'Scan complete',
  };
  const label = phaseLabels[progress.phase] || 'Scanning personal token network';
  const count = Number(progress.total) > 0
    ? ` · ${Math.min(Number(progress.current) || 0, Number(progress.total))}/${Number(progress.total)}`
    : '';
  return `${label}${count}`;
}

async function refreshPersonalDiscovery({ poll = false } = {}) {
  if (state.apiStatus !== 'connected' || !state.apiClient?.getPersonalDiscovery) return;
  try {
    const payload = await state.apiClient.getPersonalDiscovery();
    applyPersonalDiscoveryState(payload);
  } catch (error) {
    state.discovery.personalError = error.message || 'Personal Discovery state could not be refreshed.';
    state.discovery.scanning = false;
  }
  renderDiscovery();
  if (poll && state.discovery.scanning) schedulePersonalDiscoveryPoll();
}

function schedulePersonalDiscoveryPoll() {
  if (personalDiscoveryPollTimer) window.clearTimeout(personalDiscoveryPollTimer);
  personalDiscoveryPollTimer = window.setTimeout(() => {
    personalDiscoveryPollTimer = null;
    refreshPersonalDiscovery({ poll: true });
  }, 1000);
}

async function addTrackedDiscoveryWallet() {
  const publicKey = String($('#discoveryWalletInput')?.value || '').trim();
  const label = String($('#discoveryWalletLabelInput')?.value || '').trim();
  if (!isProbablySolanaAddress(publicKey)) {
    state.discovery.personalError = 'Enter a valid Solana wallet address.';
    renderDiscovery();
    return;
  }
  if (state.apiStatus !== 'connected' || !state.apiClient?.addDiscoveryWallet) {
    state.discovery.personalError = 'Wallet tracking requires the Trebuchet desktop app.';
    renderDiscovery();
    return;
  }
  state.discovery.walletBusy = true;
  state.discovery.personalError = null;
  renderDiscovery();
  try {
    const payload = await state.apiClient.addDiscoveryWallet({ publicKey, label });
    applyPersonalDiscoveryState(payload);
    if ($('#discoveryWalletInput')) $('#discoveryWalletInput').value = '';
    if ($('#discoveryWalletLabelInput')) $('#discoveryWalletLabelInput').value = '';
    notify('Wallet added to personal Discovery');
  } catch (error) {
    state.discovery.personalError = error.message || 'Wallet could not be added.';
  } finally {
    state.discovery.walletBusy = false;
    renderDiscovery();
  }
}

async function setTrackedDiscoveryWalletEnabled(publicKey, enabled) {
  if (!state.apiClient?.setDiscoveryWalletEnabled) return;
  state.discovery.walletBusy = true;
  state.discovery.personalError = null;
  renderDiscovery();
  try {
    applyPersonalDiscoveryState(await state.apiClient.setDiscoveryWalletEnabled(publicKey, enabled));
  } catch (error) {
    state.discovery.personalError = error.message || 'Wallet tracking could not be changed.';
  } finally {
    state.discovery.walletBusy = false;
    renderDiscovery();
  }
}

async function removeTrackedDiscoveryWallet(publicKey) {
  if (!state.apiClient?.removeDiscoveryWallet) return;
  state.discovery.walletBusy = true;
  state.discovery.personalError = null;
  renderDiscovery();
  try {
    applyPersonalDiscoveryState(await state.apiClient.removeDiscoveryWallet(publicKey));
    notify('Wallet removed from personal Discovery');
  } catch (error) {
    state.discovery.personalError = error.message || 'Wallet could not be removed.';
  } finally {
    state.discovery.walletBusy = false;
    renderDiscovery();
  }
}

async function startPersonalDiscoveryScan() {
  if (!state.discovery.wallets.some((wallet) => wallet.enabled !== false)) {
    state.discovery.personalError = 'Add or enable a wallet before scanning.';
    renderDiscovery();
    return;
  }
  if (!state.apiClient?.scanPersonalDiscovery) {
    state.discovery.personalError = 'Personal Discovery requires the Trebuchet desktop app.';
    renderDiscovery();
    return;
  }
  state.discovery.scanning = true;
  state.discovery.personalError = null;
  renderDiscovery();
  try {
    applyPersonalDiscoveryState(await state.apiClient.scanPersonalDiscovery());
    schedulePersonalDiscoveryPoll();
  } catch (error) {
    state.discovery.scanning = false;
    state.discovery.personalError = error.message || 'Personal Discovery scan could not start.';
    renderDiscovery();
  }
}
