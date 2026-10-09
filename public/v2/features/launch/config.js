function currentVanityConfig() {
  const prefix = $('#vanityStart').value.trim();
  const suffix = $('#vanityEnd').value.trim();
  const selected = state.vanityCandidates.find((item) => item.publicKey === state.selectedVanityPublicKey) || null;
  // A saved any-case address stays valid even if the toggle is off now.
  const caseInsensitive = $('#vanityCaseInsensitive')?.checked === true || selected?.caseInsensitive === true;
  // A chosen address keeps its own length; the length field only filters the grind.
  const length = selected ? (Number($('#vanityLength')?.value) || selected.addressLength ? selected.publicKey.length : null) : Number($('#vanityLength')?.value) || null;
  return {
    mode: prefix && suffix ? 'both' : prefix ? 'prefix' : suffix ? 'suffix' : 'random',
    prefix,
    suffix,
    ...(caseInsensitive ? { caseInsensitive: true } : {}),
    ...(length ? { length } : {}),
    selectedPublicKey: selected?.publicKey || null,
    candidateCount: state.vanityCandidates.length,
    candidates: state.vanityCandidates.map((item) => ({
      publicKey: item.publicKey,
      target: item.target || null,
      prefix: item.prefix || null,
      suffix: item.suffix || null,
      mode: item.mode || null,
      caseInsensitive: item.caseInsensitive === true,
      addressLength: item.addressLength || null,
      keyType: item.keyType || 'seed',
      rarity: item.rarity || null,
      attempts: item.attempts || null,
      persisted: item.persisted === true,
    })),
  };
}

const KNOWN_SAFE_QUOTE_SYMBOLS = new Set(['SOL', 'USDC', 'USDT']);

function normalizeClmmFeeTier(tier) {
  if (!tier || typeof tier !== 'object') return null;
  const index = Math.floor(Number(tier.index));
  const tradeFeeRate = Math.floor(Number(tier.tradeFeeRate));
  const tickSpacing = Math.floor(Number(tier.tickSpacing));
  if (!Number.isInteger(index) || index < 0) return null;
  if (!Number.isInteger(tradeFeeRate) || tradeFeeRate <= 0) return null;
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) return null;
  return { index, tradeFeeRate, tickSpacing };
}

function normalizeClmmFeeTiers(tiers) {
  const normalized = Array.isArray(tiers)
    ? tiers.map(normalizeClmmFeeTier).filter(Boolean)
    : [];
  const unique = new Map();
  normalized.forEach((tier) => {
    if (!unique.has(tier.index)) unique.set(tier.index, tier);
  });
  const list = [...unique.values()].sort((a, b) => a.tradeFeeRate - b.tradeFeeRate || a.index - b.index);
  return list.length ? list : DEFAULT_CLMM_FEE_TIERS.map((tier) => ({ ...tier }));
}

function feeTierLabel(tier) {
  const feePercent = Number(tier.tradeFeeRate || 0) / 10000;
  return `${feePercent}% / spacing ${tier.tickSpacing}${Number(tier.index) === DEFAULT_POOL_CONFIG_INDEX ? ' (default)' : ''}`;
}

function feeTierOptionsHtml(selectedIndex) {
  const tiers = normalizeClmmFeeTiers(state.clmmFeeTiers);
  const selected = Math.floor(Number(selectedIndex));
  const hasSelected = tiers.some((tier) => tier.index === selected);
  const options = tiers.map((tier) => `
    <option value="${tier.index}" data-short="${escapeHtml(`${Number(tier.tradeFeeRate || 0) / 10000}%`)}" ${tier.index === selected ? 'selected' : ''}>${escapeHtml(feeTierLabel(tier))}</option>
  `).join('');
  return `${options}${Number.isInteger(selected) && !hasSelected ? `<option value="${selected}" selected>Custom index ${selected}</option>` : ''}`;
}

function customQuoteLookupValue(pool = {}) {
  const mint = String(pool.quoteMint || '').trim();
  if (mint) return mint;
  const symbol = String(pool.quoteSymbol || '').trim().toUpperCase();
  return symbol;
}

function customQuoteInfoRecord(pool = {}) {
  const record = state.quoteTokenInfo?.[pool.id] || null;
  if (!record) return null;
  const lookup = customQuoteLookupValue(pool);
  if (!lookup || record.query !== lookup) return null;
  return record;
}

