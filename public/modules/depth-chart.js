// depth-chart.js
//
// A small, dependency-free liquidity-depth chart for a SINGLE pool. Shared by
// two places:
//   - the pool editor, drawn live near the top of each pool as the user tweaks
//     bootstrap / ladder / distribution, and
//   - the launch report, drawn per pool.
//
// It shows where a pool's token-side liquidity sits across price: a flat
// baseline from the wide band, with taller "teeth" where ladder bands add
// depth, and valleys (or true empty gaps) in between. Thicker = price moves
// slower there; valleys = price runs faster. It's the same comb the buy
// simulator integrates over, drawn as a picture.
//
// Important shape facts that keep this simple:
//   - The comb's SHAPE is invariant to launch price AND total supply — those
//     just scale everything together. So we work in "× launch" price units
//     (launch = 1) and pool-relative liquidity. The chart only needs the pool's
//     own config and re-draws only when that pool changes.
//   - The UI carries ladder bands in manual form with "% of pool" semantics
//     (see buildAllocationsForApi), and each band's price range is its
//     lower/upper multiplier — no tick math required for a picture.
//
// Colors are hardcoded to the parchment palette (rather than CSS variables) so
// the SVG renders identically inside the app and inside the standalone,
// downloadable launch report, which doesn't carry the app's :root tokens.

// (Liquidity helpers live inside computeDepthProfile, since token-side and
// quote-side positions use different formulas.)

