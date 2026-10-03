function bootGuardrails() {
  const apiState = state.apiStatus === 'connected' ? 'pass' : 'warn';
  const rpcState = state.apiStatus === 'connected' && state.rpcHealth !== 'error' ? 'pass' : 'warn';
  const recoveryState = state.recovery.failedJournalCount > 0 || state.recovery.pendingWalletCount > 0
    ? 'warn'
    : 'pass';
  const recoveryDetail = state.apiStatus === 'connected'
    ? `${state.recovery.journalCount} launch journals, ${state.recovery.pendingWalletCount} pending wallets.`
    : 'Recovery inventory is available after the desktop app connects.';
  const planGuardrails = Array.isArray(state.launchPlan?.guardrails)
    ? state.launchPlan.guardrails.map((item) => ({
      id: item.id,
      title: item.title,
      detail: item.detail,
      state: item.state || 'pass',
    }))
    : [];

  return [
    {
      id: 'api',
      title: state.apiStatus === 'connected' ? 'Local API connected' : 'Static preview',
      detail: state.apiDetail,
      state: apiState,
    },
    {
      id: 'rpc',
      title: 'RPC health',
      detail: state.apiStatus === 'connected'
        ? `${state.rpcName}: ${state.rpcHealthLabel}`
        : 'RPC health requires the desktop app.',
      state: rpcState,
    },
    ...planGuardrails,
    ...guardrails.filter((item) => item.id !== 'rpc' && item.id !== 'resume'),
    {
      id: 'resume',
      title: 'Recovery inventory',
      detail: recoveryDetail,
      state: recoveryState,
    },
  ];
}

function renderGuardrails() {
  const items = bootGuardrails();
  const warnings = items.filter((item) => item.state !== 'pass');
  const passes = items.filter((item) => item.state === 'pass');
  const visible = [...warnings, ...passes].slice(0, 4);
  const omitted = Math.max(0, items.length - visible.length);
  $('#preflightSummary').textContent = warnings.length
    ? `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`
    : 'Clear';
  $('#guardrailList').innerHTML = [
    ...visible.map((item) => {
    const icon = item.state === 'pass' ? 'fa-check' : item.state === 'warn' ? 'fa-triangle-exclamation' : 'fa-ban';
    const label = item.state === 'pass' ? 'Pass' : item.state === 'warn' ? 'Warn' : 'Blocked';
    return `
      <article class="guardrail-row ${item.state}">
        <span>
          <h3><i class="fa-solid ${icon}"></i> ${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(item.detail)}</p>
        </span>
        <span class="risk-badge ${item.state === 'warn' ? 'warn' : item.state === 'danger' ? 'danger' : ''}">${label}</span>
      </article>
    `;
    }),
    omitted
      ? `<article class="guardrail-row muted-row"><span><h3>${omitted} checks quiet</h3><p>Passing checks are collapsed.</p></span></article>`
      : '',
  ].join('');
}

