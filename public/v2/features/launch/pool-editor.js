function poolLadderCount(pool) {
  if (pool?.ladder?.mode === 'manual') return pool.ladder.bands?.length || 0;
  if (pool?.ladder?.mode === 'simple') return Number(pool.ladder.bandCount || 0);
  return 0;
}

function poolPreviewHtml(pool, fallback = 'Set supply % to include this pool') {
  if (!pool) {
    return `<div class="empty-state">${escapeHtml(fallback)}</div>`;
  }
  const sliceRows = (pool.distribution || []).map((slice, index) => {
    const effective = Number(pool.supplyPercent || 0) * (Number(slice.sharePercent || 0) / 100);
    return `
      <span>
        <small>Slice ${index + 1}</small>
        <strong>${formatPercent(slice.sharePercent)}% pool / ${formatPercent(effective)}% supply</strong>
      </span>
    `;
  }).join('');
  const ladder = pool.ladder?.mode === 'manual'
    ? `${pool.ladder.bands?.length || 0} manual`
    : pool.ladder?.mode === 'simple'
      ? `${pool.ladder.bandCount} simple`
      : 'off';
  const support = pool.support?.mode === 'custom'
    ? `${Number(pool.support.solValue || 0).toFixed(2)} SOL / ${pool.support.depthPct}%`
    : 'off';
  return `
    <div class="pool-mini-grid">
      <span><small>Quote</small><strong>${escapeHtml(pool.quoteSymbol || pool.quoteToken)}</strong></span>
      <span><small>Pool supply</small><strong>${formatPercent(pool.supplyPercent)}%</strong></span>
      <span><small>Ladder</small><strong>${escapeHtml(ladder)}</strong></span>
      <span><small>Support</small><strong>${escapeHtml(support)}</strong></span>
      ${sliceRows}
    </div>
  `;
}

function renderCustomQuoteInfoPanel(pool) {
  const lookup = customQuoteLookupValue(pool);
  const info = customQuoteResolvedInfo(pool);
  const badge = customQuoteInfoBadge(pool);
  const canCheck = Boolean(lookup)
    && state.apiStatus === 'connected'
    && Boolean(state.apiClient?.getQuoteTokenInfo)
    && !customQuoteInfoRecord(pool)?.loading;
  const facts = info ? [
    ['Symbol', info.symbol || pool.quoteSymbol || '-'],
    ['Decimals', info.decimals ?? '-'],
    ['Price', info.priceUsd ? `$${Number(info.priceUsd).toPrecision(6)}` : '-'],
    ['Route', { raydium: 'Raydium', jupiter: 'Jupiter', none: 'none' }[info.swapRoute] || 'unknown'],
    ['Program', info.isToken2022 ? 'Token-2022' : 'SPL'],
    ['Authorities', info.freezeAuthorityBlock === true ? 'freeze risk' : info.mintAuthorityWarning === true ? 'mint warning' : info.freezeAuthorityBlock == null ? 'unknown' : 'safe'],
  ] : [];
  return `
    <div class="quote-info-panel ${escapeHtml(badge.className)}">
      <div>
        <span class="risk-badge ${escapeHtml(badge.className)}">${escapeHtml(badge.label)}</span>
        <small>${escapeHtml(badge.detail)}</small>
      </div>
      ${facts.length ? `<div class="quote-info-facts">
        ${facts.map(([label, value]) => `<span><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></span>`).join('')}
      </div>` : ''}
      <button class="pill-button" type="button" data-action="resolve-custom-quote" data-pool-id="${escapeHtml(pool.id)}" ${canCheck ? '' : 'disabled'}>
        ${customQuoteInfoRecord(pool)?.loading ? 'Checking' : 'Verify quote'}
      </button>
    </div>
  `;
}

// Amber and violet are reserved for Team and Airdrop.
const SUPPLY_PAIR_COLORS = ['#78a8ff', '#e07ab0', '#5fc7c7', '#f08a5d', '#8fd06a', '#6fd3ff', '#d68fe0', '#c9d86a'];

// One row per place the supply goes. Pool % inputs write through to the
// existing form fields (or custom pool state), so the launch model is unchanged.
// What a fee tier means for a pool: the swap fee, and how coarse its price steps are
// (one tick is 0.01%, a tier's spacing is that many ticks).
// A small picture of a pool's shape, in the pool's colour: its main position, its ladder bands above
// the start price, and its support (layers or one range) below it. The same drawing as the price map,
// without the words.
function poolGlyphSvg(pool, color) {
  if (!pool) return '<span class="supply-glyph" aria-hidden="true"></span>';
  const W = 72, H = 28, START = 26, BASE = 23, RIGHT = 70;
  const tint = (pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;
  const xOf = (mult) => START + (RIGHT - START) * (Math.log(Math.max(1, mult)) / Math.log(1000));
  const parts = [`<rect x="${START}" y="${BASE - 3}" width="${RIGHT - START}" height="3" style="fill:${tint(45)}"/>`];
  let bands = [];
  if (pool.ladder?.mode === 'manual') {
    bands = (pool.ladder.bands || []).map((band) => ({ lo: band.lowerMultiplier, hi: band.upperMultiplier, weight: band.supplyPercent }));
  } else if (pool.ladder?.mode === 'simple' && pool.ladder.bandCount > 0) {
    const count = pool.ladder.bandCount;
    const unit = Math.log(Number(pool.ladder.ceilingMultiplier) || 1000) / (2 * count - 1);
    bands = Array.from({ length: count }, (_, i) => ({ lo: Math.exp(2 * i * unit), hi: Math.exp((2 * i + 1) * unit), weight: 1 }));
  }
  const top = Math.max(1e-9, ...bands.map((band) => band.weight));
  bands.forEach((band) => {
    const h = 4 + 13 * (band.weight / top);
    const x = xOf(band.lo);
    parts.push(`<rect x="${x.toFixed(1)}" y="${(BASE - 3 - h).toFixed(1)}" width="${Math.max(1.5, xOf(band.hi) - x).toFixed(1)}" height="${h.toFixed(1)}" style="fill:${tint(60)}"/>`);
  });
  const support = pool.support?.mode === 'custom' ? pool.support : null;
  if (support) {
    const layers = Array.isArray(support.layers) && support.layers.length
      ? support.layers
      : [{ sharePercent: 100, lowerMultiplier: 1 - (Number(support.depthPct) || 12) / 100, upperMultiplier: 1 }];
    const reach = Math.max(12, ...layers.map((layer) => (1 - layer.lowerMultiplier) * 100)) * 1.05;
    const xDown = (pct) => START - (START - 2) * (pct / reach);
    const topShare = Math.max(...layers.map((layer) => layer.sharePercent));
    layers.forEach((layer) => {
      const x1 = xDown((1 - layer.lowerMultiplier) * 100);
      const x2 = xDown((1 - layer.upperMultiplier) * 100);
      const h = 5 + 14 * (layer.sharePercent / topShare);
      parts.push(`<rect x="${x1.toFixed(1)}" y="${(BASE - h).toFixed(1)}" width="${Math.max(1.5, x2 - x1 - 0.8).toFixed(1)}" height="${h.toFixed(1)}" style="fill:${tint(34)};stroke:${color};stroke-width:.6"/>`);
    });
  }
  parts.push(`<line x1="${START}" x2="${START}" y1="3" y2="${BASE + 2}" style="stroke:${color};stroke-width:1.2"/>`);
  parts.push(`<line x1="1" x2="${RIGHT}" y1="${BASE}" y2="${BASE}" style="stroke:var(--line-strong);stroke-width:.8"/>`);
  return `<svg class="supply-glyph" viewBox="0 0 ${W} ${H}" aria-hidden="true" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;
}

function feeTierInfo(index) {
  const tiers = normalizeClmmFeeTiers(state.clmmFeeTiers);
  const tier = tiers.find((item) => item.index === Math.floor(Number(index)));
  if (!tier) return null;
  return {
    index: tier.index,
    fee: Number(tier.tradeFeeRate) / 10000,
    spacing: tier.tickSpacing,
    step: (Math.pow(1.0001, tier.tickSpacing) - 1) * 100,
    rank: tiers.indexOf(tier),
    count: tiers.length,
  };
}

function rowTierIndex(row) {
  if (row.key === 'sol') return state.solPoolConfigIndex ?? DEFAULT_POOL_CONFIG_INDEX;
  if (row.key === 'quote') return state.pairPoolConfigIndex ?? DEFAULT_POOL_CONFIG_INDEX;
  const pool = row.poolId ? state.customPools.find((item) => item.id === row.poolId) : null;
  return pool?.ammConfigIndex ?? DEFAULT_POOL_CONFIG_INDEX;
}

// The fee tier on the pool's own line: a short select showing the fee, so it reads and changes
// without opening the pool.
const METEORA_FEES = [25, 50, 100, 200];
const METEORA_RANGES_UI = [[100, '×100'], [1000, '×1,000'], [10000, '×10,000']];
const RAYDIUM_ROW_TIERS = [4, 5, 1, 3];

// Where a pool's venue and its fee live: the SOL pool and the preset pair in state, an added pair on the pair itself.
function poolVenueFor(row) {
  if (row.key === 'sol') return { venue: state.solPoolVenue, damm: state.solPoolDamm };
  if (row.key === 'quote') return { venue: state.quotePoolVenue, damm: state.quotePoolDamm };
  const pool = row.poolId ? state.customPools.find((item) => item.id === row.poolId) : null;
  return { venue: pool?.venue, damm: { feeBps: pool?.dammFeeBps, rangeMultiple: pool?.dammRange } };
}

function rowIsMeteora(row) {
  return poolVenueFor(row).venue === 'meteora-damm-v2';
}

function setPoolVenueChoice(rowKey, patch) {
  if (rowKey === 'sol') {
    if (patch.venue) state.solPoolVenue = patch.venue;
    state.solPoolDamm = { ...state.solPoolDamm, ...(patch.feeBps ? { feeBps: patch.feeBps } : {}), ...(patch.rangeMultiple ? { rangeMultiple: patch.rangeMultiple } : {}) };
    if (patch.tierIndex != null) state.solPoolConfigIndex = patch.tierIndex;
    return;
  }
  if (rowKey === 'quote') {
    if (patch.venue) state.quotePoolVenue = patch.venue;
    state.quotePoolDamm = { ...state.quotePoolDamm, ...(patch.feeBps ? { feeBps: patch.feeBps } : {}), ...(patch.rangeMultiple ? { rangeMultiple: patch.rangeMultiple } : {}) };
    if (patch.tierIndex != null) state.pairPoolConfigIndex = patch.tierIndex;
    return;
  }
  const pool = state.customPools.find((item) => `custom:${item.id}` === rowKey);
  if (!pool) return;
  if (patch.venue) pool.venue = patch.venue;
  if (patch.feeBps) pool.dammFeeBps = patch.feeBps;
  if (patch.rangeMultiple) pool.dammRange = patch.rangeMultiple;
  if (patch.tierIndex != null) pool.ammConfigIndex = patch.tierIndex;
}


// A row of buttons, one pressed: the venue (Raydium or Meteora) and the fee, under the pool's name.
function toggleGroupHtml({ label, action, rowKey, options, selected, extra = '' }) {
  return `<span class="pool-toggle" role="group" aria-label="${escapeHtml(label)}">${options.map(([value, text, title]) => (
    `<button type="button" class="${String(value) === String(selected) ? 'is-on' : ''}" data-action="${action}" data-row-key="${escapeHtml(rowKey)}" data-value="${escapeHtml(String(value))}" data-supply-key="${escapeHtml(rowKey)}:${action}:${escapeHtml(String(value))}" aria-pressed="${String(value) === String(selected)}"${title ? ` title="${escapeHtml(title)}"` : ''}${extra}>${escapeHtml(text)}</button>`
  )).join('')}</span>`;
}

function rowSwitchesHtml(row) {
  const meteora = rowIsMeteora(row);
  const venue = toggleGroupHtml({
    label: `${row.label} venue`, action: 'set-pool-venue', rowKey: row.key, selected: meteora ? 'meteora-damm-v2' : 'raydium',
    options: [['raydium', 'Raydium', 'Ranges: slices, ladder bands and support'], ['meteora-damm-v2', 'Meteora', 'One position, locked when the pool is made']],
  });
  let fee;
  if (meteora) {
    const current = Number(poolVenueFor(row).damm?.feeBps) || 25;
    fee = toggleGroupHtml({ label: `${row.label} fee`, action: 'set-pool-fee', rowKey: row.key, selected: current, options: METEORA_FEES.map((bps) => [bps, `${bps / 100}%`]) });
  } else {
    const tiers = normalizeClmmFeeTiers(state.clmmFeeTiers);
    const selected = Math.floor(Number(rowTierIndex(row)));
    const shown = tiers.filter((tier) => RAYDIUM_ROW_TIERS.includes(tier.index) || tier.index === selected);
    fee = toggleGroupHtml({
      label: `${row.label} fee tier`, action: 'set-pool-tier', rowKey: row.key, selected,
      options: (shown.length ? shown : tiers.slice(0, 4)).map((tier) => [tier.index, `${Number(tier.tradeFeeRate) / 10000}%`, `price steps of ${Number(((Math.pow(1.0001, tier.tickSpacing) - 1) * 100).toFixed(2))}%`])
        .concat(tiers.some((tier) => tier.index === selected) ? [] : [[selected, `#${selected}`]]),
    });
  }
  return `<span class="pool-switches">${venue}${fee}</span>`;
}