function customQuoteResolvedInfo(pool = {}) {
  const record = customQuoteInfoRecord(pool);
  return record?.info && typeof record.info === 'object' ? record.info : null;
}

function customQuoteInfoBadge(pool = {}) {
  const lookup = customQuoteLookupValue(pool);
  const symbol = String(pool.quoteSymbol || '').trim().toUpperCase();
  const record = customQuoteInfoRecord(pool);
  if (!lookup || (!pool.quoteMint && !KNOWN_SAFE_QUOTE_SYMBOLS.has(symbol))) {
    return { label: 'Needs mint', className: 'warn', detail: 'Enter a quote mint, or use SOL/USDC/USDT, then verify before launch.' };
  }
  if (record?.loading) return { label: 'Checking', className: 'warn', detail: 'Resolving metadata, authorities, and swap route.' };
  if (record?.error) return { label: 'Check failed', className: 'danger', detail: record.error };
  const info = customQuoteResolvedInfo(pool);
  if (!info) return { label: 'Unverified', className: 'warn', detail: 'Verify the quote token before executing this custom pool.' };
  if (info.compatible === false) return { label: 'Incompatible', className: 'danger', detail: 'Token is not compatible with the Raydium CLMM launch path.' };
  if (info.freezeAuthorityBlock === true) return { label: 'Freeze block', className: 'danger', detail: 'Quote token freeze authority can strand launch-wallet balances.' };
  const swapRoute = info.swapRoute || 'unknown';
  if (info.compatible == null || info.freezeAuthorityBlock == null) {
    return { label: 'Checking safety', className: 'warn', detail: 'Trebuchet retries the token and authority checks automatically.' };
  }
  if (swapRoute === 'none' || swapRoute === 'unknown') return {
    label: swapRoute === 'none' ? 'Use wallet tokens' : 'Checking routes', className: 'warn',
    detail: 'Funding counts tokens in the launch wallet and shows the amount to add. Swap routes refresh automatically.',
  };
  if (info.mintAuthorityWarning === true) {
    return { label: 'Mint warning', className: 'warn', detail: 'Quote token mint authority is still active; supply can be inflated.' };
  }
  return {
    label: 'Verified',
    className: '',
    detail: `Quote-token metadata, compatibility, authority, and route checks passed (auto-buy via ${swapRoute === 'jupiter' ? 'Jupiter' : 'Raydium'}).`,
  };
}

function poolQuoteRouteKey(pool = {}) {
  const mint = String(pool.quoteMint || '').trim();
  const token = String(pool.quoteToken || '').trim();
  const symbol = String(pool.quoteSymbol || pool.quoteSymbolOverride || '').trim();
  const raw = mint || token || symbol;
  if (!raw) return '';
  const key = quoteKey(raw);
  const upper = raw.toUpperCase();
  if (key === quoteKey(DEFAULT_SOL_MINT) || upper === 'SOL') return 'SOL';
  if (key === quoteKey(DEFAULT_USDC_MINT) || upper === 'USDC') return 'USDC';
  if (upper === 'USDT') return 'USDT';
  if (!mint && symbol && token && quoteKey(symbol) === quoteKey(token)) return symbol.toUpperCase();
  if (!mint && !token && symbol) return symbol.toUpperCase();
  return raw;
}

function poolQuoteRouteLabel(pool = {}) {
  return String(pool.quoteSymbol || pool.quoteToken || pool.quoteMint || 'quote').trim() || 'quote';
}

function feeTierDisplay(index) {
  const feeTier = normalizeClmmFeeTiers(state.clmmFeeTiers).find((tier) => tier.index === Math.floor(Number(index)));
  return feeTier ? feeTierLabel(feeTier) : `fee tier ${Math.floor(Number(index) || 0)}`;
}

function duplicatePoolRouteIssues(pools = []) {
  const seen = new Map();
  const issues = [];
  pools.forEach((pool, index) => {
    if (Number(pool.supplyPercent || 0) <= 0) return;
    const quote = poolQuoteRouteKey(pool);
    if (!quote) return;
    const feeTier = Math.floor(Number(pool.ammConfigIndex || 0));
    const key = `${quote}|${feeTier}`;
    if (seen.has(key)) {
      const firstIndex = seen.get(key);
      const label = poolQuoteRouteLabel(pool);
      issues.push({
        state: 'danger',
        poolId: pool.id || `pool-${index + 1}`,
        title: `Pool ${index + 1} duplicates Pool ${firstIndex + 1}`,
        detail: `Same ${label} quote and ${feeTierDisplay(feeTier)}. Pick a different quote or fee tier; Raydium uses both to identify a pool.`,
      });
      return;
    }
    seen.set(key, index);
  });
  return issues;
}