function demoRunHasCompletedReadiness(run = state.lastDemoLaunchRun) {
  if (!run || typeof run !== 'object') return false;
  const tokenMint = String(run.token?.tokenMint || run.token?.mint || '').trim();
  const results = Array.isArray(run.liquidity?.results) ? run.liquidity.results : [];
  const resultCount = Number(results.length);
  const readiness = run.readiness || {};
  const completion = readiness.completion || {};
  const sweepPhase = Array.isArray(readiness.phases)
    ? readiness.phases.find((phase) => phase.id === 'sweep')
    : null;
  const config = demoRunLaunchConfig(run);
  const topology = config?.poolTopology || {};
  const plannedAirdropRows = Array.isArray(topology?.airdrop?.recipients)
    ? topology.airdrop.recipients
    : [];
  const plannedAirdropCount = topology?.airdrop?.enabled
    ? Math.max(
      Math.max(0, Math.floor(Number(topology.airdrop.recipientCount || 0))),
      plannedAirdropRows.length,
    )
    : 0;
  const airdrop = run.transfer?.airdrop || {};
  const airdropTransferred = Array.isArray(airdrop.transferred) ? airdrop.transferred : [];
  const airdropFailed = Array.isArray(airdrop.failed) ? airdrop.failed : [];
  const deliveredAirdropWallets = new Set(
    airdropTransferred.map((row) => String(row?.wallet || '').trim()).filter(Boolean),
  );
  const airdropTransferTxCount = airdropTransferred
    .filter((row) => String(row?.txId || row?.signature || '').trim()).length;
  const demoAirdropComplete = plannedAirdropCount <= 0 || Boolean(
    airdropFailed.length === 0
    && airdropTransferred.length >= plannedAirdropCount
    && deliveredAirdropWallets.size >= plannedAirdropCount
    && airdropTransferTxCount >= plannedAirdropCount
  );
  const positionRows = results.flatMap((pool) => [
    ...(Array.isArray(pool?.mainPositions) ? pool.mainPositions : []),
    ...(Array.isArray(pool?.ladderPositions) ? pool.ladderPositions : []),
    ...(Array.isArray(pool?.supportPositions) ? pool.supportPositions : []),
    ...(pool?.bootstrap ? [pool.bootstrap] : []),
  ]);
  const lockedFeeKeyRows = positionRows.filter((position) => position?.locked === true);
  const demoLiquidityComplete = Boolean(
    resultCount > 0
    && positionRows.length > 0
    && lockedFeeKeyRows.length === positionRows.length
    && lockedFeeKeyRows.every((position) => String(position?.feeKeyNftMint || position?.feeKeyMint || '').trim()),
  );
  const feeKeyRecipientRows = positionRows.filter((position) => String(position?.recipient || '').trim());
  const demoFeeKeyRecipientsComplete = feeKeyRecipientRows.every((position) => {
    const recipient = String(position?.recipient || '').trim();
    const transferredTo = String(position?.transferredTo || '').trim();
    const transferTx = String(position?.transferTx || position?.txIds?.transfer || '').trim();
    return Boolean(recipient && transferredTo === recipient && transferTx);
  });
  return Boolean(
    tokenMint
    && demoLiquidityComplete
    && demoFeeKeyRecipientsComplete
    && demoAirdropComplete
    && transferHasWalletEmptyFinalSweepEvidence(run.transfer)
    && readiness.completed === true
    && readiness.completionStatus === 'complete'
    && completion.terminalSweepEvidence === true
    && readiness.nextEndpoint == null
    && (!sweepPhase || sweepPhase.state === 'complete')
  );
}

function stableFundingFingerprintValue(value) {
  if (Array.isArray(value)) return value.map(stableFundingFingerprintValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((record, key) => {
      const stable = stableFundingFingerprintValue(value[key]);
      if (stable !== undefined) record[key] = stable;
      return record;
    }, {});
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) return value;
  if (value === undefined) return undefined;
  return String(value);
}

function fundingEstimateAllocationsForTopology(topology = {}) {
  const pools = Array.isArray(topology.pools) ? topology.pools : [];
  return pools.map((pool) => {
    const quoteDecimalsOverride = optionalDecimals(pool.quoteDecimalsOverride ?? pool.quoteDecimals);
    // Only a hand-set price is part of the plan. The live price from the
    // pair-token check changes every minute; including it made every
    // re-check mark the estimate stale (and mid-launch, sent the user back
    // to Fund). The server probes live prices itself.
    const quoteUsdOverride = Number.isFinite(Number(pool.quoteUsdOverride)) && Number(pool.quoteUsdOverride) > 0
      ? Number(pool.quoteUsdOverride)
      : undefined;
    return {
      quoteToken: pool.quoteToken,
      quoteMint: pool.quoteMint || undefined,
      supplyPercent: pool.supplyPercent,
      ammConfigIndex: pool.ammConfigIndex,
      quoteUsdOverride,
      quoteDecimalsOverride,
      quoteSymbolOverride: pool.quoteSymbol,
      distribution: pool.distribution,
      bootstrap: pool.bootstrap,
      ladder: pool.ladder,
      support: pool.support,
    };
  });
}

function fundingEstimateTokenSupply(value) {
  const cleaned = String(value ?? '').replace(/[^\d]/g, '');
  return cleaned || '1000000000';
}

function launchPlanLogoFingerprint(logo = null) {
  if (!logo || typeof logo !== 'object') return null;
  return {
    name: logo.name || null,
    mimeType: logo.mimeType || logo.type || null,
    sizeBytes: Number.isFinite(Number(logo.sizeBytes ?? logo.size))
      ? Number(logo.sizeBytes ?? logo.size)
      : null,
  };
}