function supplyEditorRows() {
  const topology = currentClassicModel();
  const rows = [];
  const solPool = topology.pools.find((pool) => pool.id === 'sol-main');
  rows.push({
    key: 'sol', kind: 'pool', label: 'SOL', detail: 'Main market',
    percent: parsePercentInput($('#mainPoolPercent').value, 0), color: 'var(--green)',
    target: '#mainPoolPercent', locked: true, present: Boolean(solPool) || true,
  });
  const quotePercent = parsePercentInput($('#quotePoolPercent').value, 0);
  if (quotePercent > 0) {
    const venue = selectedClassicQuoteVenue();
    rows.push({
      key: 'quote', kind: 'pool', label: venue.symbol, detail: venue.quoteMint ? shortAddress(venue.quoteMint) : venue.label || '',
      percent: quotePercent, target: '#quotePoolPercent', removeTarget: '#quotePoolPercent',
    });
  }
  state.customPools.forEach((pool) => {
    const info = customQuoteResolvedInfo(pool);
    const symbol = String(info?.symbol || pool.quoteSymbol || '').trim().toUpperCase();
    const mint = String(info?.address || pool.quoteMint || '').trim();
    rows.push({
      key: `custom:${pool.id}`, kind: 'pool', label: symbol && symbol !== 'QUOTE' ? symbol : 'New pair',
      detail: mint ? shortAddress(mint) : '', needsMint: !mint, poolId: pool.id, mint,
      percent: parsePercentInput(pool.supplyPercent, 0),
    });
  });
  let pairIndex = 0;
  rows.forEach((row) => {
    if (row.kind === 'pool' && !row.color) row.color = SUPPLY_PAIR_COLORS[pairIndex++ % SUPPLY_PAIR_COLORS.length];
  });
  const share = heldSharePlan();
  rows.push({
    key: 'team', kind: 'hold', label: 'Team',
    detail: share.active
      ? `Split across ${share.rows.length} funding wallet${share.rows.length === 1 ? '' : 's'}`
      : 'Goes to the return wallet',
    percent: parsePercentInput($('#preallocationSupplyPercent').value, 0), color: 'var(--amber)',
    target: '#preallocationSupplyPercent',
  });
  const airdrop = currentAirdropPlan();
  // Shared held-back tokens already count in the Team row above.
  if (airdrop.csvRecipientCount > 0) {
    rows.push({
      key: 'airdrop', kind: 'hold', label: 'Airdrop',
      detail: `${airdrop.csvRecipientCount} wallet${airdrop.csvRecipientCount === 1 ? '' : 's'}`,
      percent: Math.max(0, Number(airdrop.supplyPercent || 0) - Number(airdrop.funderSharePercent || 0)),
      color: 'var(--violet)', target: '#airdropSupplyPercent',
    });
  }
  return rows;
}

// Inputs that change a non-SOL share of supply: other pools, the held-back
// team slice, and the airdrop (its percent, recipients, or fit).
const SUPPLY_SHARE_INPUT_IDS = new Set([
  'quotePoolPercent',
  'preallocationSupplyPercent',
  'airdropSupplyPercent',
  'airdropCsvText',
  'airdropWallets',
  'airdropAutoFit',
  'tokenSupply',
]);

// The main SOL pool takes whatever the other pools and held-back rows leave,
// so the split always totals 100% without balancing it by hand. Editing the
// SOL row itself never moves the others.
function mainPoolRemainderPercent() {
  const others = supplyEditorRows()
    .filter((row) => row.key !== 'sol')
    .reduce((sum, row) => sum + (Number(row.percent) || 0), 0);
  return Math.max(0, Math.round((100 - others) * 100) / 100);
}

function rebalanceMainPool() {
  const main = $('#mainPoolPercent');
  if (!main) return;
  const next = mainPoolRemainderPercent();
  if (parsePercentInput(main.value, 0) === next) return;
  main.value = String(next);
  main.dispatchEvent(new Event('input', { bubbles: true }));
}

// Runs after the current handler has applied its change.
function scheduleMainPoolRebalance() {
  queueMicrotask(rebalanceMainPool);
}