function feeKeyRecipientIssues(pools = []) {
  const issues = [];
  pools.forEach((pool, poolIndex) => {
    const distribution = Array.isArray(pool.distribution) ? pool.distribution : [];
    distribution.forEach((slice, sliceIndex) => {
      const recipient = String(slice?.recipient || '').trim();
      if (!recipient || isProbablySolanaAddress(recipient)) return;
      issues.push({
        state: 'danger',
        poolId: pool.id || `pool-${poolIndex + 1}`,
        title: `Pool ${poolIndex + 1} recipient invalid`,
        detail: `Slice ${sliceIndex + 1} Fee Key recipient does not look like a valid Solana address.`,
      });
    });
  });
  return issues;
}

const PLACEHOLDER_SWEEP_RE = /^1{20,}[1-9A-HJ-NP-Za-km-z]*$/;

// A split-key vanity CA signs only in the Token-2022 create-mint path.
function splitKeyMintFormatIssues() {
  const selected = state.vanityCandidates.find((item) => item.publicKey === state.selectedVanityPublicKey);
  if (selected?.keyType !== 'scalar' || $('#mintFormat')?.value !== 'classic-spl') return [];
  return [{
    state: 'danger',
    poolId: 'vanity-ca',
    title: 'Split-key address needs Token-2022',
    detail: 'This vanity address came from a split-key grind. Switch the mint standard to Token-2022, or pick another address.',
  }];
}

function sweepDestinationIssues(topology = {}) {
  const destination = String(topology.sweepDestination || '').trim();
  if (!destination) return [];
  if (!isProbablySolanaAddress(destination)) {
    return [{
      state: 'danger',
      poolId: 'sweep-destination',
      title: 'Return wallet invalid',
      detail: 'Return wallet does not look like a valid Solana address.',
    }];
  }
  // Only a real launch can lose assets: practice/demo runs sweep nothing.
  const liveExecution = state.launchMode !== 'dry-run';
  if (liveExecution && returnWalletStatus().kind === 'unverified') {
    return [{
      state: 'danger',
      poolId: 'sweep-destination',
      title: 'Return wallet not verified',
      detail: 'Launch assets only go to the funding wallet or a wallet that signed in Trebuchet. Sign with this wallet or use the funding wallet.',
    }];
  }
  if (liveExecution && (PLACEHOLDER_SWEEP_RE.test(destination) || destination === '1nc1nerator11111111111111111111111111111111')) {
    return [{
      state: 'danger',
      poolId: 'sweep-destination',
      title: 'Return wallet looks like a placeholder',
      detail: 'Swept SOL, tokens, and the Fee Key NFTs would be unrecoverable, and trading fees could never be claimed. Use a wallet you control.',
    }];
  }
  return [];
}

function airdropRecipientIssues(topology = {}) {
  const airdrop = topology.airdrop || {};
  if (!airdrop.enabled) return [];
  const issues = [];
  if (airdrop.parseError) {
    issues.push({
      state: 'danger',
      poolId: 'airdrop',
      title: 'Airdrop CSV invalid',
      detail: `Airdrop CSV has an error: ${airdrop.parseError}`,
    });
  }
  if (airdrop.budgetError) {
    issues.push({
      state: 'danger',
      poolId: 'airdrop',
      title: 'Airdrop budget invalid',
      detail: `Airdrop budget is invalid: ${airdrop.budgetError}`,
    });
  }
  const seen = new Set();
  const recipients = Array.isArray(airdrop.recipients) ? airdrop.recipients : [];
  recipients.forEach((row, index) => {
    const wallet = String(row?.wallet || row?.recipient || '').trim();
    const tokens = Number(row?.tokens ?? row?.amount);
    if (!wallet || !isProbablySolanaAddress(wallet)) {
      issues.push({
        state: 'danger',
        poolId: 'airdrop',
        title: `Airdrop row ${index + 1} invalid`,
        detail: `Airdrop recipient ${index + 1}: wallet does not look like a valid Solana address.`,
      });
      return;
    }
    if (seen.has(wallet)) {
      issues.push({
        state: 'danger',
        poolId: 'airdrop',
        title: `Airdrop row ${index + 1} duplicate`,
        detail: `Airdrop recipient ${index + 1}: duplicate wallet ${wallet.slice(0, 8)}...`,
      });
    }
    seen.add(wallet);
    if (!Number.isFinite(tokens) || tokens <= 0) {
      issues.push({
        state: 'danger',
        poolId: 'airdrop',
        title: `Airdrop row ${index + 1} invalid`,
        detail: `Airdrop recipient ${index + 1}: token amount must be greater than 0.`,
      });
    }
  });
  return issues;
}

