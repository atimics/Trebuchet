// Vortex allocation control.
//
// The Navier-Stokes result describes a vortex that spirals inward, stretches
// along its axis, and whose core shrinks while speeding up — with the total
// energy staying finite the whole time, because the large terms cancel.
//
// That is exactly the shape of a flywheel launch, so this control is built as
// one:
//
//   core (small radius, fastest spin)  -> the flywheel pairing (memecoin pool)
//   middle bands                       -> quote pools feeding the core
//   outer band                         -> the SOL market, the inflow
//   band thickness                     -> share of supply
//   spin speed / colour                -> fee tier (orange fast, teal slow)
//   axial stretch                      -> price-ladder bands
//   the sink at the axis               -> the sweep destination
//   constant total deposit             -> energy stays finite while you drag
//
// Dragging a boundary between two bands moves supply between them, so the
// allocation is a continuous motion instead of typing numbers into boxes. The
// control is presentation only: it writes the same percentages the rest of the
// app already consumes, so planning stays deterministic.
//
// Loaded as a classic script; exposes window.TrebuchetV2Vortex. The pure math
// is exercised by test/vortex-control.test.mjs in a VM sandbox.

(function initVortexControl(global) {
  'use strict';

  const TAU = Math.PI * 2;
  const VIEW = 320;
  const CENTER = VIEW / 2;
  const MAX_RADIUS = 132;
  const MIN_RADIUS = 26;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function roundPercent(value) {
    return Math.round(value * 10) / 10;
  }

  /**
   * Turn pool shares into concentric bands, outermost first. Thickness is
   * proportional to share, so the biggest market is the widest ring and the
   * flywheel is the thin, fast core.
   */
  function layoutBands(pools = [], { minRadius = MIN_RADIUS, maxRadius = MAX_RADIUS, minThickness = 10 } = {}) {
    // Zero-share bands are kept so they still have a boundary to drag: the
    // vortex is how you open a pool in the first place, so a pool at 0% must
    // be visible as a thin ring rather than absent.
    const usable = pools.filter((pool) => pool && pool.id);
    const total = usable.reduce((sum, pool) => sum + Math.max(0, Number(pool.percent) || 0), 0) || 100;
    const span = maxRadius - minRadius;
    const raw = usable.map((pool) => Math.max(minThickness, (Math.max(0, Number(pool.percent)) / total) * span));
    const rawSum = raw.reduce((sum, value) => sum + value, 0) || 1;
    const scale = span / rawSum;
    let cursor = maxRadius;
    return usable.map((pool, index) => {
      const thickness = raw[index] * scale;
      const rOuter = cursor;
      const rInner = Math.max(minRadius, cursor - thickness);
      cursor = rInner;
      return { ...pool, rOuter, rInner, midRadius: (rOuter + rInner) / 2 };
    });
  }

  /**
   * Move `delta` points of share across the boundary between band `index` and
   * `index + 1`, honouring each band's min/max. Returns new percentages keyed
   * by pool id (always summing to the original total).
   */
  function transferShare(pools, index, delta) {
    const next = pools.map((pool) => ({ ...pool, percent: Number(pool.percent) }));
    const left = next[index];
    const right = next[index + 1];
    if (!left || !right) return next;
    const leftMin = Number.isFinite(left.minPercent) ? left.minPercent : 0;
    const rightMin = Number.isFinite(right.minPercent) ? right.minPercent : 0;
    const leftMax = Number.isFinite(left.maxPercent) ? left.maxPercent : Infinity;
    const rightMax = Number.isFinite(right.maxPercent) ? right.maxPercent : Infinity;

    // Positive delta grows the left band (outward) and shrinks the right.
    const maxGrow = Math.min(leftMax - left.percent, right.percent - rightMin);
    const maxShrink = Math.min(left.percent - leftMin, rightMax - right.percent);
    const applied = delta >= 0 ? Math.min(delta, Math.max(0, maxGrow)) : Math.max(delta, -Math.max(0, maxShrink));
    left.percent = roundPercent(left.percent + applied);
    right.percent = roundPercent(right.percent - applied);
    return next;
  }

  /** Fee tier -> angular speed for the animation and band colour. */
  function spinForFeeTier(feeTier) {
    const tier = Number(feeTier);
    if (!Number.isFinite(tier)) return { speed: 1, color: '#4fd1c5' };
    // Higher tier index = tighter fee tier in the Raydium config set.
    if (tier <= 3) return { speed: 1.6, color: '#f6ad55' };
    if (tier <= 5) return { speed: 1.2, color: '#ed8936' };
    return { speed: 0.9, color: '#4fd1c5' };
  }

  function arcPath(cx, cy, rInner, rOuter, from, to) {
    const p = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const [x1, y1] = p(rOuter, from);
    const [x2, y2] = p(rOuter, to);
    const [x3, y3] = p(rInner, to);
    const [x4, y4] = p(rInner, from);
    const large = to - from > Math.PI ? 1 : 0;
    return [
      `M ${x1.toFixed(2)} ${y1.toFixed(2)}`,
      `A ${rOuter} ${rOuter} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
      `L ${x3.toFixed(2)} ${y3.toFixed(2)}`,
      `A ${rInner} ${rInner} 0 ${large} 0 ${x4.toFixed(2)} ${y4.toFixed(2)}`,
      'Z',
    ].join(' ');
  }

  function spiralPath(cx, cy, inner, outer, turns = 3.2, steps = 160) {
    const points = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const r = inner + (outer - inner) * t;
      const a = t * turns * TAU;
      points.push(`${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`);
    }
    return `M ${points.join(' L ')}`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  /**
   * Mount the control. `read()` returns
   *   { pools: [{ id, symbol, percent, minPercent?, maxPercent?, feeTier? }],
   *     depositSol?: number, sweepDestination?: string }
   * and `write(pools)` receives the updated percentages.
   */
  function mount(host, { read, write } = {}) {
    if (!host || typeof read !== 'function') return null;
    let dragging = null;

    const render = () => {
      const model = read() || {};
      const pools = Array.isArray(model.pools) ? model.pools : [];
      const bands = layoutBands(pools);
      const deposit = Number(model.depositSol);
      const core = bands[bands.length - 1] || null;

      const bandMarkup = bands.map((band, index) => {
        const { speed, color } = spinForFeeTier(band.feeTier);
        const start = -Math.PI / 2 + (index % 2 ? 0.25 : 0);
        const end = start + TAU - 0.12;
        return `<path class="vortex-band" data-band="${index}" d="${arcPath(CENTER, CENTER, band.rInner, band.rOuter, start, end)}"
          fill="${color}" fill-opacity="${0.10 + Math.min(0.28, Number(band.percent) / 260)}"
          stroke="${color}" stroke-opacity="0.5" stroke-width="1">
          <title>${escapeHtml(band.symbol)} · ${band.percent}%</title>
        </path>
        <text class="vortex-band-label" x="${CENTER + band.midRadius + 6}" y="${CENTER - 4}" fill="${color}">
          ${escapeHtml(band.symbol)} ${band.percent}%
        </text>`;
      }).join('');

      const handles = bands.slice(0, -1).map((band, index) => {
        const angle = -Math.PI / 2 + 0.18;
        const x = CENTER + band.rInner * Math.cos(angle);
        const y = CENTER + band.rInner * Math.sin(angle);
        return `<circle class="vortex-handle" data-boundary="${index}" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="7"
          role="slider" tabindex="0" aria-label="Adjust ${escapeHtml(band.symbol)} share"
          data-value="${band.percent}"><title>Drag to move supply between bands</title></circle>`;
      }).join('');

      host.innerHTML = `
        <div class="vortex-head">
          <span class="eyebrow">Flywheel vortex</span>
          <strong>${core ? `${escapeHtml(core.symbol)} core at ${core.percent}%` : 'No pools configured'}</strong>
        </div>
        <svg class="vortex-svg" viewBox="0 0 ${VIEW} ${VIEW}" role="img"
             aria-label="Pool allocation vortex: ${bands.map((b) => `${b.symbol} ${b.percent}%`).join(', ')}">
          <defs>
            <radialGradient id="vortexCore" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stop-color="#fff" stop-opacity="0.9"></stop>
              <stop offset="100%" stop-color="#f6ad55" stop-opacity="0.2"></stop>
            </radialGradient>
          </defs>
          ${bandMarkup}
          <path class="vortex-spiral" d="${spiralPath(CENTER, CENTER, MIN_RADIUS * 0.4, MAX_RADIUS, core ? 3.4 : 1.2)}"
                fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="1" stroke-dasharray="4 6"></path>
          <circle cx="${CENTER}" cy="${CENTER}" r="${MIN_RADIUS * 0.55}" fill="url(#vortexCore)"></circle>
          <text class="vortex-sink" x="${CENTER}" y="${CENTER + 4}" text-anchor="middle" fill="#1a202c" font-size="9">sink</text>
          ${handles}
        </svg>
        <div class="vortex-readout">
          <span><small>Deposit</small><strong>${Number.isFinite(deposit) ? `${deposit.toFixed(3)} SOL` : '—'}</strong></span>
          <span><small>Bands</small><strong>${bands.length}</strong></span>
          <span><small>Total</small><strong>${bands.reduce((sum, b) => sum + b.percent, 0).toFixed(1)}%</strong></span>
        </div>
        <p class="vortex-hint">Drag a boundary to move supply between rings. The core spins fastest; total deposit stays finite.</p>
      `;
      bindPointer();
    };

    const poolState = () => {
      const model = read() || {};
      return Array.isArray(model.pools) ? model.pools : [];
    };

    const applyDelta = (boundaryIndex, delta) => {
      const pools = poolState();
      const next = transferShare(pools, boundaryIndex, delta);
      if (typeof write === 'function') write(next);
      render();
    };

    function bindPointer() {
      const svg = host.querySelector('.vortex-svg');
      if (!svg) return;
      const pointerAngleRadius = (event) => {
        const rect = svg.getBoundingClientRect();
        const scale = VIEW / rect.width;
        const x = (event.clientX - rect.left) * scale - CENTER;
        const y = (event.clientY - rect.top) * scale - CENTER;
        return { radius: Math.hypot(x, y), angle: Math.atan2(y, x) };
      };
      const onMove = (event) => {
        if (!dragging) return;
        const { radius } = pointerAngleRadius(event);
        const bands = layoutBands(poolState());
        const boundary = bands[dragging.index];
        if (!boundary) return;
        // Moving the boundary outward expands the ring inside it and shrinks
        // the ring outside it (supply flows toward the core).
        const span = MAX_RADIUS - MIN_RADIUS;
        const outward = ((radius - dragging.radius) / span) * 100;
        if (Math.abs(outward) < 0.5) return;
        dragging.radius = radius;
        applyDelta(dragging.index, -outward);
      };
      const stop = () => {
        dragging = null;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', stop);
      };
      svg.querySelectorAll('.vortex-handle').forEach((handle) => {
        handle.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          dragging = {
            index: Number(handle.dataset.boundary),
            radius: pointerAngleRadius(event).radius,
          };
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', stop);
        });
        handle.addEventListener('keydown', (event) => {
          const index = Number(handle.dataset.boundary);
          if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
            event.preventDefault();
            applyDelta(index, 1);
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
            event.preventDefault();
            applyDelta(index, -1);
          }
        });
      });
    }

    render();
    return { render };
  }

  global.TrebuchetV2Vortex = {
    layoutBands,
    transferShare,
    spinForFeeTier,
    arcPath,
    spiralPath,
    mount,
    constants: { VIEW, CENTER, MAX_RADIUS, MIN_RADIUS },
  };
}(typeof window !== 'undefined' ? window : globalThis));