// Every pair pool sells the new token for its pair token. If that token
// falls, the new token is cheaper there than in the SOL pool, and bots buy
// it there and sell it into the SOL pool, taking SOL buyers' money. The
// start premium sets how far a pair token can fall before that begins.
function pairArbitrageWarningHtml(poolRows) {
  const pairs = poolRows.filter((row) => row.key !== 'sol' && row.percent > 0);
  if (!pairs.length) return '';
  const topology = currentClassicModel();
  const pairShare = pairs.reduce((sum, row) => sum + row.percent, 0);
  const premiums = topology.pools
    .filter((pool) => pool.id !== 'sol-main' && Number(pool.supplyPercent) > 0)
    .map((pool) => Number(pool.startPricePremiumPct || 0));
  const lowest = premiums.length ? Math.min(...premiums) : 0;
  const tolerance = lowest > 0 ? Math.round((1 - 1 / (1 + lowest / 100)) * 100) : 0;
  return `<p class="supply-warning" role="note"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>
    ${pairs.length === 1 ? 'This pair' : `These ${pairs.length} pairs`} hold${pairs.length === 1 ? 's' : ''} ${Number(pairShare.toFixed(2))}% of supply.
    ${tolerance > 0
      ? `If a pair token falls more than ${tolerance}% after launch, bots can buy your token in that pool and sell it into the SOL pool, taking SOL buyers' money.`
      : 'A pair opened at the SOL price lets bots drain SOL buyers as soon as the pair token falls.'}
    Keep pairs small.</span></p>`;
}

function renderSupplyEditor() {
  const target = $('#supplyEditor');
  if (!target) return;
  const active = document.activeElement;
  const focusKey = target.contains(active) ? active?.dataset?.supplyKey || null : null;

  const supply = parseWholeNumber($('#tokenSupply').value) || 1000000000;
  const rows = supplyEditorRows();
  const planPools = currentClassicModel().pools;
  const planPoolFor = (row) => (row.key === 'sol'
    ? planPools.find((pool) => pool.id === 'sol-main')
    : row.key === 'quote'
      ? planPools.find((pool) => String(pool.id).endsWith('-flywheel'))
      : planPools.find((pool) => pool.id === row.poolId));
  const total = Math.round(rows.reduce((sum, row) => sum + row.percent, 0) * 100) / 100;
  const remainder = Math.round((100 - total) * 100) / 100;
  const pools = rows.filter((row) => row.kind === 'pool');
  const poolPercent = pools.reduce((sum, row) => sum + row.percent, 0);
  const pct = (value) => `${Number(value.toFixed(2))}%`;

  const segments = rows.filter((row) => row.percent > 0).map((row) => (
    `<span style="flex:${row.percent} 0 0;background:${row.color}" title="${escapeHtml(`${row.label} ${pct(row.percent)}`)}"></span>`
  )).join('');
  const gap = remainder > 0 ? `<span class="supply-bar-gap" style="flex:${remainder} 0 0" title="${pct(remainder)} unassigned"></span>` : '';

  const totalHtml = `<div class="supply-total ${Math.abs(remainder) > 0.05 ? 'is-off' : ''}">
      <span>Total</span>
      <strong>${pct(total)}</strong>
      <small>${Math.abs(remainder) <= 0.05 ? `${compactAmount(supply)} tokens` : remainder > 0 ? `${pct(remainder)} unassigned` : `${pct(-remainder)} over`}</small>
    </div>`;

  // While a field in the table has focus, only the figures around it update.
  // Rewriting the field itself would move the cursor and reformat what the
  // user is still typing (e.g. "6." or "6.66"). The full refresh happens
  // when focus leaves the table.
  const editing = target.dataset.rendered === '1'
    && target.contains(active)
    && active.matches?.('input, textarea, select');
  if (editing) {
    target.querySelector('.supply-bar').innerHTML = segments + gap;
    const poolsHead = target.querySelector('[data-supply-pools-head]');
    if (poolsHead) poolsHead.textContent = `${pools.length} · ${pct(poolPercent)}`;
    rows.forEach((row) => {
      target.querySelectorAll(`[data-supply-amount="${CSS.escape(row.key)}"]`).forEach((amount) => {
        amount.textContent = compactAmount(supply * row.percent / 100);
      });
      target.querySelectorAll(`input[data-supply-key="${CSS.escape(row.key)}"]`).forEach((percentInput) => {
        if (percentInput !== active) percentInput.value = String(row.percent);
      });
    });
    target.querySelector('.supply-total')?.replaceWith(
      document.createRange().createContextualFragment(totalHtml),
    );
    renderPoolControlFeedback(target);
    renderReturnWalletCard();
    return;
  }
  if (!target.dataset.bound) {
    target.dataset.bound = '1';
    target.addEventListener('focusout', () => {
      window.setTimeout(() => {
        if (!target.contains(document.activeElement)) renderSupplyEditor();
      }, 0);
    });
  }

  // Each field names its control (aria-labelledby) and describes it with its
  // hint and live feedback (aria-describedby), so the helper text is not
  // read as part of the name. `feedback` names the live message under it.
  let fieldSeq = 0;
  const field = (label, hint, control, feedback = '', wide = false) => {
    const base = `supply-field-${++fieldSeq}`;
    const described = [feedback ? `${base}-note` : ''].filter(Boolean).join(' ');
    const wired = control.replace(/^\s*<(input|textarea|select)/, (match) => (
      `${match} aria-labelledby="${base}-label"${described ? ` aria-describedby="${described}"` : ''}`
    ));
    return `<label class="supply-field${wide ? ' supply-field-wide' : ''}"><span id="${base}-label">${escapeHtml(label)}</span>${wired}${feedback ? `<small class="supply-feedback" id="${base}-note" data-feedback="${feedback}" role="status"></small>` : ''}</label>`;
  };
  const SLICE_HINT = 'Percent of the pool in each locked position, e.g. 50,50. A single 100 is one position.';
  const LADDER_HINT = `Extra liquidity bands at higher prices. 0 to ${CLASSIC_LADDER_MAX_BANDS}. 0 = off.`;
  const settingsHtml = (row) => {
    const mapHost = '<div class="supply-field-wide pool-map" data-pool-map></div>';
    if (rowIsMeteora(row)) {
      const range = Number(poolVenueFor(row).damm?.rangeMultiple) || 1000;
      return `
        ${mapHost}
        <div class="supply-field supply-field-wide"><span>Price range</span>${toggleGroupHtml({ label: `${row.label} price range`, action: 'set-pool-range', rowKey: row.key, selected: range, options: METEORA_RANGES_UI.map(([value, text]) => [value, text]) })}</div>
        <p class="supply-field-wide supply-settings-empty">One position with this share of the supply, locked when the pool is made. No slices, ladder or support; buyers bring the ${escapeHtml(row.label)}.</p>`;
    }
    if (row.key === 'sol') {
      return `
        ${mapHost}
        ${field('Position slices', SLICE_HINT, `<input data-supply-target="#sliceShares" data-supply-key="sol:slices" value="${escapeHtml($('#sliceShares').value)}" autocomplete="off">`, 'slices')}
        ${field('Ladder bands', LADDER_HINT, `<input type="text" inputmode="numeric" autocomplete="off" data-supply-target="#ladderBands" data-supply-key="sol:ladder" value="${escapeHtml($('#ladderBands').value)}">`, 'ladder')}
        ${field('Support SOL', 'SOL placed just below the start price. 0 = off.', `<input type="text" inputmode="decimal" autocomplete="off" data-supply-target="#supportSol" data-supply-key="sol:support" value="${escapeHtml($('#supportSol').value)}">`, 'support')}
        ${field('Support depth %', 'How far below the start price support reaches.', `<input type="text" inputmode="numeric" autocomplete="off" data-base-field="baseSupportDepth" data-supply-key="sol:depth" value="${escapeHtml(state.baseSupportDepth)}">`)}
        ${field('Support layers', '', `<textarea rows="3" spellcheck="false" data-base-field="baseSupportLayersText" data-supply-key="sol:layers" placeholder="quote share%, low×, high× — one layer per line">${escapeHtml(state.baseSupportLayersText)}</textarea>`, 'layers', true)}
        ${field('Custom ladder', 'Replaces ladder bands when set.', `<textarea rows="3" spellcheck="false" data-base-field="manualLadderText" data-supply-key="sol:manual" placeholder="supply%, low×, high× — one band per line">${escapeHtml(state.baseManualLadderText)}</textarea>`, 'manual', true)}
        <div class="supply-field-wide"><button class="pill-button" type="button" data-action="round-slices-100">Round slices to 100%</button></div>`;
    }
    // The flywheel pair comes from a preset, not a custom pair: it has the two settings the preset
    // exposes, and can become a custom pair when it needs slices, a ladder or support.
    if (row.key === 'quote') {
      return `
        ${mapHost}
        ${field('Fee tier', '', `<select data-choice="slider" data-choice-readout data-quote-pool-field="ammConfigIndex" data-supply-key="quote:tier">${feeTierOptionsHtml(state.pairPoolConfigIndex ?? DEFAULT_POOL_CONFIG_INDEX)}</select>`)}
        ${field('Start above SOL price %', '', `<input type="text" inputmode="decimal" autocomplete="off" data-quote-pool-field="startPremiumPct" data-supply-key="quote:premium" value="${escapeHtml(state.pairStartPremiumPct)}">`, 'premium')}
        <div class="supply-field-wide"><button class="pill-button" type="button" data-action="customize-quote-pool"><i class="fa-solid fa-sliders" aria-hidden="true"></i><span>Edit slices, ladder and support</span></button></div>`;
    }
    const pool = row.poolId ? state.customPools.find((item) => item.id === row.poolId) : null;
    if (!pool) return '<p class="supply-settings-empty">This pool uses the default settings.</p>';
    const id = escapeHtml(pool.id);
    const key = escapeHtml(row.key);
    return `
      ${mapHost}
      ${field('Fee tier', 'Swap fee charged by the pool.', `<select data-choice="slider" data-choice-readout data-custom-pool-field="ammConfigIndex" data-pool-id="${id}" data-supply-key="${key}:tier">${feeTierOptionsHtml(pool.ammConfigIndex ?? DEFAULT_POOL_CONFIG_INDEX)}</select>`)}
      ${field('Start above SOL price %', 'Opens this pair above the SOL pool price, so the pair token can fall this far before bots can drain SOL buyers. 0 to 500.', `<input type="text" inputmode="decimal" autocomplete="off" data-custom-pool-field="startPremiumPct" data-pool-id="${id}" data-supply-key="${key}:premium" value="${escapeHtml(pool.startPremiumPct ?? state.pairStartPremiumPct)}">`, 'premium')}
      ${field('Position slices', SLICE_HINT, `<input data-custom-pool-field="sliceShares" data-pool-id="${id}" data-supply-key="${key}:slices" value="${escapeHtml(pool.sliceShares ?? '100')}" autocomplete="off">`, 'slices')}
      ${field('Ladder bands', LADDER_HINT, `<input type="text" inputmode="numeric" autocomplete="off" data-custom-pool-field="ladderBands" data-pool-id="${id}" data-supply-key="${key}:ladder" value="${escapeHtml(pool.ladderBands ?? 0)}">`, 'ladder')}
      ${field('Support SOL', 'SOL placed just below the start price. 0 = off.', `<input type="text" inputmode="decimal" autocomplete="off" data-custom-pool-field="supportSol" data-pool-id="${id}" data-supply-key="${key}:support" value="${escapeHtml(pool.supportSol ?? 0)}">`, 'support')}
      ${field('Support layers', '', `<textarea rows="3" spellcheck="false" data-custom-pool-field="supportLayersText" data-pool-id="${id}" data-supply-key="${key}:layers" placeholder="quote share%, low×, high× — one layer per line">${escapeHtml(pool.supportLayersText || '')}</textarea>`, 'layers', true)}
      ${field('Custom ladder', 'Replaces ladder bands when set.', `<textarea rows="3" spellcheck="false" data-custom-pool-field="ladderText" data-pool-id="${id}" data-supply-key="${key}:manual" placeholder="supply%, low×, high× — one band per line">${escapeHtml(pool.ladderText || '')}</textarea>`, 'manual', true)}
      <div class="supply-field-wide"><button class="pill-button" type="button" data-action="round-slices-100">Round slices to 100%</button></div>