function topologyAllocationIssues(topology = {}) {
  const pools = Array.isArray(topology.pools) ? topology.pools : [];
  const rowTotalPoolPercent = pools.reduce((sum, pool) => sum + Number(pool?.supplyPercent || 0), 0);
  const summaryTotalPoolPercent = Number.isFinite(Number(topology.totalPoolPercent))
    ? Number(topology.totalPoolPercent)
    : null;
  const totalPoolPercent = rowTotalPoolPercent > 0
    ? rowTotalPoolPercent
    : (summaryTotalPoolPercent || 0);
  const preallocationPercent = Number(topology.preallocation?.supplyPercent || 0);
  const airdropPercent = Number(topology.airdrop?.supplyPercent || 0);
  const heldReservePercent = (Number.isFinite(preallocationPercent) ? preallocationPercent : 0)
    + (Number.isFinite(airdropPercent) ? airdropPercent : 0);
  const supplyUsed = totalPoolPercent + heldReservePercent;
  const issues = [];
  if (
    rowTotalPoolPercent > 0
    && summaryTotalPoolPercent != null
    && Math.abs(rowTotalPoolPercent - summaryTotalPoolPercent) > 0.01
  ) {
    issues.push({
      state: 'danger',
      poolId: 'pool-allocation',
      title: 'Pool allocation mismatch',
      detail: `Pool rows add to ${rowTotalPoolPercent.toFixed(2)}% but the topology summary says ${summaryTotalPoolPercent.toFixed(2)}%. Refresh the launch plan before execution.`,
    });
  }
  if (totalPoolPercent <= 0) {
    issues.push({
      state: 'danger',
      poolId: 'pool-allocation',
      title: 'No liquidity allocation',
      detail: 'At least one launch pool must receive token supply.',
    });
  }
  if (supplyUsed > 100.0001) {
    issues.push({
      state: 'danger',
      poolId: 'pool-allocation',
      title: 'Supply overallocated',
      detail: `Pools, preallocation, and airdrop reserve ${supplyUsed.toFixed(2)}% of supply; reduce them to 100% or less.`,
    });
  }
  return issues;
}

function customQuoteSafetySummary(topology = currentClassicModel()) {
  const issues = [];
  topologyAllocationIssues(topology).forEach((issue) => issues.push(issue));
  state.customPools.forEach((pool) => {
    const supplyPercent = parsePercentInput(pool.supplyPercent, 0);
    if (supplyPercent <= 0) return;
    const badge = customQuoteInfoBadge(pool);
    if (badge.className === 'danger') {
      issues.push({
        state: 'danger',
        poolId: pool.id,
        title: `${pool.quoteSymbol || pool.quoteMint || 'Custom quote'} blocked`,
        detail: badge.detail,
      });
    } else if (badge.className === 'warn') {
      issues.push({
        state: 'warn',
        poolId: pool.id,
        title: `${pool.quoteSymbol || pool.quoteMint || 'Custom quote'} needs review`,
        detail: badge.detail,
      });
    }
  });
  duplicatePoolRouteIssues(topology.pools).forEach((issue) => issues.push(issue));
  feeKeyRecipientIssues(topology.pools).forEach((issue) => issues.push(issue));
  sweepDestinationIssues(topology).forEach((issue) => issues.push(issue));
  airdropRecipientIssues(topology).forEach((issue) => issues.push(issue));
  splitKeyMintFormatIssues().forEach((issue) => issues.push(issue));
  return {
    blockers: issues.filter((item) => item.state === 'danger'),
    warnings: issues.filter((item) => item.state === 'warn'),
  };
}

