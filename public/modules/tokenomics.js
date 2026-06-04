// ===========================================================================
// Tokenomics Preview Modal
// ===========================================================================
//
// Opened from "Visualize tokenomics" on step 2. Renders a donut chart of the
// planned token-supply distribution across pools + positions, plus a textual
// breakdown. Reads live pool state (so it reflects whatever the user has
// currently configured, including unsaved customize-mode edits) — no
// snapshot/copy of state is taken; close-and-reopen always shows current.

// Color palette for pool-level grouping. Each pool gets a base hue, and
// position types within that pool are shaded variants (bootstrap = darker,
// slices = base, ladder bands = progressively lighter). Wraps around if
// there are >5 pools (unusual but possible).
//
// Hues are drawn from the app/website parchment palette rather than the
// default chart blue/orange/etc., so the donut reads as part of the
// manuscript theme: rubric red, gold, olive-green, warm sienna, ink-brown.
const POOL_COLOR_BASES = [
  { name: 'rubric', h: 0,   s: 62 },   // manuscript red (primary)
  { name: 'gold',   h: 38,  s: 58 },   // gold highlight
  { name: 'olive',  h: 82,  s: 38 },   // olive-forest green
  { name: 'sienna', h: 22,  s: 50 },   // warm sienna/brown
  { name: 'umber',  h: 30,  s: 28 },   // muted ink-brown
];

// Position-type shades within a pool's hue. Returns an HSL string.
// `kind` is 'bootstrap', 'slice', or 'band'. `variant` is the per-kind
// index (e.g., band 0, band 1, ...) used to vary band brightness so the
// arcs are distinguishable from each other.
function poolPositionColor(poolIdx, kind, variant) {
  const base = POOL_COLOR_BASES[poolIdx % POOL_COLOR_BASES.length];
  let l; // lightness
  if (kind === 'bootstrap') {
    // Dark variant — bootstrap is the conceptual "anchor" of the pool.
    l = 32;
  } else if (kind === 'slice') {
    // Mid variant — the wide main LP.
    l = 50;
  } else {
    // band — progressively lighter for each subsequent band so adjacent
    // arcs read as distinct. Cap at 75 lightness so the colors don't
    // become unreadably pale.
    l = Math.min(75, 58 + (variant || 0) * 4);
  }
  return `hsl(${base.h}, ${base.s}%, ${l}%)`;
}