`;
  };

  // An accordion: the open pool's settings open under its row and every other row stays put.
  // A panel that is opening starts closed and one that is closing starts open, so the height
  // eases whichever way it goes, even when the app redraws more than once per click.
  const shownKey = target.dataset.rendered === '1' ? (target.dataset.shownKey || '') : (state.supplyOpenRow || '');
  const wantsOpen = (row) => state.supplyOpenRow === row.key;
  const wasOpen = (row) => shownKey === row.key;

  const rowHtml = (row) => {
    const input = row.poolId
      ? `data-custom-pool-field="supplyPercent" data-pool-id="${escapeHtml(row.poolId)}"`
      : `data-supply-target="${row.target}"`;
    const remove = row.poolId
      ? `<button class="supply-remove" type="button" data-action="remove-custom-pool" data-pool-id="${escapeHtml(row.poolId)}" aria-label="Remove ${escapeHtml(row.label)}"><i class="fa-solid fa-xmark"></i></button>`
      : row.removeTarget
        ? `<button class="supply-remove" type="button" data-action="supply-clear" data-supply-target="${row.removeTarget}" aria-label="Remove ${escapeHtml(row.label)}"><i class="fa-solid fa-xmark"></i></button>`
        : '<span class="supply-remove-spacer"></span>';
    const editingMint = row.poolId && (row.needsMint || focusKey === `${row.key}:mint`);
    const detail = editingMint
      ? (`<input class="supply-mint" data-custom-pool-field="quoteMint" data-pool-id="${escapeHtml(row.poolId)}" data-supply-key="${escapeHtml(row.key)}:mint" value="${escapeHtml(row.mint || '')}" placeholder="Paste token mint" autocomplete="off" spellcheck="false">`)
      : `<small>${escapeHtml(row.detail)}</small>`;
    return `
      <li class="supply-row${row.kind === 'pool' && state.supplyOpenRow === row.key ? ' is-open' : ''}">
        <i class="supply-swatch" style="background:${row.color}"></i>
        <span class="supply-name"><strong>${escapeHtml(row.label)}</strong>${detail}${row.kind === 'pool' ? rowSwitchesHtml(row) : ''}</span>
        <span class="supply-amount" data-supply-amount="${escapeHtml(row.key)}">${compactAmount(supply * row.percent / 100)}</span>
        ${row.kind === 'pool' ? poolGlyphSvg(planPoolFor(row), row.color) : '<span class="supply-glyph"></span>'}
        <label class="supply-percent"><input type="text" inputmode="decimal" autocomplete="off" value="${escapeHtml(String(row.percent))}" ${input} data-supply-key="${escapeHtml(row.key)}" aria-label="${escapeHtml(row.label)} percent of supply"><span>%</span></label>
        ${row.kind === 'pool'
          ? `<button class="supply-gear ${state.supplyOpenRow === row.key ? 'is-open' : ''}" type="button" data-action="supply-toggle-settings" data-supply-row="${escapeHtml(row.key)}" aria-expanded="${state.supplyOpenRow === row.key}" aria-label="${escapeHtml(row.label)} settings"><i class="fa-solid fa-sliders"></i></button>`
          : '<span class="supply-remove-spacer"></span>'}
        ${remove}
      </li>
      ${row.kind === 'pool' && (wantsOpen(row) || wasOpen(row)) ? `<li class="supply-settings-wrap${wasOpen(row) ? ' is-open' : ''}" data-settings-for="${escapeHtml(row.key)}"><div class="supply-settings">${settingsHtml(row)}</div></li>` : ''}`;
  };

  target.innerHTML = `
    <div class="supply-bar" role="img" aria-label="Supply split">${segments}${gap}</div>
    <div class="supply-group-head"><span>Pools</span><span class="pool-config-actions">
      <button class="pill-button" type="button" data-action="export-pool-config" title="Copy the pools as CSV"><i class="fa-regular fa-copy" aria-hidden="true"></i> Export</button>
      <button class="pill-button" type="button" data-action="import-pool-config" title="Load pools from CSV on the clipboard"><i class="fa-solid fa-file-import" aria-hidden="true"></i> Import</button>
      <span data-supply-pools-head>${pools.length} · ${pct(poolPercent)}</span></span></div>
    <ol class="supply-list">${pools.map((row) => rowHtml(row)).join('')}</ol>
    ${pairArbitrageWarningHtml(pools)}
    <button class="supply-add" type="button" data-action="add-custom-pool"><i class="fa-solid fa-plus"></i> Add pair</button>
    <div class="supply-group-head"><span>Held back</span></div>
    <ol class="supply-list">${rows.filter((row) => row.kind === 'hold').map((row) => rowHtml(row)).join('')}</ol>
    ${totalHtml}`;
  const nextKey = state.supplyOpenRow || '';
  if (shownKey !== nextKey) {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      if (!target.isConnected) return;
      target.querySelectorAll('.supply-settings-wrap').forEach((wrap) => {
        wrap.classList.toggle('is-open', wrap.dataset.settingsFor === nextKey);
      });
      target.dataset.shownKey = nextKey;
    }));
    window.setTimeout(() => {
      target.querySelectorAll('.supply-settings-wrap:not(.is-open)').forEach((wrap) => wrap.remove());
    }, 360);
  } else {
    target.dataset.shownKey = nextKey;
  }

  target.dataset.rendered = '1';
  renderPoolControlFeedback(target);
  renderReturnWalletCard();
}

// A picture of the pool the controls describe, redrawn as they change.
// Left of the start price: how far below it support SOL reaches and, for a
// pair, where the SOL pool's price sits. Right of it, price in multiples of the
// start (log scale): the main position covers all of it, ladder bands add
// liquidity at their own ranges. Below: the positions the pool is split into.
function poolMapSvg({ premiumPct, supportSol, depthPct, slices, bands, tier = null, supportLayers = [], meteora = null }) {
  const W = 640, START = 196, LEFT = 24, RIGHT = 620, BASE = 150;
  const maxMult = meteora ? Math.max(10, Number(meteora.rangeMultiple) || 1000) : Math.max(1000, ...bands.map((band) => band.hi));
  const xOf = (mult) => START + (RIGHT - START) * (Math.log(mult) / Math.log(maxMult));
  const premiumDrop = premiumPct > 0 ? (premiumPct / (100 + premiumPct)) * 100 : 0;
  const reach = Math.max(depthPct, premiumDrop, 10) * 1.1;
  const xDown = (pct) => START - (START - LEFT) * (pct / reach);
  const fmt = (n) => (Number.isInteger(n) ? String(n) : Number(n.toFixed(2)).toString());
  const parts = [];
  // main position: the whole range above the start price
  parts.push(`<rect class="pm-main" x="${START}" y="${BASE - 22}" width="${RIGHT - START}" height="22"/>`);
  // The fee tier's price steps, drawn as the lattice the position is cut into: wide spacing, few steps.
  if (tier) {
    const steps = Math.min(60, Math.max(4, Math.round(480 / tier.spacing)));
    for (let i = 1; i < steps; i += 1) {
      const x = START + ((RIGHT - START) * i) / steps;
      parts.push(`<line class="pm-tick" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${BASE - 22}" y2="${BASE}"/>`);
    }
  }
  parts.push(`<text class="pm-note" x="${START + 8}" y="${BASE - 7}">${meteora ? `Locked position · up to ×${Number(meteora.rangeMultiple).toLocaleString('en-US')}` : 'Main position · all prices above the start'}</text>`);
  if (meteora) parts.push(`<text class="pm-tag pm-strong" x="${RIGHT}" y="12" text-anchor="end">Meteora · ${Number(meteora.feeBps) / 100}% fee</text>`);
  // ladder bands
  const top = Math.max(...bands.map((band) => band.weight), 1);
  bands.forEach((band) => {
    const h = 16 + 62 * (band.weight / top);
    const x = xOf(Math.max(1, band.lo));
    const w = Math.max(3, xOf(band.hi) - x);
    parts.push(`<rect class="pm-band" x="${x.toFixed(1)}" y="${(BASE - 22 - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"/>`);
    if (band.label && w > 26) parts.push(`<text class="pm-tag" x="${(x + w / 2).toFixed(1)}" y="${(BASE - 22 - h - 5).toFixed(1)}" text-anchor="middle">${band.label}</text>`);
  });
  // support SOL, just below the start price: one range, or a layer per range, each as tall as its
  // share of the quote
  const xs = xDown(depthPct);
  const supportW = START - xs;
  const supportText = `${fmt(supportSol)} SOL · −${fmt(depthPct)}%`;
  if (supportSol > 0 && supportLayers.length) {
    const totalShare = supportLayers.reduce((sum, layer) => sum + layer.sharePercent, 0) || 100;
    const topShare = Math.max(...supportLayers.map((layer) => layer.sharePercent));
    supportLayers.forEach((layer) => {
      const x1 = xDown((1 - layer.lowerMultiplier) * 100);
      const x2 = xDown((1 - layer.upperMultiplier) * 100);
      const h = 14 + 46 * (layer.sharePercent / topShare);
      const sol = supportSol * (layer.sharePercent / totalShare);
      parts.push(`<rect class="pm-support" x="${x1.toFixed(1)}" y="${(BASE - h).toFixed(1)}" width="${Math.max(3, x2 - x1 - 1).toFixed(1)}" height="${h.toFixed(1)}"/>`);
      if (x2 - x1 > 38) parts.push(`<text class="pm-tag" x="${((x1 + x2) / 2).toFixed(1)}" y="${(BASE - h - 4).toFixed(1)}" text-anchor="middle">${fmt(sol)} SOL</text>`);
    });
  } else {
    parts.push(supportSol > 0
      ? `<rect class="pm-support" x="${xs.toFixed(1)}" y="${BASE - 60}" width="${Math.max(3, supportW).toFixed(1)}" height="60"/><text class="pm-tag" x="${(START - 6).toFixed(1)}" y="${BASE - 66}" text-anchor="end">${supportText}</text>`
      : `<rect class="pm-off" x="${xs.toFixed(1)}" y="${BASE - 60}" width="${Math.max(3, supportW).toFixed(1)}" height="60"/>${supportW > 70 ? `<text class="pm-note" x="${((xs + START) / 2).toFixed(1)}" y="${BASE - 28}" text-anchor="middle">no support</text>` : ''}`);
  }
  // the SOL pool's price, for a pair
  if (premiumDrop > 0) {
    const xp = xDown(premiumDrop);
    parts.push(`<line class="pm-sol" x1="${xp.toFixed(1)}" x2="${xp.toFixed(1)}" y1="26" y2="${BASE}"/>`
      + `<text class="pm-tag" x="${Math.max(xp, LEFT + 44).toFixed(1)}" y="16" text-anchor="middle">SOL pool price</text>`
      + `<text class="pm-note" x="${((xp + START) / 2).toFixed(1)}" y="40" text-anchor="middle">+${fmt(premiumPct)}%</text>`
      + `<line class="pm-gap" x1="${xp.toFixed(1)}" x2="${START}" y1="46" y2="46"/>`);
  }
  // start price and axis
  parts.push(`<line class="pm-start" x1="${START}" x2="${START}" y1="26" y2="${BASE + 6}"/><text class="pm-tag pm-strong" x="${START}" y="${premiumDrop > 0 ? 26 : 16}" dy="-4" text-anchor="middle">Start price</text>`);
  parts.push(`<line class="pm-axis" x1="${LEFT}" x2="${RIGHT}" y1="${BASE}" y2="${BASE}"/>`);
  for (let m = 1; m <= maxMult; m *= 10) {
    parts.push(`<line class="pm-axis" x1="${xOf(m).toFixed(1)}" x2="${xOf(m).toFixed(1)}" y1="${BASE}" y2="${BASE + 4}"/><text class="pm-note" x="${xOf(m).toFixed(1)}" y="${BASE + 17}" text-anchor="middle">${m === 1 ? 'start' : `${m}×`}</text>`);
  }
  // the positions this pool is split into
  const total = slices.reduce((sum, share) => sum + share, 0) || 100;
  let at = LEFT;
  slices.forEach((share, index) => {
    const w = (RIGHT - LEFT) * (share / total);
    parts.push(`<rect class="pm-slice pm-slice-${index % 2}" x="${at.toFixed(1)}" y="${BASE + 30}" width="${Math.max(1, w - 2).toFixed(1)}" height="18"/>`);
    if (w > 34) parts.push(`<text class="pm-tag" x="${(at + w / 2).toFixed(1)}" y="${BASE + 43}" text-anchor="middle">${fmt(share)}%</text>`);
    at += w;
  });
  // The fee tier as a meter: one notch per tier from the cheapest to the dearest, this one lit.
  if (tier) {
    // The meter is 40 wide however many tiers there are.
    const slot = 40 / tier.count;
    const mx = RIGHT - 40;
    for (let i = 0; i < tier.count; i += 1) {
      const h = 5 + (i * 14) / Math.max(1, tier.count - 1);
      parts.push(`<rect class="${i === tier.rank ? 'pm-tier-on' : 'pm-tier-off'}" x="${(mx + i * slot).toFixed(1)}" y="${(24 - h).toFixed(1)}" width="${Math.max(1.5, slot - 1).toFixed(1)}" height="${h.toFixed(1)}"/>`);
    }
    parts.push(`<text class="pm-tag pm-strong" x="${RIGHT - 44}" y="12" text-anchor="end">${fmt(tier.fee)}% fee</text>`
      + `<text class="pm-note" x="${RIGHT - 44}" y="24" text-anchor="end">$${fmt(tier.fee * 10)} per $1,000 · steps ${fmt(Number(tier.step.toFixed(2)))}%</text>`);
  }
  const title = 'Price map: where this pool\'s liquidity sits';
  return `<svg viewBox="0 0 ${W} ${BASE + 56}" role="img" aria-label="${title}" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;
}

// Every pool of the plan on one price axis, one colour per pool (the supply bar's colours).
// Each pool's main position is a stripe, support sits left of the start price, ladder bands stand
// above, and the bar below is every position, its width that position's share of the supply.
function poolsMapForPlan(pools = []) {
  const rows = supplyEditorRows();
  const colorOf = (pool) => {
    const key = pool.id === 'sol-main' ? 'sol' : pool.id.endsWith('-flywheel') ? 'quote' : `custom:${pool.id}`;
    return rows.find((row) => row.key === key)?.color || 'var(--green)';
  };
  const layers = pools.map((pool) => {
    const share = Math.max(0, Number(pool.supplyPercent) || 0);
    const slices = (pool.distribution || []).map((slice) => Number(slice.sharePercent) || 0).filter((value) => value > 0);
    const sliceTotal = slices.reduce((sum, value) => sum + value, 0) || 100;
    let bands = [];
    if (pool.ladder?.mode === 'manual') {
      bands = (pool.ladder.bands || []).map((band) => ({ lo: band.lowerMultiplier, hi: band.upperMultiplier, weight: share * (Number(band.supplyPercent) || 0) / 100 }));
    } else if (pool.ladder?.mode === 'simple' && pool.ladder.bandCount > 0) {
      const count = pool.ladder.bandCount;
      const unit = Math.log(Number(pool.ladder.ceilingMultiplier) || 1000) / (2 * count - 1);
      bands = Array.from({ length: count }, (_, i) => ({ lo: Math.exp(2 * i * unit), hi: Math.exp((2 * i + 1) * unit), weight: share / count }));
    }
    return {
      symbol: String(pool.quoteSymbol || pool.quoteToken || 'SOL').toUpperCase(),
      tier: feeTierInfo(pool.ammConfigIndex ?? DEFAULT_POOL_CONFIG_INDEX),
      color: colorOf(pool),
      share,
      support: pool.support?.mode === 'custom' ? { sol: Number(pool.support.solValue) || 0, depth: Number(pool.support.depthPct) || 12, layers: Array.isArray(pool.support.layers) ? pool.support.layers : [] } : null,
      slices: (slices.length ? slices : [100]).map((value) => (value / sliceTotal) * share),
      bands,
    };
  }).filter((layer) => layer.share > 0);
  if (!layers.length) return '';
  const W = 640, START = 196, LEFT = 24, RIGHT = 620, BASE = 168;
  const maxMult = Math.max(1000, ...layers.flatMap((layer) => layer.bands.map((band) => band.hi)));
  const xOf = (mult) => START + (RIGHT - START) * (Math.log(Math.max(1, mult)) / Math.log(maxMult));
  const maxDepth = Math.max(12, ...layers.map((layer) => layer.support?.depth || 0)) * 1.1;
  const xDown = (pct) => START - (START - LEFT) * (pct / maxDepth);
  const fmt = (n) => (Number.isInteger(n) ? String(n) : Number(n.toFixed(2)).toString());
  const tint = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;
  const totalShare = layers.reduce((sum, layer) => sum + layer.share, 0) || 100;
  const parts = [];
  // main positions: one stripe per pool, thickness by share, stacked on the axis
  let stackTop = BASE;
  layers.forEach((layer) => {
    const h = Math.max(3, 30 * (layer.share / totalShare));
    stackTop -= h;
    parts.push(`<rect x="${START}" y="${stackTop.toFixed(1)}" width="${RIGHT - START}" height="${h.toFixed(1)}" style="fill:${tint(layer.color, 38)};stroke:${layer.color}" stroke-width="1"/>`);
  });
  parts.push(`<text class="pm-note" x="${START + 8}" y="${(BASE - 4).toFixed(1)}">Main positions</text>`);
  // ladder bands, tallest = the largest share of supply
  const maxWeight = Math.max(1e-9, ...layers.flatMap((layer) => layer.bands.map((band) => band.weight)));
  layers.forEach((layer) => {
    layer.bands.forEach((band) => {
      const h = 12 + 70 * (band.weight / maxWeight);
      const x = xOf(band.lo);
      const w = Math.max(3, xOf(band.hi) - x);
      parts.push(`<rect x="${x.toFixed(1)}" y="${(stackTop - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" style="fill:${tint(layer.color, 45)};stroke:${layer.color}" stroke-width="1"/>`);
    });
  });
  // support SOL, left of the start price
  const maxSol = Math.max(1e-9, ...layers.map((layer) => layer.support?.sol || 0));
  layers.forEach((layer) => {
    if (!layer.support || layer.support.sol <= 0) return;
    if (layer.support.layers.length) {
      const total = layer.support.layers.reduce((sum, item) => sum + item.sharePercent, 0) || 100;
      layer.support.layers.forEach((item) => {
        const x1 = xDown((1 - item.lowerMultiplier) * 100);
        const x2 = xDown((1 - item.upperMultiplier) * 100);
        const h = 8 + 52 * ((layer.support.sol * item.sharePercent / total) / maxSol);
        parts.push(`<rect x="${x1.toFixed(1)}" y="${(BASE - h).toFixed(1)}" width="${Math.max(2, x2 - x1 - 1).toFixed(1)}" height="${h.toFixed(1)}" style="fill:${tint(layer.color, 30)};stroke:${layer.color}" stroke-width="1"/>`);
      });
      return;
    }
    const x = xDown(layer.support.depth);
    const h = 14 + 52 * (layer.support.sol / maxSol);
    parts.push(`<rect x="${x.toFixed(1)}" y="${(BASE - h).toFixed(1)}" width="${Math.max(3, START - x).toFixed(1)}" height="${h.toFixed(1)}" style="fill:${tint(layer.color, 30)};stroke:${layer.color}" stroke-width="1"/>`);
  });
  const supportSol = layers.reduce((sum, layer) => sum + (layer.support?.sol || 0), 0);
  if (supportSol > 0) parts.push(`<text class="pm-tag" x="${START - 6}" y="${BASE + 30}" text-anchor="end">${fmt(supportSol)} SOL support</text>`);
  parts.push(`<line class="pm-start" x1="${START}" x2="${START}" y1="22" y2="${BASE + 6}"/><text class="pm-tag pm-strong" x="${START}" y="14" text-anchor="middle">Start price</text>`);
  parts.push(`<line class="pm-axis" x1="${LEFT}" x2="${RIGHT}" y1="${BASE}" y2="${BASE}"/>`);
  for (let m = 1; m <= maxMult; m *= 10) {
    parts.push(`<line class="pm-axis" x1="${xOf(m).toFixed(1)}" x2="${xOf(m).toFixed(1)}" y1="${BASE}" y2="${BASE + 4}"/><text class="pm-note" x="${xOf(m).toFixed(1)}" y="${BASE + 17}" text-anchor="middle">${m === 1 ? 'start' : `${m}×`}</text>`);
  }
  // every position, its width its share of the supply
  let at = LEFT;
  const barY = BASE + 40;
  layers.forEach((layer) => {
    layer.slices.forEach((share) => {
      const w = (RIGHT - LEFT) * (share / totalShare);
      parts.push(`<rect x="${at.toFixed(1)}" y="${barY}" width="${Math.max(1, w - 2).toFixed(1)}" height="18" style="fill:${tint(layer.color, 45)};stroke:${layer.color}" stroke-width="1"/>`);
      if (w > 40) parts.push(`<text class="pm-tag" x="${(at + w / 2).toFixed(1)}" y="${barY + 13}" text-anchor="middle">${fmt(share)}%</text>`);
      at += w;
    });
  });
  const legend = layers.map((layer) => `<span><i style="background:${layer.color}"></i>${escapeHtml(layer.symbol)} <b>${fmt(layer.share)}%</b>${layer.tier ? ` · ${fmt(layer.tier.fee)}% fee` : ''}</span>`).join('');
  return `<svg viewBox="0 0 ${W} ${barY + 28}" role="img" aria-label="Where every pool's liquidity sits" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg><div class="pool-legend">${legend}</div>`;
}

// The same picture for a pool as the launch will build it (Create liquidity tab).
function poolMapForPool(pool) {
  const support = pool?.support?.mode === 'custom' ? pool.support : null;
  const slices = (pool?.distribution || []).map((slice) => Number(slice.sharePercent) || 0).filter((share) => share > 0);
  let bands = [];
  if (pool?.ladder?.mode === 'manual') {
    bands = (pool.ladder.bands || []).map((band) => ({ lo: band.lowerMultiplier, hi: band.upperMultiplier, weight: band.supplyPercent, label: `${Number(Number(band.supplyPercent).toFixed(1))}%` }));
  } else if (pool?.ladder?.mode === 'simple' && pool.ladder.bandCount > 0) {
    const count = pool.ladder.bandCount;
    const unit = Math.log(Number(pool.ladder.ceilingMultiplier) || 1000) / (2 * count - 1);
    bands = Array.from({ length: count }, (_, i) => ({ lo: Math.exp(2 * i * unit), hi: Math.exp((2 * i + 1) * unit), weight: 1, label: '' }));
  }
  return poolMapSvg({
    premiumPct: 0,
    supportSol: support ? Number(support.solValue) || 0 : 0,
    depthPct: support ? Number(support.depthPct) || 12 : 12,
    slices: slices.length ? slices : [100],
    bands,
    supportLayers: support && Array.isArray(support.layers) ? support.layers : [],
    tier: feeTierInfo(pool?.ammConfigIndex ?? DEFAULT_POOL_CONFIG_INDEX),
  });
}

function renderPoolMap(panel) {
  const host = panel.querySelector('[data-pool-map]');
  if (!host) return;
  const value = (suffix) => panel.querySelector(`[data-supply-key$="${suffix}"]`)?.value ?? '';
  const number = (text, fallback = 0) => { const n = parseNumericInput(String(text), NaN); return Number.isFinite(n) ? n : fallback; };
  const premiumPct = Math.min(500, Math.max(0, number(value(':premium'), 0)));
  const supportSol = Math.max(0, number(value(':support'), 0));
  const layerInput = analyzeSupportLayers(value(':layers')).layers;
  const depthPct = layerInput.length
    ? Math.min(99, Math.max(1, (1 - Math.min(...layerInput.map((layer) => layer.lowerMultiplier))) * 100))
    : Math.min(50, Math.max(1, number(value(':depth'), 12)));
  const slices = describeSliceInput(value(':slices')).slices;
  const manual = analyzeManualLadder(value(':manual')).bands;
  const count = Math.floor(Math.min(CLASSIC_LADDER_MAX_BANDS, Math.max(0, number(value(':ladder'), 0))));
  let bands = [];
  if (manual.length) {
    bands = manual.map((band) => ({ lo: band.lowerMultiplier, hi: band.upperMultiplier, weight: band.supplyPercent, label: `${Number(band.supplyPercent.toFixed(1))}%` }));
  } else if (count > 0) {
    // Evenly spaced bands with a gap between each, up to 1000x (see computeLadderTicks).
    const unit = Math.log(1000) / (2 * count - 1);
    bands = Array.from({ length: count }, (_, i) => ({ lo: Math.exp(2 * i * unit), hi: Math.exp((2 * i + 1) * unit), weight: 1, label: '' }));
  }
  const parts = [`${slices.length} position${slices.length === 1 ? '' : 's'}`];
  parts.push(supportSol > 0 ? `${supportSol} SOL support to −${depthPct}%` : 'no support');
  parts.push(bands.length ? `${bands.length} ladder band${bands.length === 1 ? '' : 's'}` : 'no ladder');
  if (premiumPct > 0) parts.push(`opens ${premiumPct}% above the SOL price`);
  const tierIndex = panel.querySelector('[data-supply-key$=":tier"]')?.value
    ?? panel.closest('li')?.previousElementSibling?.querySelector('[data-action="set-pool-tier"].is-on')?.dataset.value;
  const rowKey = panel.closest('.supply-settings-wrap')?.dataset.settingsFor;
  const venueRow = rowKey ? supplyEditorRows().find((item) => item.key === rowKey) : null;
  const meteora = venueRow && rowIsMeteora(venueRow) ? poolVenueFor(venueRow).damm : null;
  const html = meteora
    ? poolMapSvg({ premiumPct: 0, supportSol: 0, depthPct: 12, slices: [100], bands: [], meteora: { feeBps: Number(meteora.feeBps) || 25, rangeMultiple: Number(meteora.rangeMultiple) || 1000 } })
    : `${poolMapSvg({ premiumPct, supportSol, depthPct, slices, bands, supportLayers: layerInput, tier: feeTierInfo(tierIndex ?? DEFAULT_POOL_CONFIG_INDEX) })}`;
  if (host.dataset.sig !== html) { host.dataset.sig = html; host.innerHTML = html; }
}

// Says what each advanced pool control will do with what was typed, next to
// the control: what the slices mean, which numbers were out of range, which
// ladder lines were skipped, and that a custom ladder replaces ladder bands.
function renderPoolControlFeedback(target) {
  target.querySelectorAll('.supply-settings').forEach((panel) => {
    renderPoolMap(panel);
    const input = (suffix) => panel.querySelector(`[data-supply-key$="${suffix}"]`);
    const say = (name, text, tone = 'ok') => {
      const note = panel.querySelector(`[data-feedback="${name}"]`);
      if (!note) return;
      if (note.textContent !== text) note.textContent = text;
      note.classList.toggle('is-warn', tone === 'warn');
    };
    const flag = (control, bad) => {
      if (!control) return;
      if (bad) control.setAttribute('aria-invalid', 'true');
      else control.removeAttribute('aria-invalid');
    };

    const slices = input(':slices');
    if (slices) {
      const info = describeSliceInput(slices.value);
      say('slices', info.text, info.tone);
      flag(slices, info.invalid);
    }

    const manual = input(':manual');
    const ladder = analyzeManualLadder(manual?.value);
    if (manual) {
      const parts = [];
      if (ladder.bands.length) {
        const used = ladder.bands.reduce((sum, band) => sum + band.supplyPercent, 0);
        parts.push(`${ladder.bands.length} band${ladder.bands.length === 1 ? '' : 's'} used, ${Number(used.toFixed(2))}% of supply.`);
      }
      if (ladder.rejected.length) {
        const shown = ladder.rejected.slice(0, 3).map((item) => `line ${item.line} "${item.text.slice(0, 24)}"`).join(', ');
        parts.push(`Skipped ${shown}${ladder.rejected.length > 3 ? ` and ${ladder.rejected.length - 3} more` : ''}. Each band needs supply%, low× (1 or more) and high× (above low).`);
      }
      say('manual', parts.join(' '), ladder.rejected.length ? 'warn' : 'ok');
      flag(manual, ladder.rejected.length > 0);
    }

    const layersField = input(':layers');
    const supportLayers = analyzeSupportLayers(layersField?.value);
    if (layersField) {
      const parts = [];
      if (supportLayers.layers.length) {
        const total = supportLayers.layers.reduce((sum, layer) => sum + layer.sharePercent, 0);
        const lowest = Math.min(...supportLayers.layers.map((layer) => layer.lowerMultiplier));
        parts.push(`${supportLayers.layers.length} layer${supportLayers.layers.length === 1 ? '' : 's'} down to ${Number((lowest * 100).toFixed(1))}% of the start price.`);
        if (Math.abs(total - 100) > 0.01) parts.push(`Shares add up to ${Number(total.toFixed(2))}%; they are scaled to 100%.`);
      }
      if (supportLayers.rejected.length) {
        const shown = supportLayers.rejected.slice(0, 3).map((item) => `line ${item.line} "${item.text.slice(0, 24)}"`).join(', ');
        parts.push(`Skipped ${shown}${supportLayers.rejected.length > 3 ? ` and ${supportLayers.rejected.length - 3} more` : ''}. Each layer needs share %, low× above 0 and high× up to 1.`);
      }
      if (supportLayers.overflow) parts.push(`Only the first ${SUPPORT_LAYERS_MAX} layers are used.`);
      say('layers', parts.join(' '), supportLayers.rejected.length || supportLayers.overflow ? 'warn' : 'ok');
      flag(layersField, supportLayers.rejected.length > 0);
    }
    const depthField = input(':depth');
    if (depthField) depthField.disabled = supportLayers.layers.length > 0;

    const bands = input(':ladder');
    if (bands) {
      const replaced = ladder.bands.length > 0;
      // The plan uses the custom ladder and ignores this number, so the
      // field is switched off while it has no effect.
      bands.disabled = replaced;
      const check = checkPoolNumberField('ladderBands', bands.value);
      say('ladder', replaced ? 'Not used: the Custom ladder below replaces it.' : check.issue || '', replaced || check.issue ? 'warn' : 'ok');
      flag(bands, !replaced && Boolean(check.issue));
    }
    [['premium', ':premium', 'premium'], ['support', ':support', 'supportSol']].forEach(([name, suffix, kind]) => {
      const control = input(suffix);
      if (!control) return;
      const check = checkPoolNumberField(kind, control.value);
      say(name, check.issue || '', check.issue ? 'warn' : 'ok');
      flag(control, Boolean(check.issue));
    });
  });
}

// When a number field is left, show the value the plan will use. Typing is
// never interrupted; this runs on the change event only.
function commitPoolControl(control) {
  const key = control?.dataset?.supplyKey || '';
  const kind = key.endsWith(':premium') ? 'premium'
    : key.endsWith(':ladder') ? 'ladderBands'
      : key.endsWith(':support') ? 'supportSol' : null;
  if (!kind || !control.closest?.('.supply-settings')) return;
  const check = checkPoolNumberField(kind, control.value);
  if (check.issue === null && control.value.trim() !== '') return;
  const label = { premium: 'Start premium', ladderBands: 'Ladder bands', supportSol: 'Support SOL' }[kind];
  control.value = String(check.value);
  control.dispatchEvent(new Event('input', { bubbles: true }));
  if (check.issue) notify(`${label}: ${check.issue}`);
}

function renderPoolEditorPanel() {
  const topology = currentClassicModel();
  const solPool = topology.pools.find((pool) => pool.id === 'sol-main');
  const quotePool = topology.pools.find((pool) => pool.id.endsWith('-flywheel'));
  const customRows = state.customPools.map((pool, index) => {
    const normalized = topology.pools.find((item) => item.id === pool.id);
    return `
      <article class="pool-row custom-pool-row">
        <div class="pool-row-head">
          <span>
            <span class="eyebrow">Custom quote pool</span>
            <h3>${escapeHtml(pool.quoteSymbol || `Pool ${index + 3}`)}</h3>
          </span>
          <button class="pill-button" type="button" data-action="remove-custom-pool" data-pool-id="${escapeHtml(pool.id)}">Remove</button>
        </div>
        <div class="pool-field-grid">
          <label><span>Quote symbol</span><input data-custom-pool-field="quoteSymbol" data-pool-id="${escapeHtml(pool.id)}" value="${escapeHtml(pool.quoteSymbol || '')}" autocomplete="off"></label>
          <label><span>Quote mint</span><input data-custom-pool-field="quoteMint" data-pool-id="${escapeHtml(pool.id)}" value="${escapeHtml(pool.quoteMint || '')}" placeholder="Mint address" autocomplete="off"></label>
          <label><span>Supply %</span><input data-custom-pool-field="supplyPercent" data-pool-id="${escapeHtml(pool.id)}" type="number" min="0" max="100" step="0.1" value="${escapeHtml(pool.supplyPercent ?? 5)}"></label>
          <label><span>Fee tier</span><select data-choice="slider" data-choice-readout data-custom-pool-field="ammConfigIndex" data-pool-id="${escapeHtml(pool.id)}">${feeTierOptionsHtml(pool.ammConfigIndex ?? DEFAULT_POOL_CONFIG_INDEX)}</select></label>
          <label><span>Slices</span><input data-custom-pool-field="sliceShares" data-pool-id="${escapeHtml(pool.id)}" value="${escapeHtml(pool.sliceShares || '100')}" autocomplete="off"></label>
          <label><span>Ladder bands</span><input data-custom-pool-field="ladderBands" data-pool-id="${escapeHtml(pool.id)}" type="number" min="0" max="${CLASSIC_LADDER_MAX_BANDS}" step="1" value="${escapeHtml(pool.ladderBands ?? 0)}"></label>
          <label><span>Support SOL</span><input data-custom-pool-field="supportSol" data-pool-id="${escapeHtml(pool.id)}" type="number" min="0" step="0.05" value="${escapeHtml(pool.supportSol ?? 0)}"></label>
        </div>
        <label class="wide-field">
          <span>Manual ladder bands</span>
          <textarea data-custom-pool-field="ladderText" data-pool-id="${escapeHtml(pool.id)}" rows="3" spellcheck="false" placeholder="supply%, lower-x, upper-x">${escapeHtml(pool.ladderText || '')}</textarea>
        </label>
        ${renderCustomQuoteInfoPanel(pool)}
        ${poolPreviewHtml(normalized)}
      </article>
    `;
  }).join('');

  $('#poolEditorPanel').innerHTML = `
    <div class="pool-editor-head">
      <span>
        <span class="eyebrow">Pool topology map</span>
        <h3>${topology.pools.length} pool${topology.pools.length === 1 ? '' : 's'} / ${topology.totalPoolPercent.toFixed(1)}% supply</h3>
      </span>
      <span class="risk-badge ${topology.totalPoolPercent + topology.preallocation.supplyPercent + topology.airdrop.supplyPercent > 100 ? 'danger' : ''}">
        ${topology.totalPoolPercent + topology.preallocation.supplyPercent + topology.airdrop.supplyPercent > 100 ? 'Over' : `${topology.reservePercent.toFixed(1)}% reserve`}
      </span>
    </div>
    <article class="pool-row">
      <div class="pool-row-head">
        <span>
          <span class="eyebrow">Main pool</span>
          <h3>SOL pool slices and support</h3>
        </span>
        <span class="risk-badge">Built in</span>
      </div>
      <div class="pool-field-grid">
        <label><span>Support depth %</span><input data-base-field="baseSupportDepth" type="number" min="1" max="50" step="1" value="${escapeHtml(state.baseSupportDepth)}"></label>
        <label><span>Effective slices</span><input value="${escapeHtml(normalizedSliceText($('#sliceShares').value))}" readonly></label>
      </div>
      <label class="wide-field">
        <span>Manual ladder bands</span>
        <textarea data-base-field="manualLadderText" rows="3" spellcheck="false" placeholder="supply%, lower-x, upper-x">${escapeHtml(state.baseManualLadderText)}</textarea>
      </label>
      ${poolPreviewHtml(solPool)}
    </article>
    ${quotePool ? `
      <article class="pool-row">
        <div class="pool-row-head">
          <span>
            <span class="eyebrow">Quote pool</span>
            <h3>${escapeHtml(quotePool.quoteSymbol)} route</h3>
          </span>
          <span class="risk-badge warn">Acquire</span>
        </div>
        ${poolPreviewHtml(quotePool)}
      </article>
    ` : ''}
    ${customRows || '<div class="empty-state">Add a quote pool for flywheel or custom liquidity venues.</div>'}
  `;
  enhanceNumberSteppers($('#poolEditorPanel'));
}

function phaseEventDone(stage, allocationIndex, indexKey = null, indexValue = null) {
  if (demoRunHasCompletedReadiness() && state.lastDemoLaunchRun?.liquidity) return true;
  return state.liveOps.lpEvents.some((event) => {
    if (event.stage !== stage) return false;
    if (Number(event.allocationIndex) !== Number(allocationIndex)) return false;
    if (!indexKey) return true;
    return Number(event[indexKey] || 0) === Number(indexValue || 0);
  });
}

function phaseTreeNode(label, complete) {
  return `
    <span class="phase-node ${complete ? 'complete' : 'waiting'}">
      <i class="fa-solid ${complete ? 'fa-check' : 'fa-circle'}"></i>
      <strong>${escapeHtml(label)}</strong>
    </span>
  `;
}

function renderClassicPhaseTree(topology) {
  const poolGroups = topology.pools.map((pool, poolIndex) => {
    const nodes = [
      phaseTreeNode('Create pool', phaseEventDone('pool_create_done', poolIndex)),
      ...(pool.distribution || []).flatMap((slice, sliceIndex) => [
        phaseTreeNode(`Open slice ${sliceIndex + 1}`, phaseEventDone('main_open_done', poolIndex, 'sliceIndex', sliceIndex)),
        phaseTreeNode(`Lock slice ${sliceIndex + 1}`, phaseEventDone('main_lock_done', poolIndex, 'sliceIndex', sliceIndex)),
        slice.recipient
          ? phaseTreeNode('Transfer Fee Key', phaseEventDone('fee_key_transfer_done', poolIndex))
          : '',
      ]),
      ...Array.from({ length: poolLadderCount(pool) }).flatMap((_, bandIndex) => [
        phaseTreeNode(`Open ladder ${bandIndex + 1}`, phaseEventDone('ladder_open_done', poolIndex, 'bandIndex', bandIndex)),
        phaseTreeNode(`Lock ladder ${bandIndex + 1}`, phaseEventDone('ladder_lock_done', poolIndex, 'bandIndex', bandIndex)),
      ]),
      pool.support?.mode === 'custom'
        ? phaseTreeNode('Open support', phaseEventDone('support_open_done', poolIndex, 'supportIndex', 0))
        : '',
      pool.support?.mode === 'custom'
        ? phaseTreeNode('Lock support', phaseEventDone('support_lock_done', poolIndex, 'supportIndex', 0))
        : '',
    ].filter(Boolean).join('');
    return `
      <article class="phase-tree-group">
        <div>
          <span class="eyebrow">Pool ${poolIndex + 1}</span>
          <h3>${escapeHtml(pool.quoteSymbol || pool.quoteToken)}</h3>
        </div>
        <div class="phase-node-grid">${nodes}</div>
      </article>
    `;
  }).join('');
  const proof = currentLaunchProof();
  const proofConfig = proofConfigForFingerprint(proof, currentLaunchConfig());
  const airdropComplete = liveAirdropComplete(topology, proof);
  const report = currentReportPublish(proof, proofConfig, { allowTransient: true });
  const localDossier = currentLocalDossier(proof, proofConfig);
  const sweepComplete = Boolean(demoRunHasCompletedReadiness() || transferHasWalletEmptyFinalSweepEvidence(proof?.transfer));
  const reportArtifactRecord = report || localDossier;
  const reportComplete = Boolean(
    reportArtifactRecord
    && (!sweepComplete || reportArtifactMatchesTerminalSweep(reportArtifactRecord, proof))
  );
  return `
    <div class="phase-tree-head">
      <span>
        <span class="eyebrow">Launch position tree</span>
        <h3>Create / open / lock / transfer checkpoints</h3>
      </span>
      <span class="risk-badge warn">${state.liveOps.lpEvents.length} live event${state.liveOps.lpEvents.length === 1 ? '' : 's'}</span>
    </div>
    <div class="phase-tree-grid">${poolGroups}</div>
    <div class="phase-tree-tail">
      ${phaseTreeNode(`Airdrop ${topology.airdrop.recipientCount || 0}`, !topology.airdrop.enabled || airdropComplete)}
      ${phaseTreeNode(state.prefs.publishLaunchReport !== false ? 'Publish report' : 'Local report', reportComplete)}
      ${phaseTreeNode('Sweep assets', sweepComplete)}
    </div>
  `;
}

function renderAirdropPanel() {
  const topology = currentClassicModel();
  const airdrop = topology.airdrop;
  const summary = $('#airdropSummary');
  const hasError = Boolean(state.airdropParseError || state.airdropBudgetError);
  summary.textContent = hasError
    ? 'Check CSV'
    : airdrop.enabled
      ? `${airdrop.recipientCount} / ${formatPercent(airdrop.supplyPercent)}%`
      : 'Off';
  // Off is the normal state, not a warning.
  summary.className = `risk-badge ${hasError ? 'danger' : airdrop.enabled ? '' : 'is-neutral'}`;
  const requested = Number(airdrop.requestedSupplyPercent || 0);
  const effective = Number(airdrop.supplyPercent || 0);
  const required = Number(airdrop.requiredSupplyPercent || 0);
  const raised = airdrop.autoFit && effective > requested + 0.0001;
  const budgetPanel = document.getElementById('airdropBudgetPanel');
  if (budgetPanel) {
    budgetPanel.innerHTML = `
      <div class="airdrop-budget-meter">
        <span style="width:${Math.min(100, effective)}%"></span>
      </div>
      <div class="airdrop-budget-grid">
        <span><small>Budget</small><strong>${formatPercent(effective)}%</strong></span>
        <span><small>Required</small><strong>${required ? `${formatPercent(required)}%` : '-'}</strong></span>
        <span><small>Tokens</small><strong>${compactAmount(airdrop.totalTokens || airdrop.budgetTokens || 0)}</strong></span>
        <span><small>Tx cost</small><strong>${airdrop.executionCostSol ? `${airdrop.executionCostSol.toFixed(4)} SOL` : '-'}</strong></span>
      </div>
      ${raised ? `<p class="airdrop-budget-hint">Auto-fit raised ${formatPercent(requested)}% to ${formatPercent(effective)}% to cover explicit CSV token amounts.</p>` : ''}
      ${airdrop.budgetError ? `<p class="airdrop-budget-error">${escapeHtml(airdrop.budgetError)}</p>` : ''}
    `;
  }
  const previewRows = airdrop.recipients.slice(0, 4).map((row) => `
    <div class="mini-row">
      <span>${escapeHtml(shortAddress(row.wallet))}</span>
      <strong>${compactAmount(row.tokens)} tokens</strong>
    </div>
  `).join('');
  const valueRows = hasError ? '' : airdropValueHtml(airdrop);
  $('#airdropRecipientPreview').innerHTML = valueRows || (hasError
    ? `<div class="mini-row danger"><span>${escapeHtml(state.airdropParseError || state.airdropBudgetError)}</span><strong>Fix</strong></div>`
    : previewRows || `<div class="mini-row"><span>${airdrop.enabled ? 'Manual count only; attach CSV before real transfer.' : 'No recipients attached.'}</span><strong>${airdrop.source}</strong></div>`);
}


// Pool config as CSV, in the same plain style as the custom ladder field: a line per pool, and
// `ladder,supply%,low×,high×` lines under a pool for its own bands. No token, wallet or key.
//
//   launch SOL,1
//   market cap USD,25000
//   symbol,mint,supply%,fee tier,start premium %,slices,ladder bands,support SOL,support depth %
//   SOL,,85,8,,100,5,0.1,12
//   RUG,RUGx1zSD…,5,4,25,50|50,0,0,12
//   ladder,50,2,10
//   bid,70,0.7,1       (a quote-side support layer: share % of the quote, low x, high x)
//   meteora,25,1000    (the pool above is a Meteora pool: fee in basis points, price range multiple)
const POOL_CONFIG_FORMAT = 'trebuchet-pool-config';
const POOL_CONFIG_HEADER = 'symbol,mint,supply%,fee tier,start premium %,slices,ladder bands,support SOL,support depth %';

function csvCell(value) {
  return String(value ?? '').replace(/[,\r\n]+/g, ' ').trim();
}

function buildPoolConfigExport() {
  const config = currentLaunchConfig();
  const topology = config.poolTopology || {};
  return {
    launchSol: config.launchSol,
    targetMarketCapUsd: topology.targetMarketCapUsd,
    pools: topology.pools || [],
  };
}

function poolConfigToCsv(data = buildPoolConfigExport()) {
  const lines = [
    '# Trebuchet pool config',
    `launch SOL,${csvCell(data.launchSol)}`,
    `market cap USD,${csvCell(data.targetMarketCapUsd)}`,
    POOL_CONFIG_HEADER,
  ];
  (data.pools || []).forEach((pool) => {
    const isSol = String(pool.quoteSymbol || pool.quoteToken || '').toUpperCase() === 'SOL' || pool.id === 'sol-main';
    const slices = (Array.isArray(pool.distribution) && pool.distribution.length ? pool.distribution : [{ sharePercent: 100 }])
      .map((slice) => Number(slice.sharePercent || 0)).join('|');
    const manual = pool.ladder?.mode === 'manual' && Array.isArray(pool.ladder.bands) ? pool.ladder.bands : [];
    const bandCount = manual.length ? 0 : (pool.ladder?.mode === 'simple' ? Number(pool.ladder.bandCount || 0) : 0);
    const support = pool.support?.mode === 'custom';
    lines.push([
      isSol ? 'SOL' : csvCell(pool.quoteSymbol || 'PAIR'),
      isSol ? '' : csvCell(pool.quoteMint || pool.quoteToken),
      Number(pool.supplyPercent || 0),
      Number(pool.ammConfigIndex ?? ''),
      isSol ? '' : Number(pool.startPricePremiumPct ?? 0),
      slices,
      bandCount,
      support ? Number(pool.support.solValue || 0) : 0,
      support ? Number(pool.support.depthPct || 12) : 12,
    ].join(','));
    manual.forEach((band) => lines.push(`ladder,${band.supplyPercent},${band.lowerMultiplier},${band.upperMultiplier}`));
    (support && Array.isArray(pool.support.layers) ? pool.support.layers : []).forEach((layer) => lines.push(`bid,${layer.sharePercent},${layer.lowerMultiplier},${layer.upperMultiplier}`));
    if (pool.venue === 'meteora-damm-v2') lines.push(`meteora,${pool.damm?.feeBps || 25},${pool.damm?.rangeMultiple || 1000}`);
  });
  return `${lines.join('\n')}\n`;
}

function exportPoolConfig() {
  return copyText(poolConfigToCsv(), 'Pool config');
}

function validatePoolConfigPools(pools) {
  if (!Array.isArray(pools) || !pools.length || pools.length > 24) throw new Error('The pool config has no usable pools');
  pools.forEach((pool) => {
    const percent = Number(pool?.supplyPercent);
    if (!pool || typeof pool !== 'object' || !Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new Error('A pool in the config has a bad supply share');
    }
  });
  if (pools.reduce((sum, pool) => sum + Number(pool.supplyPercent), 0) > 100.0001) {
    throw new Error('The pool shares add up to more than 100%');
  }
}

function parsePoolConfigCsv(text) {
  const data = { launchSol: undefined, targetMarketCapUsd: undefined, pools: [] };
  let current = null;
  let ladderText = '';
  let bidText = '';
  const finish = () => {
    if (!current) return;
    const bands = ladderText ? parseManualLadderBands(ladderText) : [];
    if (ladderText && !bands.length) throw new Error(`The ladder lines under ${current.quoteSymbol} have no usable band`);
    if (bands.length) current.ladder = { mode: 'manual', bands };
    const layers = bidText ? parseSupportLayers(bidText) : [];
    if (bidText && !layers.length) throw new Error(`The bid lines under ${current.quoteSymbol} have no usable layer`);
    if (layers.length) {
      if (current.support.mode !== 'custom') throw new Error(`${current.quoteSymbol} has bid lines but no support SOL`);
      current.support = { ...current.support, layers };
    }
    data.pools.push(current);
    current = null;
    ladderText = '';
    bidText = '';
  };
  String(text || '').split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const cells = line.split(',').map((cell) => cell.trim());
    const key = cells[0].toLowerCase();
    if (key === 'launch sol') { data.launchSol = Number(cells[1]); return; }
    if (key === 'market cap usd') { data.targetMarketCapUsd = Number(cells[1]); return; }
    if (key === 'symbol') return;
    if (key === 'ladder') {
      if (!current) throw new Error(`Line ${index + 1}: a ladder line needs a pool above it`);
      ladderText += `${cells.slice(1).join(', ')}\n`;
      return;
    }
    if (key === 'meteora') {
      if (!current) throw new Error(`Line ${index + 1}: a meteora line needs a pool above it`);
      current.venue = 'meteora-damm-v2';
      current.damm = { feeBps: Number(cells[1]) || 25, rangeMultiple: Number(cells[2]) || 1000 };
      return;
    }
    if (key === 'bid') {
      if (!current) throw new Error(`Line ${index + 1}: a bid line needs a pool above it`);
      bidText += `${cells.slice(1).join(', ')}\n`;
      return;
    }
    finish();
    const [symbol, mint, supply, tier, premium, slices, bands, supportSol, supportDepth] = cells;
    const isSol = symbol.toUpperCase() === 'SOL' && !mint;
    if (!isSol && !isProbablySolanaAddress(mint)) throw new Error(`Line ${index + 1}: ${symbol || 'the pool'} needs a token mint`);
    const shares = (slices || '100').split(/[|\s]+/).filter(Boolean).map(Number);
    if (!shares.length || shares.some((share) => !Number.isFinite(share) || share <= 0)) throw new Error(`Line ${index + 1}: the slices must be numbers like 50|50`);
    const bandCount = Math.floor(Number(bands || 0));
    const solValue = Number(supportSol || 0);
    current = {
      ...(isSol ? { id: 'sol-main', quoteToken: 'SOL', quoteSymbol: 'SOL' } : { quoteToken: mint, quoteMint: mint, quoteSymbol: symbol.toUpperCase() }),
      supplyPercent: Number(supply),
      ammConfigIndex: Number.isFinite(Number(tier)) && tier !== '' ? Math.floor(Number(tier)) : undefined,
      ...(isSol ? {} : { startPricePremiumPct: Number(premium || 0) }),
      distribution: shares.map((share) => ({ sharePercent: share, recipient: null })),
      bootstrap: { mode: 'minimal' },
      ladder: bandCount > 0 ? classicSimpleLadderConfig(bandCount) : { mode: 'off' },
      support: solValue > 0 ? { mode: 'custom', solValue, depthPct: Number(supportDepth || 12) } : { mode: 'off' },
    };
  });
  finish();
  return data;
}

function parsePoolConfigImport(text) {
  const body = String(text || '').trim();
  let data;
  if (body.startsWith('{')) {
    // The first export format was JSON; it still imports.
    try { data = JSON.parse(body); } catch { throw new Error('That is not a pool config'); }
    if (!data || data.format !== POOL_CONFIG_FORMAT || data.version !== 1) throw new Error('That is not a Trebuchet pool config');
  } else {
    if (!/^symbol\s*,/im.test(body)) throw new Error('That is not a Trebuchet pool config');
    data = parsePoolConfigCsv(body);
  }
  validatePoolConfigPools(data.pools);
  return data;
}

async function readPoolConfigText() {
  try {
    if (navigator.clipboard?.readText) return await navigator.clipboard.readText();
  } catch {}
  return openOperatorPrompt({
    eyebrow: 'Import',
    title: 'Paste a pool config',
    detail: 'Automatic clipboard access is unavailable. Paste the exported CSV below.',
    label: 'Pool config',
    multiline: true,
    confirmLabel: 'Import',
  });
}

async function importPoolConfig() {
  const text = await readPoolConfigText();
  if (text == null) return;
  try {
    const data = parsePoolConfigImport(text);
    const current = currentLaunchConfig();
    // Only the pools, launch SOL and market cap change; token, vanity and
    // airdrop stay as they are.
    restoreLaunchConfigFromJournal({
      launchConfig: {
        ...current,
        launchSol: Number.isFinite(Number(data.launchSol)) ? Number(data.launchSol) : current.launchSol,
        poolTopology: {
          ...current.poolTopology,
          pools: data.pools,
          targetMarketCapUsd: data.targetMarketCapUsd ?? current.poolTopology?.targetMarketCapUsd,
        },
      },
    });
    renderAll();
    notify(`Imported ${data.pools.length} pool${data.pools.length === 1 ? '' : 's'}`);
  } catch (error) {
    notify(error.message || 'Could not import the pool config');
  }
}

// A tier picked on a pool's line also moves the slider and the map inside its settings, so the
// editor is drawn again in full, and the select that was used keeps the keyboard focus.
function renderSupplyEditorAfterTier(control) {
  const key = control?.dataset?.supplyKey;
  const target = $('#supplyEditor');
  if (target) target.dataset.rendered = '';
  renderSupplyEditor();
  if (key) document.querySelector(`[data-supply-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}