function selectedClassicQuoteVenue() {
  const key = String($('#quotePoolVenue')?.value || 'meme').trim().toLowerCase();
  const venue = CLASSIC_QUOTE_VENUES[key] || CLASSIC_QUOTE_VENUES.meme;
  // The meme flywheel draws its pairing from the curated pool instead of one
  // baked-in mint.
  if (venue.key === 'meme' && state.memeFlywheelMint) {
    return { ...venue, quoteToken: state.memeFlywheelMint, quoteMint: state.memeFlywheelMint };
  }
  return venue;
}

// --- Flywheel vortex ------------------------------------------------------
// Presentation of the pool allocation as a vortex: the flywheel is the fast
// core, quote pools are inner bands, the SOL market is the outer inflow, and
// band thickness is share of supply. Dragging a boundary moves supply between
// neighbouring bands. It reads and writes the same percentage fields the plan
// builder already consumes, so nothing downstream changes.

// The flywheel vortex has been removed from the shell (no mount point and
// no vortex script). Kept as a documented no-op so renderer call sites and
// the full-input audit stay intact.
function renderVortexControl() {
  return;
}

function renderFlywheelPick() {
  const host = $('#flywheelPick');
  const mintEl = $('#flywheelPickMint');
  if (!host || !mintEl) return;
  const venueKey = String($('#quotePoolVenue')?.value || 'meme').trim().toLowerCase();
  host.hidden = venueKey !== 'meme';
  mintEl.textContent = state.memeFlywheelMint ? shortAddress(state.memeFlywheelMint) : '—';
  mintEl.title = state.memeFlywheelMint || '';
}

// The token being launched cannot be its own flywheel pairing: a pool with the
// same mint on both sides is not tradable.
function ownTokenMint() {
  const fromVanity = String(state.selectedVanityPublicKey || '').trim();
  const fromConfig = String(currentLaunchConfig()?.vanity?.selectedPublicKey || '').trim();
  return fromVanity || fromConfig || null;
}

async function shuffleMemeFlywheel() {
  const own = ownTokenMint();
  const pool = (state.flywheelPools?.meme || []).filter((mint) => !own || mint !== own);
  if (!pool.length) {
    notify('No meme flywheel mints configured');
    return;
  }
  let mint = null;
  try {
    const result = await state.apiClient?.pickFlywheelMint?.({ kind: 'meme', last: state.memeFlywheelMint });
    mint = result?.mint || null;
  } catch (error) {
    notify(error.message || 'Could not draw a flywheel mint');
    return;
  }
  if (!mint) {
    const options = pool.filter((entry) => entry !== state.memeFlywheelMint);
    const from = options.length ? options : pool;
    mint = from[Math.floor(Math.random() * from.length)];
  }
  state.memeFlywheelMint = mint;
  renderFlywheelPick();
  scheduleLaunchAutoSave();
  notify(`Flywheel pairing drawn: ${fullAddress(mint)}`);
}

// The liquidity budget is SOL that goes INTO the SOL pool. A launch pool
// opens holding only the new token, so SOL can only sit below the launch
// price: it becomes the buy support that sellers are paid from. (Earlier
// presets called most of the budget "core liquidity", which no pool ever
// received, so launches opened with no SOL at all.)
function launchBudgetRecommendation(value) {
  const budgetSol = Math.max(0, Number(value) || 0);
  if (budgetSol === 0) {
    return {
      id: 'minimum',
      label: 'Minimum launch',
      detail: 'Create the token and its pool with no SOL in it. Sellers have nothing to sell into until someone buys.',
      coreSol: 0,
      supportSol: 0,
      ladderBands: 0,
      structure: '1 simple market',
    };
  }
  if (budgetSol <= 1) {
    return {
      id: 'lean',
      label: 'Lean',
      detail: 'Place all of the SOL just below the launch price, so early sellers are paid from it.',
      coreSol: 0,
      supportSol: budgetSol,
      ladderBands: 0,
      structure: '1 market · buy support',
    };
  }
  if (budgetSol < 50) {
    return {
      id: 'balanced',
      label: 'Balanced',
      detail: 'Place the SOL below the launch price as buy support, and add one reach band above it.',
      coreSol: 0,
      supportSol: budgetSol,
      ladderBands: 1,
      structure: 'buy support · 1 reach band',
    };
  }
  return {
    id: 'deep',
    label: 'Deep',
    detail: 'Place a deep SOL buy wall below the launch price, and add one reach band above it.',
    coreSol: 0,
    supportSol: budgetSol,
    ladderBands: 1,
    structure: 'deep buy support · 1 reach band',
  };
}