function launchPlanConfigFingerprint(config = currentLaunchConfig()) {
  const token = config?.token || {};
  const topology = config?.poolTopology || {};
  return JSON.stringify(stableFundingFingerprintValue({
    experience: config?.experience || null,
    token: {
      name: token.name || null,
      symbol: token.symbol || null,
      supply: fundingEstimateTokenSupply(token.supply),
      description: token.description || null,
      decimals: token.decimals ?? 9,
      mintFormat: token.mintFormat === 'classic-spl' ? 'classic-spl' : 'token-2022',
      logo: launchPlanLogoFingerprint(token.logo),
      ...(token.sealedLaunch === true ? { sealedLaunch: true } : {}),
    },
    launchSol: Number.isFinite(Number(config?.launchSol)) ? Number(config.launchSol) : null,
    mode: config?.mode || null,
    vanity: config?.vanity || null,
    poolTopology: topology,
    funding: {
      launchSol: Number.isFinite(Number(config?.funding?.launchSol ?? config?.launchSol))
        ? Number(config.funding?.launchSol ?? config.launchSol)
        : null,
      targetMarketCapUsd: Number.isFinite(Number(config?.funding?.targetMarketCapUsd ?? topology.targetMarketCapUsd))
        ? Number(config?.funding?.targetMarketCapUsd ?? topology.targetMarketCapUsd)
        : null,
    },
  }));
}

function launchPlanWalletFingerprint(walletPublicKey) {
  return String(walletPublicKey || '').trim() || null;
}

function stampLaunchPlanConfigFingerprint(plan, config = currentLaunchConfig(), walletPublicKey = selectedLaunchWalletPublicKey()) {
  if (!plan || typeof plan !== 'object') return plan;
  return {
    ...plan,
    v2LaunchConfigFingerprint: launchPlanConfigFingerprint(config),
    v2LaunchWalletFingerprint: launchPlanWalletFingerprint(walletPublicKey),
  };
}

function launchPlanOperationSequenceStatus(operations = []) {
  const operationIds = (Array.isArray(operations) ? operations : [])
    .map((operation) => String(operation?.id || '').trim())
    .filter(Boolean);
  const missingOperationIds = V2_REQUIRED_LAUNCH_PLAN_OPERATION_IDS
    .filter((id) => !operationIds.includes(id));
  let cursor = -1;
  const ordered = V2_REQUIRED_LAUNCH_PLAN_OPERATION_IDS.every((id) => {
    const index = operationIds.indexOf(id);
    if (index <= cursor) return false;
    cursor = index;
    return true;
  });
  return {
    operationIds,
    missingOperationIds,
    ordered,
    ready: missingOperationIds.length === 0 && ordered,
  };
}

function localApiLaunchPlanStatus(plan = state.launchPlan, config = currentLaunchConfig()) {
  const expectedFingerprint = launchPlanConfigFingerprint(config);
  const actualFingerprint = String(plan?.v2LaunchConfigFingerprint || '').trim();
  const expectedWalletFingerprint = launchPlanWalletFingerprint(selectedLaunchWalletPublicKey());
  const actualWalletFingerprint = launchPlanWalletFingerprint(plan?.v2LaunchWalletFingerprint);
  const isLocalApiPlan = state.apiStatus === 'connected' && plan?.source === 'local-api';
  const operations = Array.isArray(plan?.operations) ? plan.operations : [];
  const sequence = launchPlanOperationSequenceStatus(operations);
  const decodedOperationEvidence = Boolean(operations.length && operations.every((operation) => (
    operation?.kind === 'local-wallet-operation'
    && operation?.source === 'v2-launch-plan'
    && operation?.signer === 'trebuchet-managed-launch-wallet'
    && operation?.simulation?.decoded === true
  )));
  const operationSequenceEvidence = Boolean(decodedOperationEvidence && sequence.ready);
  const matchesConfig = Boolean(isLocalApiPlan && actualFingerprint && actualFingerprint === expectedFingerprint);
  const matchesWallet = Boolean(
    isLocalApiPlan
    && expectedWalletFingerprint
    && actualWalletFingerprint
    && actualWalletFingerprint === expectedWalletFingerprint
  );
  const ready = Boolean(matchesConfig && matchesWallet && operationSequenceEvidence);
  return {
    isLocalApiPlan,
    expectedFingerprint,
    actualFingerprint,
    expectedWalletFingerprint,
    actualWalletFingerprint,
    matchesConfig,
    matchesWallet,
    decodedOperationEvidence,
    operationSequenceEvidence,
    operationIds: sequence.operationIds,
    missingOperationIds: sequence.missingOperationIds,
    operationSequenceOrdered: sequence.ordered,
    operationCount: operations.length,
    ready,
    stale: Boolean(isLocalApiPlan && (!matchesConfig || !matchesWallet)),
    incomplete: Boolean(matchesConfig && matchesWallet && !operationSequenceEvidence),
  };
}

