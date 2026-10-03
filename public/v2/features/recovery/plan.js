function recoveryLaunchConfig(journal = {}) {
  if (journal.launchConfig && typeof journal.launchConfig === 'object') {
    return journal.launchConfig;
  }

  const proof = currentLaunchProof();
  const sameJournal = Boolean(journal.id && proof?.journalId === journal.id);
  const sameMint = Boolean(
    journal?.token?.mint
    && proof?.token?.mint
    && journal.token.mint === proof.token.mint,
  );
  if ((sameJournal || sameMint) && proof?.launchConfig && typeof proof.launchConfig === 'object') {
    return proof.launchConfig;
  }

  const poolPlan = journal.poolPlan && typeof journal.poolPlan === 'object'
    ? journal.poolPlan
    : null;
  const token = journal.token && typeof journal.token === 'object'
    ? journal.token
    : null;
  if (!poolPlan && !token) return null;
  const current = currentLaunchConfig();
  const allocations = Array.isArray(poolPlan?.allocations) ? poolPlan.allocations : [];
  return {
    schema: 'trebuchet-v2-launch-config',
    source: 'trebuchet-v2-recovery',
    token: {
      ...(current.token || {}),
      name: token?.name || current.token?.name || null,
      symbol: token?.symbol || current.token?.symbol || null,
      supply: token?.supply || token?.totalSupply || poolPlan?.tokenTotalSupply || current.token?.supply || null,
      description: token?.description || current.token?.description || null,
      decimals: token?.decimals ?? poolPlan?.tokenDecimals ?? current.token?.decimals ?? 9,
      mintFormat: token?.mintFormat || token?.format || current.token?.mintFormat || 'token-2022',
    },
    launchSol: Number(current.launchSol || 0),
    mode: current.mode,
    vanity: token?.mint ? { mode: 'selected', selectedPublicKey: token.mint } : current.vanity,
    poolTopology: {
      ...(current.poolTopology || {}),
      ...(Number.isFinite(Number(poolPlan?.targetMarketCapUsd))
        ? { targetMarketCapUsd: Number(poolPlan.targetMarketCapUsd) }
        : {}),
      ...(allocations.length ? { pools: allocations } : {}),
      ...(poolPlan?.airdropPlan && typeof poolPlan.airdropPlan === 'object'
        ? { airdrop: poolPlan.airdropPlan }
        : {}),
    },
  };
}

function manualLadderTextFromPool(pool = {}) {
  if (pool?.ladder?.mode !== 'manual' || !Array.isArray(pool.ladder.bands)) return '';
  return pool.ladder.bands.map((band) => [
    band.supplyPercent,
    band.lowerMultiplier,
    band.upperMultiplier,
  ].join(', ')).join('\n');
}

function recoveryVenueForPool(pool = {}) {
  const poolMint = String(pool.quoteMint || pool.quoteToken || '').trim();
  const poolSymbol = String(pool.quoteSymbol || pool.quoteSymbolOverride || '').trim().toUpperCase();
  return Object.values(CLASSIC_QUOTE_VENUES).find((venue) => (
    String(pool.id || '') === `${venue.key}-flywheel`
    || (poolMint && [venue.quoteMint, venue.quoteToken].filter(Boolean).includes(poolMint))
    || (!poolMint && poolSymbol === venue.symbol)
  )) || null;
}

function customPoolFromRecovery(pool = {}, index = 0) {
  const distribution = Array.isArray(pool.distribution) && pool.distribution.length
    ? pool.distribution
    : [{ sharePercent: 100 }];
  const manualLadderText = manualLadderTextFromPool(pool);
  return {
    id: String(pool.id || `recovered-pool-${index + 1}`),
    quoteSymbol: String(pool.quoteSymbol || pool.quoteSymbolOverride || `Q${index + 1}`).toUpperCase(),
    quoteMint: String(pool.quoteMint || (pool.quoteToken === 'SOL' ? '' : pool.quoteToken) || ''),
    supplyPercent: Number(pool.supplyPercent || 0),
    ammConfigIndex: Number(pool.ammConfigIndex ?? 5),
    startPremiumPct: Number(pool.startPricePremiumPct ?? 0),
    sliceShares: distribution.map((slice) => Number(slice.sharePercent || 0)).join(','),
    feeKeyRecipient: String(distribution.find((slice) => slice?.recipient)?.recipient || ''),
    ladderBands: pool?.ladder?.mode === 'simple' ? Number(pool.ladder.bandCount || 0) : 0,
    ladderText: manualLadderText,
    supportSol: pool?.support?.mode === 'custom' ? Number(pool.support.solValue || 0) : 0,
    supportDepth: pool?.support?.mode === 'custom' ? Number(pool.support.depthPct || 12) : 12,
    supportLayersText: pool?.support?.mode === 'custom' ? supportLayersText(pool.support.layers) : '',
  };
}