// Build the flat list of arcs from the live pool state. Each arc has:
//   poolIdx, kind ('bootstrap' | 'slice' | 'band'), variant, label,
//   share (fraction of total token supply, 0..1), color
//
// Iteration order matters: arcs in the same pool stay adjacent in the
// donut, with bootstrap first, slices next, bands last. That ordering
// makes the chart read left-to-right within each pool: anchor →
// distribution → ladder.
function buildTokenomicsArcs() {
  const arcs = [];
  pools.forEach((pool, poolIdx) => {
    const poolFraction = Number(pool.supplyPercent) / 100; // 0..1 of total
    // Bootstrap (% of pool → % of total)
    const bsCfg = pool.bootstrapConfig;
    if (bsCfg && bsCfg.mode === 'custom') {
      const bsPctOfPool = Number(bsCfg.supplyPercent) || 0;
      if (bsPctOfPool > 0) {
        arcs.push({
          poolIdx,
          kind: 'bootstrap',
          variant: 0,
          label: 'Bootstrap',
          share: (bsPctOfPool / 100) * poolFraction,
          color: poolPositionColor(poolIdx, 'bootstrap', 0),
        });
      }
    }
    // Wide slices (% of pool → % of total)
    (pool.distribution || []).forEach((s, i) => {
      const slicePctOfPool = Number(s.sharePercent) || 0;
      if (slicePctOfPool > 0) {
        arcs.push({
          poolIdx,
          kind: 'slice',
          variant: i,
          label: pool.distribution.length === 1
            ? 'Main LP'
            : `Slice ${i + 1}/${pool.distribution.length}`,
          share: (slicePctOfPool / 100) * poolFraction,
          color: poolPositionColor(poolIdx, 'slice', i),
        });
      }
    });
    // Ladder bands (% of pool → % of total)
    const ladder = pool.ladderConfig;
    if (ladder && ladder.mode === 'manual' && Array.isArray(ladder.bands)) {
      ladder.bands.forEach((b, i) => {
        const bandPctOfPool = Number(b.supplyPercent) || 0;
        if (bandPctOfPool > 0) {
          arcs.push({
            poolIdx,
            kind: 'band',
            variant: i,
            label: `Band ${i + 1} (${Number(b.lowerMultiplier).toFixed(2)}×–${Number(b.upperMultiplier).toFixed(2)}×)`,
            share: (bandPctOfPool / 100) * poolFraction,
            color: poolPositionColor(poolIdx, 'band', i),
          });
        }
      });
    }
  });
  // Preallocation arcs — render AFTER pool arcs so the donut reads
  // "LP positions clockwise, then preallocation holdback" with a
  // visual break at the boundary.
  //
  // The gap is purely a function of how much supply isn't allocated
  // to LP. Both modes contribute here:
  //   - SIMPLE mode with preallocation on: the user dialed the
  //     simple-mode prealloc slider; pools sum to (100 - prealloc%).
  //   - CUSTOMIZE mode: the user freely sized pools; whatever's left
  //     between the sum and 100% is implicit preallocation, held in
  //     the launch wallet.
  // Either way, the gap is preallocation and the donut should show
  // it explicitly so the user sees the full 100% of supply broken
  // down. Without this, customize-mode under-allocation produced a
  // visual gap in the donut that read as "missing config" rather
  // than "deliberately held back."
  //
  // The airdrop split — separating the airdrop's covered portion
  // from the launch-wallet remainder — only applies in simple mode,
  // since customize mode has no airdrop UI. In customize mode the
  // whole gap is a single "launch wallet (held back)" slice.
  //
  // Each arc carries a `poolIdx: -1` sentinel so renderTokenomicsBreakdownHtml
  // knows to render them in their own non-pool section. Coloring uses
  // a separate palette (slate/grey) so the preallocation slices are
  // visually distinct from any pool's color family.
  const poolsTotalPct = pools.reduce((s, p) => s + (Number(p.supplyPercent) || 0), 0);
  const gapPct = Math.max(0, 100 - poolsTotalPct);
  if (gapPct > 0.01) {
    const isSimpleMode = !simpleConfig.mode || simpleConfig.mode === 'default';
    const totalSupply = parseNumberInput(document.getElementById('tokenSupply'));
    // Airdrop only applies in simple mode (no airdrop UI in customize).
    const airdropOn = isSimpleMode
      && simpleConfig.preallocationEnabled
      && simpleConfig.airdrop && simpleConfig.airdrop.enabled
      && Array.isArray(simpleConfig.airdrop.parsedRows)
      && simpleConfig.airdrop.parsedRows.length > 0;
    // Airdrop's covered token amount as a fraction of total supply.
    let airdropFraction = 0;
    if (airdropOn && Number.isFinite(totalSupply) && totalSupply > 0) {
      const totalAirdropTokens = simpleConfig.airdrop.parsedRows
        .reduce((s, r) => s + (Number(r.tokens) || 0), 0);
      airdropFraction = totalAirdropTokens / totalSupply;
      // Clamp to the gap fraction — airdrop can never exceed the
      // preallocation. The budget gate normally blocks an over-budget
      // CSV before it reaches here; this cap is a defensive sanity
      // bound against any transient bookkeeping mismatch.
      airdropFraction = Math.min(airdropFraction, gapPct / 100);
    }
    const launchWalletFraction = (gapPct / 100) - airdropFraction;
    if (airdropFraction > 0) {
      arcs.push({
        poolIdx: -1,
        kind: 'prealloc-airdrop',
        variant: 0,
        label: 'Airdrop',
        share: airdropFraction,
        color: 'hsl(210, 22%, 48%)', // slate-blue, distinct from any pool hue
      });
    }
    if (launchWalletFraction > 0.0001) {
      arcs.push({
        poolIdx: -1,
        kind: 'prealloc-launch',
        variant: 0,
        label: airdropOn ? 'Launch wallet (unallocated)' : 'Launch wallet (held back)',
        share: launchWalletFraction,
        color: 'hsl(210, 14%, 65%)', // lighter slate for the leftover
      });
    }
  }
  return arcs;
}