function localApiLaunchPlanStaleReason(planStatus = localApiLaunchPlanStatus()) {
  const reasons = [];
  if (!planStatus.matchesConfig) reasons.push('current token/pool model');
  if (!planStatus.matchesWallet) reasons.push('selected launch wallet');
  return reasons.join(' or ') || 'current token/pool model or selected launch wallet';
}

function localApiLaunchPlanIncompleteReason(planStatus = localApiLaunchPlanStatus()) {
  if (!planStatus.decodedOperationEvidence) return 'its local-wallet operation rows are not fully decoded';
  if (Array.isArray(planStatus.missingOperationIds) && planStatus.missingOperationIds.length) {
    return `it is missing required operation ${planStatus.missingOperationIds[0]}${planStatus.missingOperationIds.length === 1 ? '' : ` and ${planStatus.missingOperationIds.length - 1} more`}`;
  }
  if (planStatus.operationSequenceOrdered === false) return 'its operations are not in the required Classic launch order';
  return 'it is missing the complete ordered run envelope';
}

function classicFundingEstimateRequest(config = currentLaunchConfig()) {
  const topology = config?.poolTopology || {};
  const token = config?.token || {};
  const preallocation = topology.preallocation || {};
  const airdrop = topology.airdrop || {};
  return {
    allocations: stableFundingFingerprintValue(fundingEstimateAllocationsForTopology(topology)),
    targetMarketCapUsd: Number(topology.targetMarketCapUsd || 0),
    publishLaunchReport: topology.report?.publish !== false,
    token: {
      supply: fundingEstimateTokenSupply(token.supply),
      decimals: 9,
    },
    preallocation: {
      enabled: preallocation.enabled === true || Number(preallocation.supplyPercent || 0) > 0,
      supplyPercent: Number(preallocation.supplyPercent || 0),
      source: preallocation.source || null,
    },
    airdrop: {
      enabled: airdrop.enabled === true,
      recipientCount: Number(airdrop.recipientCount || 0),
      supplyPercent: Number(airdrop.supplyPercent || 0),
      executionCostSol: Number(airdrop.executionCostSol || 0),
    },
  };
}

// The server's readiness check decides whether an estimate is current, so the screen asks the same
// core function: a second copy here normalized support layers differently and every preset launch
// was blocked as "estimate stale" while the screen called it covered.
function classicFundingEstimateFingerprint(config = currentLaunchConfig()) {
  if (typeof TrebuchetCore !== 'undefined' && typeof TrebuchetCore.v2FundingEstimateFingerprint === 'function') {
    return TrebuchetCore.v2FundingEstimateFingerprint(config);
  }
  return JSON.stringify(stableFundingFingerprintValue(classicFundingEstimateRequest(config)));
}

function classicFundingEstimateStatus(config = currentLaunchConfig(), estimate = state.classicFundingEstimate) {
  const hasEstimate = Number(estimate?.totalSol || 0) > 0;
  const expectedFingerprint = classicFundingEstimateFingerprint(config);
  const actualFingerprint = String(estimate?.v2FundingFingerprint || '').trim();
  const matchesConfig = Boolean(hasEstimate && actualFingerprint && actualFingerprint === expectedFingerprint);
  return {
    estimate,
    hasEstimate,
    matchesConfig,
    stale: Boolean(hasEstimate && !matchesConfig),
    expectedFingerprint,
    actualFingerprint,
  };
}