function restoreLaunchConfigFromJournal(journal = {}) {
  const config = recoveryLaunchConfig(journal);
  if (!config || typeof config !== 'object') return false;
  const token = config.token && typeof config.token === 'object' ? config.token : {};
  const topology = config.poolTopology && typeof config.poolTopology === 'object'
    ? config.poolTopology
    : {};
  const pools = Array.isArray(topology.pools)
    ? topology.pools
    : Array.isArray(topology.allocations) ? topology.allocations : [];
  // Keep the pair premium the launch was planned with, so its plan still
  // matches the journal (launches planned before it existed used none).
  const pairPool = pools.find((pool) => String(pool.quoteToken || pool.quoteSymbol || '').toUpperCase() !== 'SOL');
  state.pairStartPremiumPct = pairPool
    ? clampNumber(Number(pairPool.startPricePremiumPct ?? 0) || 0, 0, 500)
    : PAIR_START_PREMIUM_PCT;
  const restoredSolPool = pools.find((pool) => String(pool.id || '') === 'sol-main')
    || pools.find((pool) => String(pool.quoteToken || pool.quoteSymbol || '').toUpperCase() === 'SOL');
  const restoredFlywheelPool = pools.find((pool) => String(pool.id || '').endsWith('-flywheel'));
  // Before per-launch tiers, the SOL pool used config 8 and pairs config 5.
  state.solPoolConfigIndex = restoredSolPool
    ? Math.floor(Number(restoredSolPool.ammConfigIndex ?? 8))
    : DEFAULT_POOL_CONFIG_INDEX;
  state.pairPoolConfigIndex = restoredFlywheelPool
    ? Math.floor(Number(restoredFlywheelPool.ammConfigIndex ?? 5))
    : DEFAULT_POOL_CONFIG_INDEX;
  const solPool = pools.find((pool) => (
    String(pool.quoteSymbol || pool.quoteSymbolOverride || pool.quoteToken || '').toUpperCase() === 'SOL'
    || String(pool.quoteMint || '') === DEFAULT_SOL_MINT
  )) || pools[0] || null;
  const nonSolPools = pools.filter((pool) => pool !== solPool);
  // A pair is the built-in flywheel pair only when it has no ladder, support or extra slices of its own;
  // one that has any is kept as an ordinary pair so none of those settings are lost.
  const isPlainPair = (pool) => (!pool.ladder || pool.ladder.mode === 'off')
    && (!pool.support || pool.support.mode !== 'custom')
    && (!Array.isArray(pool.distribution) || pool.distribution.length <= 1);
  const builtInPoolIndex = nonSolPools.findIndex((pool) => recoveryVenueForPool(pool) && isPlainPair(pool));
  const builtInPool = builtInPoolIndex >= 0 ? nonSolPools[builtInPoolIndex] : null;
  const builtInVenue = builtInPool ? recoveryVenueForPool(builtInPool) : null;
  const customPools = nonSolPools.filter((_, index) => index !== builtInPoolIndex);

  if ($('#tokenName') && token.name != null) $('#tokenName').value = String(token.name).slice(0, 32);
  if ($('#tokenSymbol') && token.symbol != null) $('#tokenSymbol').value = String(token.symbol).slice(0, 10).toUpperCase();
  if ($('#tokenSupply') && token.supply != null) $('#tokenSupply').value = String(token.supply);
  if ($('#tokenDescription') && token.description != null) $('#tokenDescription').value = String(token.description).slice(0, 1000);
  if ($('#sealedLaunch')) $('#sealedLaunch').checked = token.sealedLaunch !== false;
  // Restore the token art so the left-pane launch identity card comes back
  // with a saved launch, the same way it appears after an upload.
  if (token.logo && typeof token.logo === 'object' && token.logo.dataUrl) {
    state.tokenLogo = {
      dataUrl: token.logo.dataUrl,
      mime: token.logo.mime || 'image/png',
      name: token.logo.name || 'logo',
      animated: token.logo.animated === true,
    };
    state.launchIdentity = null;
  }
  if ($('#mintFormat')) $('#mintFormat').value = token.mintFormat === 'classic-spl'
    ? 'classic-spl'
    : 'token-2022';
  if ($('#targetMarketCapUsd') && Number.isFinite(Number(topology.targetMarketCapUsd ?? config.funding?.targetMarketCapUsd))) {
    $('#targetMarketCapUsd').value = String(Number(topology.targetMarketCapUsd ?? config.funding.targetMarketCapUsd));
  }

  const launchSol = Number(config.launchSol ?? config.funding?.launchSol ?? 0);
  const supportSol = pools.reduce((sum, pool) => (
    sum + (pool?.support?.mode === 'custom' ? Math.max(0, Number(pool.support.solValue || 0)) : 0)
  ), 0);
  if ($('#launchSol')) $('#launchSol').value = String(Number.isFinite(launchSol) ? launchSol : 0);
  if ($('#liquidityBudgetSol')) $('#liquidityBudgetSol').value = String(Math.max(0, launchSol || 0) + supportSol);

  if ($('#mainPoolPercent')) $('#mainPoolPercent').value = String(Number(solPool?.supplyPercent ?? 100));
  const solDistribution = Array.isArray(solPool?.distribution) && solPool.distribution.length
    ? solPool.distribution
    : [{ sharePercent: 100 }];
  if ($('#sliceShares')) $('#sliceShares').value = solDistribution.map((slice) => Number(slice.sharePercent || 0)).join(',');
  if ($('#ladderBands')) $('#ladderBands').value = String(solPool?.ladder?.mode === 'simple' ? Number(solPool.ladder.bandCount || 0) : 0);
  state.baseManualLadderText = manualLadderTextFromPool(solPool || {});
  state.baseSupportDepth = String(solPool?.support?.mode === 'custom' ? Number(solPool.support.depthPct || 12) : 12);
  state.baseSupportLayersText = solPool?.support?.mode === 'custom' ? supportLayersText(solPool.support.layers) : '';
  if ($('#supportSol')) $('#supportSol').value = String(solPool?.support?.mode === 'custom' ? Number(solPool.support.solValue || 0) : 0);

  if ($('#quotePoolPercent')) $('#quotePoolPercent').value = String(Number(builtInPool?.supplyPercent || 0));
  if ($('#quotePoolVenue') && builtInVenue) $('#quotePoolVenue').value = builtInVenue.key;
  state.customPools = customPools.map(customPoolFromRecovery);
  // Keep the id counter past every restored id (pairs may be numbered 2 and 3 after one was
  // removed), and give a pair that was saved with a repeated id its own, so each pair edits itself.
  state.customPoolCounter = Math.max(
    state.customPoolCounter,
    state.customPools.length,
    ...state.customPools.map((pool) => Number(/^custom-pool-(\d+)$/.exec(pool.id)?.[1] || 0)),
  );
  const seenPoolIds = new Set();
  state.customPools.forEach((pool) => {
    if (seenPoolIds.has(pool.id)) {
      do { state.customPoolCounter += 1; pool.id = `custom-pool-${state.customPoolCounter}`; } while (seenPoolIds.has(pool.id));
    }
    seenPoolIds.add(pool.id);
  });

  const feeKeyRecipient = String(
    topology.feeKeyRecipient
    || solDistribution.find((slice) => slice?.recipient)?.recipient
    || nonSolPools.flatMap((pool) => pool.distribution || []).find((slice) => slice?.recipient)?.recipient
    || '',
  );
  if ($('#feeKeyRecipient')) $('#feeKeyRecipient').value = feeKeyRecipient;
  if ($('#sweepDestination')) $('#sweepDestination').value = String(topology.sweepDestination || '');
  if ($('#preallocationSupplyPercent')) $('#preallocationSupplyPercent').value = String(Number(topology.preallocation?.supplyPercent || 0));

  const airdrop = topology.airdrop && typeof topology.airdrop === 'object' ? topology.airdrop : {};
  const airdropRows = Array.isArray(airdrop.recipients) ? airdrop.recipients : [];
  state.airdropCsvText = airdropRows
    .filter((row) => row?.source !== 'funder')
    .map((row) => `${row.wallet || row.recipient || ''},${row.tokens ?? row.amount ?? ''}`).join('\n');
  state.heldShare = {
    selected: Array.isArray(topology.heldShare?.funders)
      ? topology.heldShare.funders.map((address) => String(address || '')).filter(Boolean)
      : airdropRows.filter((row) => row?.source === 'funder').map((row) => String(row.wallet || '')).filter(Boolean),
  };
  if ($('#airdropCsvText')) $('#airdropCsvText').value = state.airdropCsvText;
  if ($('#airdropWallets')) $('#airdropWallets').value = String(Number(airdrop.recipientCount || airdropRows.length || 0));
  if ($('#airdropSupplyPercent')) $('#airdropSupplyPercent').value = String(Number(airdrop.requestedSupplyPercent ?? airdrop.supplyPercent ?? 0));
  if ($('#airdropAutoFit')) $('#airdropAutoFit').checked = airdrop.autoFit !== false;

  if (state.flywheelPools?.meme?.length) {
    const memePool = pools.find((pool) => String(pool.quoteSymbol || '').toUpperCase() === 'MEME'
      || String(pool.quoteMint || '') === state.memeFlywheelMint);
    if (memePool?.quoteMint) state.memeFlywheelMint = String(memePool.quoteMint);
  }
  if ($('#vanityStart')) $('#vanityStart').value = String(config.vanity?.prefix || '');
  if ($('#vanityEnd')) $('#vanityEnd').value = String(config.vanity?.suffix || '');
  if ($('#vanityCaseInsensitive')) $('#vanityCaseInsensitive').checked = config.vanity?.caseInsensitive === true;
  if ($('#vanityLength')) $('#vanityLength').value = config.vanity?.length ? String(config.vanity.length) : '';
  state.selectedVanityPublicKey = String(config.vanity?.selectedPublicKey || journal?.token?.mint || '').trim() || null;
  state.classicFundingEstimate = null;
  state.executionReadiness = null;
  state.launchPlan = null;
  state.restoredLaunchJournalId = journal.id || null;
  return true;
}