// Build the depth profile for one pool from its UI config.
//
// Token-side bands (wide + ladder, above launch) are denominated in tokens;
// the optional support position (below launch) is denominated in quote. To draw
// them on one comparable axis we work in USD value: a token band's value is its
// token fraction × the pool's notional (supplyPercent% × target market cap), and
// support's value is its SOL × the SOL price. CLMM liquidity L scaled this way
// is unit-consistent across the two sides, so heights are directly comparable.
//
// When the USD scaling inputs aren't available (no market cap / SOL price yet)
// we fall back to pool-relative token-side only — support is simply omitted.
//
// @param {object} opts  { poolNotionalUsd, support: { usd, depthPct } } — all
//   optional. Without poolNotionalUsd the token side is drawn in relative terms
//   and support is skipped.
// @returns {{ segments, minX, maxX, maxL, bands, hasWide, hasBootstrap,
//             hasLadder, hasSupport }}
function computeDepthProfile(pool, opts = {}) {
  if (!pool) return null;
  const pct = (v) => (Number(v) || 0) / 100;

  const bs = pool.bootstrapConfig || { mode: 'minimal' };
  const bootstrapFrac = bs.mode === 'custom' ? pct(bs.supplyPercent) : 0;

  const ld = pool.ladderConfig || { mode: 'off', bands: [] };
  const ladderBands = (ld.mode === 'manual' && Array.isArray(ld.bands))
    ? ld.bands
        .map((b) => ({ frac: pct(b.supplyPercent), lo: Number(b.lowerMultiplier), hi: Number(b.upperMultiplier) }))
        .filter((b) => b.frac > 0 && b.lo >= 1 && b.hi > b.lo)
    : [];
  const ladderTotal = ladderBands.reduce((s, b) => s + b.frac, 0);
  const wideFrac = Math.max(0, 1 - bootstrapFrac - ladderTotal);

  const ladderTop = ladderBands.length ? Math.max(...ladderBands.map((b) => b.hi)) : 0;
  const capX = ladderTop > 1 ? ladderTop : 10;

  // Token-side amount -> USD value when we have a pool notional; otherwise the
  // bare fraction (relative shape only). The choice is consistent across all
  // token bands, so their relative shape is identical either way.
  const notional = Number(opts.poolNotionalUsd) > 0 ? Number(opts.poolNotionalUsd) : 0;
  const tokenValue = (frac) => notional > 0 ? frac * notional : frac;

  // Liquidity L for a token-side (base) position over [lo, hi] above launch.
  const Ltoken = (value, lo, hi) => {
    const d = 1 / Math.sqrt(lo) - 1 / Math.sqrt(hi);
    return d > 0 ? value / d : 0;
  };
  // Liquidity L for a quote-side position over [lo, hi] below launch.
  const Lquote = (value, lo, hi) => {
    const d = Math.sqrt(hi) - Math.sqrt(lo);
    return d > 0 ? value / d : 0;
  };

  // Support: only placeable on the shared axis when we can value it (needs the
  // pool notional to compare against, plus the support USD and a depth).
  const support = opts.support || null;
  const supportUsd = support ? Number(support.usd) : 0;
  const supportDepthPct = support ? Number(support.depthPct) : 0;
  const canPlaceSupport = notional > 0 && supportUsd > 0 && supportDepthPct > 0;
  const supportLo = canPlaceSupport ? Math.max(0.05, 1 - supportDepthPct / 100) : 1;

  // Components in stacking order: support (below launch), wide, bootstrap,
  // ladder bands. Each carries its identity so the chart can colour and label.
  const comps = [];
  if (canPlaceSupport) comps.push({ kind: 'support', lo: supportLo, hi: 1, L: Lquote(supportUsd, supportLo, 1) });
  if (wideFrac > 0) comps.push({ kind: 'wide', lo: 1, hi: capX, L: Ltoken(tokenValue(wideFrac), 1, capX) });
  if (bootstrapFrac > 0) comps.push({ kind: 'bootstrap', lo: 1, hi: 1.15, L: Ltoken(tokenValue(bootstrapFrac), 1, 1.15) });
  ladderBands.forEach((b, i) => comps.push({ kind: 'ladder', index: i, lo: b.lo, hi: b.hi, L: Ltoken(tokenValue(b.frac), b.lo, b.hi) }));
  if (comps.length === 0) return null;

  const minX = canPlaceSupport ? supportLo : 1;

  // Merge into segments; each records the stacked components present.
  const edges = new Set([minX, 1, capX]);
  for (const c of comps) { edges.add(c.lo); edges.add(c.hi); }
  const xs = Array.from(edges).filter((x) => x >= minX - 1e-9 && x <= capX * 1.0001).sort((a, b) => a - b);

  const segments = [];
  let maxL = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    const lo = xs[i];
    const hi = xs[i + 1];
    if (hi <= lo) continue;
    const parts = [];
    let total = 0;
    for (const c of comps) {
      if (c.lo <= lo + 1e-9 && c.hi >= hi - 1e-9) { parts.push({ kind: c.kind, index: c.index, L: c.L }); total += c.L; }
    }
    segments.push({ loX: lo, hiX: hi, parts, total });
    if (total > maxL) maxL = total;
  }

  return {
    segments,
    minX,
    maxX: capX,
    maxL: maxL || 1,
    bands: ladderBands.map((b, i) => ({ index: i, lo: b.lo, hi: b.hi })),
    hasWide: wideFrac > 0,
    hasBootstrap: bootstrapFrac > 0,
    hasLadder: ladderBands.length > 0,
    hasSupport: canPlaceSupport,
    supportDepthPct: canPlaceSupport ? supportDepthPct : 0,
  };
}