function stampClassicFundingEstimate(estimate, config = currentLaunchConfig()) {
  if (!estimate || typeof estimate !== 'object') return estimate;
  return {
    ...estimate,
    v2FundingFingerprint: classicFundingEstimateFingerprint(config),
    v2FundingInputs: classicFundingEstimateRequest(config),
  };
}

function currentClassicFundingEstimateForConfig(config = currentLaunchConfig()) {
  return classicFundingEstimateStatus(config).matchesConfig ? state.classicFundingEstimate : null;
}

function proofLaunchConfigSnapshotState(proof = currentLaunchProof()) {
  const launchConfig = proof?.launchConfig && typeof proof.launchConfig === 'object'
    ? proof.launchConfig
    : null;
  const missing = [];
  const mismatches = [];
  const textMatches = (left, right) => {
    const a = String(left ?? '').trim();
    const b = String(right ?? '').trim();
    return !a || !b || a === b;
  };
  const numbersMatch = (left, right) => {
    if (left == null || left === '' || right == null || right === '') return true;
    const a = Number(left);
    const b = Number(right);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return String(left ?? '').trim() === String(right ?? '').trim();
    return Math.abs(a - b) < 1e-9;
  };
  const requiredTextMatches = (left, right) => {
    const a = String(left ?? '').trim();
    const b = String(right ?? '').trim();
    return Boolean(a && b && a === b);
  };
  const requiredNumbersMatch = (left, right) => (
    left != null && left !== ''
    && right != null && right !== ''
    && numbersMatch(left, right)
  );
  const textMatchesWhenSnapshotPresent = (left, right) => String(left ?? '').trim()
    ? requiredTextMatches(left, right)
    : true;
  const numbersMatchWhenSnapshotPresent = (left, right) => left != null && left !== ''
    ? requiredNumbersMatch(left, right)
    : true;
  const poolRowsMatch = (snapshotPool = {}, journalPool = {}) => (
    requiredTextMatches(snapshotPool.quoteToken || snapshotPool.quoteSymbol, journalPool.quoteToken || journalPool.quoteSymbol || journalPool.quote)
    && textMatchesWhenSnapshotPresent(snapshotPool.quoteMint, journalPool.quoteMint)
    && requiredNumbersMatch(snapshotPool.supplyPercent, journalPool.supplyPercent)
    && numbersMatchWhenSnapshotPresent(snapshotPool.ammConfigIndex, journalPool.ammConfigIndex)
  );
  if (!launchConfig) {
    return { state: 'missing', complete: false, missing: ['snapshot'] };
  }
  if (
    String(launchConfig.schema || '').trim() !== 'trebuchet-v2-launch-config'
    || String(launchConfig.source || '').trim() !== 'trebuchet-v2'
  ) {
    missing.push('Trebuchet snapshot marker');
  }
  const token = launchConfig.token && typeof launchConfig.token === 'object'
    ? launchConfig.token
    : null;
  const topology = launchConfig.poolTopology && typeof launchConfig.poolTopology === 'object'
    ? launchConfig.poolTopology
    : null;
  if (!token) {
    missing.push('token');
  } else {
    if (!String(token.name || token.symbol || '').trim()) missing.push('token identity');
    if (!String(token.supply ?? '').trim()) missing.push('token supply');
  }
  if (!topology) {
    missing.push('pool topology');
  } else if (!Array.isArray(topology.pools) || topology.pools.length === 0) {
    missing.push('planned pools');
  }
  if (token && proof?.token && typeof proof.token === 'object') {
    if (!requiredTextMatches(token.name, proof.token.name)) mismatches.push('token name');
    if (!requiredTextMatches(token.symbol, proof.token.symbol)) mismatches.push('token symbol');
    if (!requiredNumbersMatch(token.supply, proof.token.totalSupply ?? proof.token.supply)) mismatches.push('token supply');
    if (!requiredNumbersMatch(token.decimals, proof.token.decimals)) mismatches.push('token decimals');
  }
  const snapshotPools = topology && Array.isArray(topology.pools) ? topology.pools : [];
  const journalPools = Array.isArray(proof?.poolPlan?.allocations) ? proof.poolPlan.allocations : [];
  if (snapshotPools.length > 0 && journalPools.length > 0) {
    if (snapshotPools.length !== journalPools.length) {
      mismatches.push('planned pool count');
    } else {
      snapshotPools.forEach((pool, index) => {
        if (!poolRowsMatch(pool, journalPools[index])) {
          mismatches.push(`planned pool ${index + 1}`);
        }
      });
    }
  }
  return {
    state: missing.length ? 'incomplete' : mismatches.length ? 'mismatch' : 'complete',
    complete: missing.length === 0 && mismatches.length === 0,
    missing,
    mismatches,
  };
}