// Compute the SVG path string for a donut-segment arc spanning [startA, endA]
// radians, with the given outer and inner radii, centered at (cx, cy).
// Handles the angle-wrap and large-arc flag correctly for any arc <2π.
function donutArcPath(cx, cy, rOuter, rInner, startA, endA) {
  // Avoid 0-width arcs producing degenerate paths.
  if (Math.abs(endA - startA) < 1e-6) return '';
  // Use the "large arc" flag when the arc spans more than half a circle.
  const large = (endA - startA) > Math.PI ? 1 : 0;
  // Cartesian conversion. SVG y axis is flipped — but our trig is
  // standard (anti-clockwise from +x), so we negate the sin term to
  // make the chart read clockwise as users expect.
  const x1 = cx + rOuter * Math.cos(startA);
  const y1 = cy + rOuter * Math.sin(startA);
  const x2 = cx + rOuter * Math.cos(endA);
  const y2 = cy + rOuter * Math.sin(endA);
  const x3 = cx + rInner * Math.cos(endA);
  const y3 = cy + rInner * Math.sin(endA);
  const x4 = cx + rInner * Math.cos(startA);
  const y4 = cy + rInner * Math.sin(startA);
  return [
    `M ${x1} ${y1}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${x4} ${y4}`,
    'Z',
  ].join(' ');
}