function renderLaunchBudgetRecommendation() {
  const target = $('#launchBudgetStrategy');
  const budgetInput = $('#liquidityBudgetSol');
  if (!target || !budgetInput) return;
  const budgetSol = Math.max(0, parseNumericInput(budgetInput.value, 0));
  const strategy = launchBudgetRecommendation(budgetSol);
  $$('.launch-budget-presets button').forEach((button) => {
    button.classList.toggle('is-selected', button.dataset.preset ? button.dataset.preset === launchPresetSelected() : Number(button.dataset.budget) === budgetSol);
  });
  const depth = clampNumber(parseNumericInput(state.baseSupportDepth, 12), 1, 50);
  target.innerHTML = '';
  target.title = '';
}

function applyLaunchBudgetRecommendation(value, { announce = true, fromInput = false } = {}) {
  const budgetSol = Math.max(0, Number(value) || 0);
  const strategy = launchBudgetRecommendation(budgetSol);
  // While the amount is being typed it is left alone: rewriting "0." as "0" would make 0.1 untypable.
  if ($('#liquidityBudgetSol') && !fromInput) $('#liquidityBudgetSol').value = String(budgetSol);
  if ($('#launchSol')) $('#launchSol').value = String(strategy.coreSol);
  if ($('#quotePoolPercent')) $('#quotePoolPercent').value = '0';
  // SOL takes the rest: held-back tokens, airdrop, and added pairs stay.
  if ($('#mainPoolPercent')) $('#mainPoolPercent').value = String(mainPoolRemainderPercent());
  if ($('#sliceShares')) $('#sliceShares').value = '100';
  if ($('#ladderBands')) $('#ladderBands').value = String(strategy.ladderBands);
  if ($('#supportSol')) $('#supportSol').value = String(strategy.supportSol);
  state.baseManualLadderText = '';
  state.baseSupportLayersText = '';
  state.launchPresetId = null;
  invalidateClassicOutputs();
  refreshClassicPreview({ includePoolEditor: true });
  renderLaunchBudgetRecommendation();
  if (announce) notify(`${strategy.label} strategy applied to ${budgetSol.toFixed(budgetSol % 1 === 0 ? 0 : 1)} SOL`);
}