function utf8ByteLength(value) {
  const text = String(value ?? '');
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
  try {
    return unescape(encodeURIComponent(text)).length;
  } catch (_) {
    return text.length;
  }
}

function tokenConfigStatus(config = currentLaunchConfig()) {
  const token = config?.token || {};
  const name = String(token.name || '').trim();
  const symbol = String(token.symbol || '').trim();
  const supplyRaw = String(token.supply ?? '').trim().replace(/,/g, '');
  const description = String(token.description || '').trim();
  const logo = token.logo && typeof token.logo === 'object' ? token.logo : null;
  const issues = [];
  if (!name) {
    issues.push('Token name is required.');
  } else if (utf8ByteLength(name) > CLASSIC_TOKEN_NAME_MAX_BYTES) {
    issues.push(`Token name must be ${CLASSIC_TOKEN_NAME_MAX_BYTES} UTF-8 bytes or fewer.`);
  }
  if (!symbol) {
    issues.push('Token symbol is required.');
  } else if (utf8ByteLength(symbol) > CLASSIC_TOKEN_SYMBOL_MAX_BYTES) {
    issues.push(`Token symbol must be ${CLASSIC_TOKEN_SYMBOL_MAX_BYTES} UTF-8 bytes or fewer.`);
  }
  if (utf8ByteLength(description) > CLASSIC_TOKEN_DESCRIPTION_MAX_BYTES) {
    issues.push(`Token description must be ${CLASSIC_TOKEN_DESCRIPTION_MAX_BYTES} UTF-8 bytes or fewer.`);
  }
  if (!/^[1-9]\d*$/.test(supplyRaw)) {
    issues.push('Total supply must be a positive whole number.');
  } else {
    try {
      if (BigInt(supplyRaw) > CLASSIC_MAX_WHOLE_TOKEN_SUPPLY) {
        issues.push('Total supply must not exceed 10,000,000,000.');
      }
    } catch (_) {
      issues.push('Total supply must be a positive whole number.');
    }
  }
  if (state.tokenLogoError) {
    issues.push(`Token logo failed validation: ${state.tokenLogoError}`);
  } else if (logo) {
    const mime = String(logo.type || logo.mime || logo.mimeType || '').toLowerCase();
    const sizeBytes = Number(logo.sizeBytes ?? logo.size);
    const width = Number(logo.width);
    const height = Number(logo.height);
    if (mime && !['image/png', 'image/jpeg', 'image/gif'].includes(mime)) {
      issues.push('Token logo must be a PNG, JPG, or GIF image.');
    }
    if (Number.isFinite(sizeBytes) && (sizeBytes <= 0 || sizeBytes > CLASSIC_LOGO_MAX_BYTES)) {
      issues.push('Token logo must be 100KB or smaller.');
    }
    if (Number.isFinite(width) && Number.isFinite(height)) {
      if (width > CLASSIC_LOGO_MAX_DIMENSION || height > CLASSIC_LOGO_MAX_DIMENSION) {
        issues.push(`Token logo must be at most ${CLASSIC_LOGO_MAX_DIMENSION}x${CLASSIC_LOGO_MAX_DIMENSION}px.`);
      }
      if (width < CLASSIC_LOGO_MIN_DIMENSION || height < CLASSIC_LOGO_MIN_DIMENSION) {
        issues.push(`Token logo must be at least ${CLASSIC_LOGO_MIN_DIMENSION}x${CLASSIC_LOGO_MIN_DIMENSION}px.`);
      }
    }
  }
  return {
    ready: issues.length === 0,
    issues,
    name,
    symbol,
    supply: supplyRaw,
    hasLogo: Boolean(logo),
  };
}