// Render the donut chart as SVG markup. Arcs share a starting angle of
// -π/2 (12 o'clock) and go clockwise. Returns an SVG string ready to
// drop into innerHTML.
function renderTokenomicsDonutSvg(arcs, { size = 360, logoDataUrl = null } = {}) {
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size * 0.45;
  const rInner = size * 0.28;

  // Total share covered. Should be ~1 if positions sum to 100% per pool
  // and pool supplyPercents sum to 100% of total supply. Defensive
  // normalization avoids gaps/overshoot if the math drifts.
  const total = arcs.reduce((s, a) => s + a.share, 0);
  if (total <= 0) {
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle"
            fill="#888" font-size="13">No positions configured</text>
    </svg>`;
  }

  let startA = -Math.PI / 2;
  let segments = '';
  for (const arc of arcs) {
    const sweep = (arc.share / total) * (2 * Math.PI);
    const endA = startA + sweep;
    const path = donutArcPath(cx, cy, rOuter, rInner, startA, endA);
    // title element gives hover tooltips in the browser (Electron's
    // Chromium supports them natively).
    const titleText = `${arc.label}: ${(arc.share * 100).toFixed(2)}% of total supply`;
    segments += `<path d="${path}" fill="${arc.color}" stroke="white" stroke-width="1">
      <title>${escapeHtml(titleText)}</title>
    </path>`;
    startA = endA;
  }

  // Center fill: if a logo data URL is available, embed it as a circular
  // image filling the donut hole. Otherwise fall back to the pool-count
  // summary text. This makes the chart strongly identity-anchored when a
  // logo exists — the chart reads as "the supply breakdown of THIS
  // specific token" rather than as a generic distribution diagram.
  //
  // Implementation: we draw a white circle behind the image as a clean
  // backdrop, clip the image to a circle via SVG <clipPath>, and inset
  // the image slightly from the inner radius so there's a small ring of
  // white between the logo edge and the innermost arc — that ring keeps
  // the logo from visually merging into the arcs at the boundary.
  let centerContent;
  if (logoDataUrl) {
    // Inset by 6% of inner radius to leave a clean ring of backdrop.
    // Cap the inset at a sensible minimum so very small charts don't
    // produce zero-pixel inset.
    const inset = Math.max(2, rInner * 0.06);
    const logoR = rInner - inset;
    const logoX = cx - logoR;
    const logoY = cy - logoR;
    const logoSize = logoR * 2;
    // clipPath ID is suffixed with the chart size so multiple charts on
    // one page (the modal AND the report-preview, if ever rendered side
    // by side) don't share a clip definition.
    const clipId = `donut-logo-clip-${size}`;
    centerContent = `
      <defs>
        <clipPath id="${clipId}">
          <circle cx="${cx}" cy="${cy}" r="${logoR}"/>
        </clipPath>
      </defs>
      <circle cx="${cx}" cy="${cy}" r="${rInner}" fill="white"/>
      <image href="${escapeAttr(logoDataUrl)}" x="${logoX}" y="${logoY}"
             width="${logoSize}" height="${logoSize}"
             preserveAspectRatio="xMidYMid slice"
             clip-path="url(#${clipId})"/>`;
  } else {
    const poolCount = pools.length;
    const positionCount = arcs.length;
    const centerLine1 = `${poolCount} pool${poolCount === 1 ? '' : 's'}`;
    const centerLine2 = `${positionCount} position${positionCount === 1 ? '' : 's'}`;
    centerContent = `
      <circle cx="${cx}" cy="${cy}" r="${rInner}" fill="white"/>
      <text x="${cx}" y="${cy - 8}" text-anchor="middle" dominant-baseline="middle"
            fill="#333" font-size="15" font-weight="600">${centerLine1}</text>
      <text x="${cx}" y="${cy + 12}" text-anchor="middle" dominant-baseline="middle"
            fill="#666" font-size="12">${centerLine2}</text>`;
  }

  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="display:block;margin:0 auto;">
    ${segments}
    ${centerContent}
  </svg>`;
}

// Render the textual breakdown panel next to the chart. Groups arcs by
// pool and lists each position with its supplyPercent and (for bands)
// the multiplier range. Uses small colored swatches that match the
// chart's arc colors so the user can correlate visual ↔ text.
function renderTokenomicsBreakdownHtml(arcs) {
  const name = document.getElementById('tokenName')?.value.trim() || '(unnamed)';
  const symbol = document.getElementById('tokenSymbol')?.value.trim() || '?';
  const supply = parseNumberInput(document.getElementById('tokenSupply'));
  const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
  const supplyStr = Number.isFinite(supply) && supply > 0
    ? supply.toLocaleString() : '—';
  const mcStr = Number.isFinite(targetMc) && targetMc > 0
    ? `$${targetMc.toLocaleString()}` : '—';

  let html = `
    <p class="is-size-6 mb-2"><strong>${escapeHtml(name)}</strong> · ${escapeHtml(symbol)}</p>
    <p class="is-size-7 has-text-grey mb-3">
      Supply: ${supplyStr} &nbsp;·&nbsp; Target market cap: ${mcStr}
    </p>
  `;

  pools.forEach((pool, poolIdx) => {
    const poolArcs = arcs.filter((a) => a.poolIdx === poolIdx);
    if (poolArcs.length === 0) return; // pool has no real positions
    const poolPct = Number(pool.supplyPercent).toFixed(2);
    const sym = pool.resolvedSymbol || pool.quoteSymbolOverride
      || (pool.quoteToken === 'SOL' ? 'SOL' : pool.quoteToken?.slice(0, 6) + '…');
    const sliceCount = (pool.distribution || []).filter((s) => Number(s.sharePercent) > 0).length;
    const bandCount = (pool.ladderConfig?.mode === 'manual'
      ? (pool.ladderConfig.bands || []).filter((b) => Number(b.supplyPercent) > 0).length
      : 0);
    const bsActive = pool.bootstrapConfig?.mode === 'custom'
      && Number(pool.bootstrapConfig.supplyPercent) > 0;
    const bsSol = bsActive ? Number(pool.bootstrapConfig.solValue) : 0;

    // Per-pool summary line.
    html += `
      <div class="mb-3">
        <p class="is-size-7 mb-1">
          <strong>${escapeHtml(sym)} pool</strong> &nbsp;·&nbsp; ${poolPct}% of supply
          &nbsp;·&nbsp;
          ${bsActive ? `${bsSol} SOL bootstrap, ` : 'no bootstrap, '}${sliceCount} LP slice${sliceCount === 1 ? '' : 's'}${bandCount > 0 ? `, ${bandCount} ladder band${bandCount === 1 ? '' : 's'}` : ''}
        </p>
        <div style="margin-left:1rem;">
    `;
    poolArcs.forEach((arc) => {
      html += `
        <div class="is-size-7" style="display:flex;align-items:center;gap:0.4rem;margin:0.15rem 0;">
          <span style="display:inline-block;width:10px;height:10px;background:${arc.color};border-radius:2px;flex-shrink:0;"></span>
          <span style="flex:1;">${escapeHtml(arc.label)}</span>
          <span class="has-text-grey">${(arc.share * 100).toFixed(2)}% of supply</span>
        </div>
      `;
    });
    html += '</div></div>';
  });

  // Preallocation section — listed AFTER pools since it's the holdback
  // portion that wasn't allocated to LP. Only renders when there are
  // preallocation arcs in the chart (poolIdx === -1 sentinel). The
  // header line summarizes the total holdback %; sub-lines split it
  // into airdrop / launch-wallet portions matching the chart slices.
  const preallocArcs = arcs.filter((a) => a.poolIdx === -1);
  if (preallocArcs.length > 0) {
    const preallocTotalShare = preallocArcs.reduce((s, a) => s + a.share, 0);
    const preallocTotalPct = (preallocTotalShare * 100).toFixed(2);
    html += `
      <div class="mb-3">
        <p class="is-size-7 mb-1">
          <strong>Preallocation</strong> &nbsp;·&nbsp; ${preallocTotalPct}% of supply
          &nbsp;·&nbsp; held back from LP
        </p>
        <div style="margin-left:1rem;">
    `;
    preallocArcs.forEach((arc) => {
      html += `
        <div class="is-size-7" style="display:flex;align-items:center;gap:0.4rem;margin:0.15rem 0;">
          <span style="display:inline-block;width:10px;height:10px;background:${arc.color};border-radius:2px;flex-shrink:0;"></span>
          <span style="flex:1;">${escapeHtml(arc.label)}</span>
          <span class="has-text-grey">${(arc.share * 100).toFixed(2)}% of supply</span>
        </div>
      `;
    });
    html += '</div></div>';
  }

  // Totals footer. The chart shows 100% when (pool allocations) +
  // (preallocation) sums to the full supply. Both are real arcs in
  // the `arcs` array, so the existing sum already covers this case
  // — but we need the warning text to actually be readable, so we
  // swap the unreadable yellow Bulma class for a darker amber tone
  // that has enough contrast against the parchment background.
  const totalShare = arcs.reduce((s, a) => s + a.share, 0);
  const totalPct = (totalShare * 100).toFixed(2);
  const allocated = totalPct === '100.00';
  // Use explicit colors instead of has-text-warning (a pale yellow
  // that disappears against the parchment background). Success stays
  // as the green class (good contrast). The warning case gets a deep
  // amber that reads clearly on the cream/parchment surface.
  const footerStyle = allocated
    ? 'color: #2c8a52;'  // ok-green, same family as has-text-success but tuned for parchment
    : 'color: #b8821a;'; // deep amber — readable on parchment, still clearly "caution"
  html += `
    <p class="is-size-7 mt-3" style="${footerStyle} font-weight: 600;">
      <strong>${allocated ? '✓' : '⚠'}</strong>
      &nbsp;${totalPct}% of supply allocated across all positions${allocated ? '' : ' — should be 100%'}
    </p>
  `;
  return html;
}

// Open the tokenomics modal. Called from the "Visualize tokenomics" button
// on step 2. Rebuilds the body content from live state on every open so
// the user always sees their current configuration.
//
// If the user has selected a token logo, we embed it in the donut's
// center as a strong identity anchor. The logo is read async via
// FileReader; to keep the modal opening feel instant we render the
// "text fallback" chart first, then swap in the logo-centered version
// as soon as the file is ready. On a fast disk this swap is invisible
// (the modal animates open during the read); on a slow disk the user
// sees the count-text chart briefly before it morphs.
function showTokenomicsModal() {
  const modal = document.getElementById('tokenomicsModal');
  if (!modal) return;

  // Wire close handlers on first open. Can't do this at module load via
  // bind() because the modal markup lives later in the HTML body and
  // app.js runs synchronously before the DOM finishes parsing — bind()
  // would silently fail (the "Element not found" console.warn case).
  // The dataset flag guards against duplicate listeners on repeat opens.
  // Same pattern showTokenInfoModal() uses for the same reason.
  if (!modal.dataset.closeHandlersWired) {
    const close = () => modal.classList.remove('is-active');
    const closeBtn = document.getElementById('tokenomicsModalCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', close);
    const bg = document.getElementById('tokenomicsModalBackground');
    if (bg) bg.addEventListener('click', close);
    // Escape key closes too, but only when this modal is the one open.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('is-active')) close();
    });
    modal.dataset.closeHandlersWired = 'true';
  }

  const arcs = buildTokenomicsArcs();
  const breakdownHtml = renderTokenomicsBreakdownHtml(arcs);
  const body = document.getElementById('tokenomicsModalBody');

  // First paint: render the count-text chart and show the modal so it
  // opens instantly. The chart goes into a slot div we can re-render in
  // place once the logo loads.
  const initialSvg = renderTokenomicsDonutSvg(arcs);
  body.innerHTML = `
    <div class="columns is-vcentered">
      <div class="column is-narrow" id="tokenomicsChartSlot">${initialSvg}</div>
      <div class="column">${breakdownHtml}</div>
    </div>
  `;
  modal.classList.add('is-active');

  // Second paint (async): if a logo is selected, swap the chart for a
  // logo-centered version. Fire-and-forget — failures fall back to the
  // initial chart already on screen. We also re-check the modal is still
  // open so a quick close-then-reopen doesn't overwrite the second open's
  // chart with stale data from the first.
  readLogoAsDataUrl().then((logoDataUrl) => {
    if (!logoDataUrl) return;
    if (!modal.classList.contains('is-active')) return;
    const slot = document.getElementById('tokenomicsChartSlot');
    if (!slot) return;
    slot.innerHTML = renderTokenomicsDonutSvg(arcs, { logoDataUrl });
  }).catch(() => { /* ignore — fallback chart is already visible */ });
}

bind('visualizeTokenomicsBtn', 'click', showTokenomicsModal);