function currentClassicModel() {
  const mainPoolPercent = parsePercentInput($('#mainPoolPercent').value, 70);
  const quotePoolPercent = parsePercentInput($('#quotePoolPercent').value, 10);
  const quoteVenue = selectedClassicQuoteVenue();
  const sliceShares = parseSliceShares($('#sliceShares').value);
  const ladderBands = clampNumber(parsePositiveInteger($('#ladderBands').value, 0), 0, CLASSIC_LADDER_MAX_BANDS);
  const supportSol = Math.max(0, parseNumericInput($('#supportSol').value, 0));
  // Fee Keys stay in the launch wallet and sweep to the verified return
  // wallet. Per-slice recipients were typed addresses, so they are not used.
  const feeKeyRecipient = '';
  const sweepDestination = $('#sweepDestination').value.trim();
  const targetMarketCapUsd = Math.max(0, parseNumericInput($('#targetMarketCapUsd').value, 25000));
  const manualBands = parseManualLadderBands(state.baseManualLadderText);
  const supportDepth = clampNumber(parseNumericInput(state.baseSupportDepth, 12), 1, 50);
  const supportLayers = parseSupportLayers(state.baseSupportLayersText);
  const airdrop = currentAirdropPlan();
  const preallocation = currentPreallocationPlan();

  const distribution = sliceShares.map((sharePercent, index) => ({
    sharePercent,
    recipient: index === sliceShares.length - 1 && feeKeyRecipient ? feeKeyRecipient : null,
  }));
  const solPool = {
    id: 'sol-main',
    quoteToken: 'SOL',
    quoteSymbol: 'SOL',
    supplyPercent: mainPoolPercent,
    ammConfigIndex: state.solPoolConfigIndex,
    distribution,
    bootstrap: { mode: 'minimal' },
    ladder: manualBands.length
      ? { mode: 'manual', bands: manualBands }
      : ladderBands > 0
      ? classicSimpleLadderConfig(ladderBands)
      : { mode: 'off' },
    support: supportSol > 0
      ? { mode: 'custom', solValue: supportSol, depthPct: supportDepth, ...(supportLayers.length ? { layers: supportLayers } : {}) }
      : { mode: 'off' },
  };
  const pools = [solPool];
  if (quotePoolPercent > 0) {
    pools.push({
      id: `${quoteVenue.key}-flywheel`,
      quoteToken: quoteVenue.quoteToken,
      quoteMint: quoteVenue.quoteMint,
      quoteSymbol: quoteVenue.symbol,
      supplyPercent: quotePoolPercent,
      ammConfigIndex: state.pairPoolConfigIndex,
      startPricePremiumPct: state.pairStartPremiumPct,
      distribution: [{ sharePercent: 100, recipient: feeKeyRecipient || null }],
      bootstrap: { mode: 'minimal' },
      ladder: { mode: 'off' },
      support: { mode: 'off' },
    });
  }
  state.customPools.forEach((pool, index) => {
    const resolvedInfo = customQuoteResolvedInfo(pool);
    const quoteSymbol = String(resolvedInfo?.symbol || pool.quoteSymbol || `Q${index + 1}`).trim().toUpperCase();
    const quoteMint = String(resolvedInfo?.address || pool.quoteMint || '').trim();
    const supplyPercent = parsePercentInput(pool.supplyPercent, 0);
    if (supplyPercent <= 0) return;
    const customManualBands = parseManualLadderBands(pool.ladderText);
    const customBandCount = clampNumber(parsePositiveInteger(pool.ladderBands, 0), 0, CLASSIC_LADDER_MAX_BANDS);
    const customSupportSol = Math.max(0, parseNumericInput(pool.supportSol, 0));
    pools.push({
      id: pool.id || `custom-${index + 1}`,
      quoteToken: quoteMint || quoteSymbol,
      quoteMint: quoteMint || null,
      quoteSymbol,
      quoteDecimals: optionalDecimals(resolvedInfo?.decimals) ?? optionalDecimals(pool.quoteDecimals) ?? null,
      quotePriceUsd: resolvedInfo?.priceUsd ?? null,
      quotePriceSource: resolvedInfo?.priceSource || null,
      quoteCompatibility: resolvedInfo ? {
        compatible: resolvedInfo.compatible ?? null,
        swapRoute: resolvedInfo.swapRoute || 'unknown',
        freezeAuthorityBlock: resolvedInfo.freezeAuthorityBlock ?? null,
        mintAuthorityWarning: resolvedInfo.mintAuthorityWarning ?? null,
        isToken2022: resolvedInfo.isToken2022 === true,
      } : null,
      supplyPercent,
      ammConfigIndex: Math.floor(parseNumericInput(pool.ammConfigIndex, DEFAULT_POOL_CONFIG_INDEX)),
      startPricePremiumPct: quoteMint === DEFAULT_SOL_MINT
        ? 0
        : clampNumber(parseNumericInput(pool.startPremiumPct ?? state.pairStartPremiumPct, state.pairStartPremiumPct), 0, 500),
      distribution: parseSliceShares(pool.sliceShares || '100').map((sharePercent, sliceIndex) => ({
        sharePercent,
        recipient: null, // Fee Keys follow the sweep to the verified return wallet.
      })),
      bootstrap: { mode: 'minimal' },
      ladder: customManualBands.length
        ? { mode: 'manual', bands: customManualBands }
        : customBandCount > 0
          ? classicSimpleLadderConfig(customBandCount)
          : { mode: 'off' },
      support: customSupportSol > 0
        ? {
          mode: 'custom',
          solValue: customSupportSol,
          depthPct: clampNumber(parseNumericInput(pool.supportDepth, 12), 1, 50),
          ...(parseSupportLayers(pool.supportLayersText).length ? { layers: parseSupportLayers(pool.supportLayersText) } : {}),
        }
        : { mode: 'off' },
    });
  });

  // A pool set to Meteora is one locked position: no slices, ladder or support.
  pools.forEach((pool) => {
    const custom = state.customPools.find((item) => item.id === pool.id) || null;
    const choice = pool.id === 'sol-main'
      ? { venue: state.solPoolVenue, damm: state.solPoolDamm }
      : String(pool.id || '').endsWith('-flywheel')
        ? { venue: state.quotePoolVenue, damm: state.quotePoolDamm }
        : custom ? { venue: custom.venue, damm: { feeBps: custom.dammFeeBps, rangeMultiple: custom.dammRange } } : null;
    if (choice?.venue !== 'meteora-damm-v2') return;
    Object.assign(pool, {
      venue: 'meteora-damm-v2',
      damm: { feeBps: Number(choice.damm?.feeBps) || 25, rangeMultiple: Number(choice.damm?.rangeMultiple) || 1000 },
      distribution: [{ sharePercent: 100, recipient: null }],
      ladder: { mode: 'off' },
      support: { mode: 'off' },
    });
  });

  const totalPoolPercent = pools.reduce((sum, pool) => sum + Number(pool.supplyPercent || 0), 0);
  const heldReservePercent = preallocation.supplyPercent + airdrop.supplyPercent;
  const reservePercent = clampNumber(100 - totalPoolPercent - heldReservePercent, 0, 100);
  const allocations = pools.map((pool) => {
    const quoteDecimalsOverride = optionalDecimals(pool.quoteDecimals);
    const quoteUsdOverride = Number.isFinite(Number(pool.quotePriceUsd)) && Number(pool.quotePriceUsd) > 0
      ? Number(pool.quotePriceUsd)
      : undefined;
    return {
      quoteToken: pool.quoteToken,
      quoteMint: pool.quoteMint || undefined,
      quoteDecimals: quoteDecimalsOverride,
      quoteDecimalsOverride,
      quoteUsdOverride,
      quoteCompatibility: pool.quoteCompatibility || undefined,
      supplyPercent: pool.supplyPercent,
      ammConfigIndex: pool.ammConfigIndex,
      quoteSymbolOverride: pool.quoteSymbol,
      distribution: pool.distribution,
      bootstrap: pool.bootstrap,
      ladder: pool.ladder,
      support: pool.support,
    };
  });

  return {
    targetMarketCapUsd,
    pools,
    allocations,
    totalPoolPercent,
    reservePercent,
    preallocation,
    airdrop: {
      enabled: airdrop.enabled,
      recipientCount: airdrop.recipientCount,
      supplyPercent: airdrop.supplyPercent,
      requestedSupplyPercent: airdrop.requestedSupplyPercent,
      requiredSupplyPercent: airdrop.requiredSupplyPercent,
      autoFit: airdrop.autoFit,
      budgetTokens: airdrop.budgetTokens,
      explicitTokens: airdrop.explicitTokens,
      remainingTokens: airdrop.remainingTokens,
      executionCostSol: airdrop.executionCostSol,
      budgetError: airdrop.budgetError,
      source: airdrop.source,
      recipients: airdrop.recipients,
    },
    feeKeyRecipient: feeKeyRecipient || null,
    sweepDestination: sweepDestination || null,
    heldShare: { funders: [...(state.heldShare.selected || [])] },
    report: {
      publish: state.prefs.publishLaunchReport !== false,
      download: true,
    },
    roundTo100: true,
  };
}