// Render a depth profile as a self-contained inline SVG + HTML legend string.
// Each position (wide band, optional bootstrap, each ladder band) is a distinct
// colour, stacked so the total height is the real (additive) liquidity, with a
// crisp outline over the top and a legend tying colours to band numbers and
// price ranges. Returns '' when there's no ladder (nothing worth showing).
//
// opts.compact (default false) trims the chart for the simple-mode strategy
// preview: it drops the explanatory caption and shortens the legend labels.
// Customize mode and the launch report call it without compact, so they keep
// the full caption and labels.
function renderDepthChartSvg(profile, opts = {}) {
  const INK = '#1c1610';
  const compact = opts && opts.compact === true;
  if (!profile || !profile.segments || !profile.segments.length || (!profile.hasLadder && !profile.hasSupport)) return '';

  // Earthy, parchment-friendly palette. Support (buy wall, below launch) = a
  // muted green; wide baseline = tan; bootstrap = soft brown; ladder bands
  // cycle a categorical set.
  const SUPPORT = '#4f8a5a';
  const WIDE = '#d8c39a';
  const BOOTSTRAP = '#b39a72';
  const PALETTE = ['#9a2424', '#2f6f5e', '#c0871f', '#3f5a8a', '#8a3f6a', '#5f6a2a', '#7a4a2a'];
  const colorOf = (p) => p.kind === 'support' ? SUPPORT
    : (p.kind === 'wide' ? WIDE : (p.kind === 'bootstrap' ? BOOTSTRAP : PALETTE[p.index % PALETTE.length]));
  // Compact, consistent multiplier labels for the axis ticks and the legend's
  // band ranges. Bands land on log-spaced boundaries (1.56×, 3.81×, …), so we
  // keep one decimal below 10 (trailing .0 stripped) and whole numbers from 10
  // up, with k/M/B/T grouping above a thousand and scientific past 1e15 — so
  // the legend stops mixing "1.56" with "23".
  const fmtMult = (m) => {
    if (!Number.isFinite(m) || m <= 0) return '0';
    if (m >= 1e15) return m.toExponential(1).replace('e+', 'e');
    let v = m;
    let suffix = '';
    if (m >= 1e12) { v = m / 1e12; suffix = 'T'; }
    else if (m >= 1e9) { v = m / 1e9; suffix = 'B'; }
    else if (m >= 1e6) { v = m / 1e6; suffix = 'M'; }
    else if (m >= 1e3) { v = m / 1e3; suffix = 'k'; }
    const s = v < 10 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v));
    return s + suffix;
  };

  const W = 560, H = 184;
  const padL = 14, padR = 14, padT = 24, padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const x0 = padL;
  const yBase = H - padB;
  const yTopPlot = padT;

  // Log x over the full range, which can dip below 1× when support is present.
  const lmin = Math.log(profile.minX);
  const lspan = (Math.log(profile.maxX) - lmin) || 1;
  const X = (x) => x0 + ((Math.log(x) - lmin) / lspan) * plotW;
  const hAt = (L) => (L / profile.maxL) * plotH;

  // Stacked fills (bottom -> top); no per-rect stroke so same-colour neighbours
  // read as one block.
  let fills = '';
  for (const s of profile.segments) {
    const xa = X(s.loX);
    const w = X(s.hiX) - xa;
    if (w <= 0) continue;
    let cum = 0;
    for (const p of s.parts) {
      const h = hAt(p.L);
      if (h <= 0) continue;
      fills += `<rect x="${xa.toFixed(1)}" y="${(yBase - cum - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${colorOf(p)}" fill-opacity="0.92"/>`;
      cum += h;
    }
  }

  // Crisp outline along the top of the total stack.
  let d = `M ${X(profile.segments[0].loX).toFixed(1)} ${yBase.toFixed(1)}`;
  for (const s of profile.segments) {
    const y = (yBase - hAt(s.total)).toFixed(1);
    d += ` L ${X(s.loX).toFixed(1)} ${y} L ${X(s.hiX).toFixed(1)} ${y}`;
  }
  d += ` L ${X(profile.segments[profile.segments.length - 1].hiX).toFixed(1)} ${yBase.toFixed(1)}`;

  // The launch line (1×) — the divider between the support buy-wall (left) and
  // the token-side resistance (right).
  const launchX = X(1);
  // Divider line only. The "launch" wording now lives on the 1× tick label
  // below the axis ("1× launch"); the old floating word up here collided with
  // the LIQUIDITY DEPTH title, so it's gone.
  const launchMark = `<line x1="${launchX.toFixed(1)}" y1="${(yTopPlot - 2).toFixed(1)}" x2="${launchX.toFixed(1)}" y2="${yBase}" stroke="${INK}" stroke-width="0.8" stroke-dasharray="3 3" opacity="0.55"/>`;

  // x ticks. The left of the axis is anchored at the launch line with a single
  // "1× launch" label — we no longer tick the support floor (its depth is
  // already stated in the legend), which is what used to crowd the near-1×
  // region. Powers of ten fill in above launch; the ends always get a tick;
  // anything that would collide is dropped.
  const candidatesSet = new Set([1, profile.maxX]);
  for (let p = 1; p <= profile.maxX * 1.0001; p *= 10) candidatesSet.add(p);
  const candidates = Array.from(candidatesSet).filter((t) => t >= 1 && t <= profile.maxX * 1.0001).sort((a, b) => a - b);
  const ticks = [];
  let lastX = -Infinity;
  candidates.forEach((t, i) => {
    const xx = X(t);
    const isEnd = i === 0 || i === candidates.length - 1;
    if (isEnd || xx - lastX >= 44) { ticks.push(t); lastX = xx; }
  });
  const tickMarks = ticks.map((t) => {
    const x = X(t);
    const isLaunch = Math.abs(t - 1) < 1e-9;
    const label = isLaunch ? '1× launch' : `${fmtMult(t)}×`;
    // Launch label starts at the line (not centered) so it doesn't clip the
    // left edge — X(1) sits close to x0 when a support wall pushes minX < 1×.
    const anchor = isLaunch ? 'start' : (x >= x0 + plotW - 2 ? 'end' : 'middle');
    return `<line x1="${x.toFixed(1)}" y1="${yBase}" x2="${x.toFixed(1)}" y2="${(yBase + 4).toFixed(1)}" stroke="${INK}" stroke-width="0.75" opacity="0.45"/>`
      + `<text x="${x.toFixed(1)}" y="${(yBase + 16).toFixed(1)}" text-anchor="${anchor}" font-family="'JetBrains Mono',monospace" font-size="10" fill="${INK}" opacity="0.7">${label}</text>`;
  }).join('');

  const svg = `
<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Stacked liquidity depth across price: a support buy wall below launch, then the wide band and ladder bands stacked above launch.">
  ${fills}
  ${launchMark}
  <path d="${d}" fill="none" stroke="${INK}" stroke-width="1.1" stroke-linejoin="round" opacity="0.85"/>
  <line x1="${x0}" y1="${yBase}" x2="${(x0 + plotW).toFixed(1)}" y2="${yBase}" stroke="${INK}" stroke-width="0.9" opacity="0.65"/>
  <text x="${x0}" y="14" font-family="'JetBrains Mono',monospace" font-size="10" letter-spacing="0.5" fill="${INK}" opacity="0.75">LIQUIDITY DEPTH</text>
  <text x="${(x0 + plotW).toFixed(1)}" y="14" text-anchor="end" font-family="'JetBrains Mono',monospace" font-size="10" fill="${INK}" opacity="0.5">price × launch &#8594;</text>
  ${tickMarks}
</svg>`;

  // HTML legend.
  const swatch = (c) => `<span style="display:inline-block;width:11px;height:11px;background:${c};border:0.5px solid rgba(28,22,16,0.35);border-radius:2px;vertical-align:-1px;margin-right:5px;"></span>`;
  const items = [];
  if (profile.hasSupport) {
    const supportLabel = compact
      ? 'Support'
      : `Support &middot; buy wall to &minus;${Math.round(profile.supportDepthPct)}%`;
    items.push(`<span style="white-space:nowrap;">${swatch(SUPPORT)}${supportLabel}</span>`);
  }
  if (profile.hasWide) items.push(`<span style="white-space:nowrap;">${swatch(WIDE)}Wide band</span>`);
  if (profile.hasBootstrap) items.push(`<span style="white-space:nowrap;">${swatch(BOOTSTRAP)}Bootstrap</span>`);
  for (const b of profile.bands) {
    // Bare band number — the swatch colour and the "1× launch / 10× / …" axis
    // already make clear these are the ladder bands; the "Band" prefix was
    // just noise.
    items.push(`<span style="white-space:nowrap;">${swatch(PALETTE[b.index % PALETTE.length])}${b.index + 1}</span>`);
  }
  const legend = `<div style="display:flex;flex-wrap:wrap;gap:5px 14px;margin-top:7px;font-family:'JetBrains Mono',monospace;font-size:11px;color:${INK};opacity:0.9;">${items.join('')}</div>`;
  const caption = `<p style="margin:6px 0 0;font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.4;color:${INK};opacity:0.6;">Each colour is one position. Height is <em>liquidity depth</em> &mdash; how hard it is to move price through that range (taller = price moves slower), <em>not</em> dollar value, market cap, or token count. Depth is constant across a position's range, so each block is flat; the same supply sits deeper when placed higher or in a tighter range. Left of <em>launch</em> is the support buy wall; right of it is token-side resistance.</p>`;

  // Compact (simple-mode preview) drops the caption; the full explanation
  // lives in customize mode where there's room for it.
  return `<div style="width:100%;">${svg}${legend}${compact ? '' : caption}</div>`;
}