function currentLaunchConfig() {
  const tokenSymbol = ($('#tokenSymbol').value.trim() || 'TOK').toUpperCase();
  const classic = currentClassicModel();
  return {
    experience: {
      // Plan fingerprints of existing journals include this block, so it
      // keeps the value every launch used before the single flow.
      mode: 'advanced',
      recipeId: null,
      version: null,
    },
    token: {
      name: $('#tokenName').value,
      symbol: tokenSymbol,
      supply: $('#tokenSupply').value,
      description: $('#tokenDescription').value,
      logo: state.tokenLogo,
      sealedLaunch: $('#sealedLaunch')?.checked !== false,
      mintFormat: $('#mintFormat')?.value || 'token-2022',
    },
    launchSol: Number($('#launchSol').value || 0),
    mode: state.launchMode,
    vanity: currentVanityConfig(),
    poolTopology: classic,
    funding: {
      launchSol: Number($('#launchSol').value || 0),
      targetMarketCapUsd: classic.targetMarketCapUsd,
      estimate: state.classicFundingEstimate,
    },
    recovery: {
      activeJournalCount: state.recovery.activeJournalCount,
      failedJournalCount: state.recovery.failedJournalCount,
      pendingWalletCount: state.recovery.pendingWalletCount,
    },
  };
}
