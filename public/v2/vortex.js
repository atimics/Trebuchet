// Vortex allocation control — 3D funnel edition.
//
// Informed by the Navier-Stokes result: a vortex that spirals inward and
// stretches along its axis while its core shrinks, speeds up, and keeps total
// energy finite. The control is that vortex, seen in perspective:
//
//   wide mouth (top)      -> the SOL market, the inflow
//   inner rings           -> quote pools
//   narrow throat         -> the flywheel pairing, the fast core
//   ring span             -> share of supply
//   colour / spin speed   -> fee tier (orange fast, teal slow)
//   helix inside          -> the circulating flow
//   "sink" at the throat  -> the sweep destination
//   constant deposit      -> energy stays finite while you drag
//
// Rendering is an isometric funnel: each band is a frustum slice drawn with
// elliptical caps (back rim darker, front rim lighter) so depth reads without
// a CSS 3D transform. That matters for input — the pointer is mapped straight
// into viewBox coordinates, so dragging is exact rather than approximated
// through a projected transform.
//
// Dragging is direct manipulation: a boundary follows the pointer along the
// funnel axis, so the ring you grab moves with the cursor instead of jumping
// by a percentage per pixel.
//
// Loaded as a classic script; exposes window.TrebuchetV2Vortex. Pure geometry
// and share math are exercised by test/vortex-control.test.mjs in a VM sandbox.

(function initVortexControl(global) {
  'use strict';

  const TAU = Math.PI * 2;
  const VIEW = 360;
  const AXIS_X = VIEW / 2;
  const Y_TOP = 58;
  const Y_BOTTOM = 322;
  const R_TOP = 118;
  const R_BOTTOM = 30;
  const PERSPECTIVE = 0.38; // ellipse squash: how much the funnel is tilted away
  const MIN_VISUAL_SPAN = 0.045; // zero-share rings still need to be grabbable

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function roundPercent(value) {
    return Math.round(value * 10) / 10;
  }

  const yForT = (t) => Y_TOP + clamp(t, 0, 1) * (Y_BOTTOM - Y_TOP);
  const tForY = (y) => clamp((y - Y_TOP) / (Y_BOTTOM - Y_TOP), 0, 1);
  const radiusForT = (t) => R_TOP + (R_BOTTOM - R_TOP) * clamp(t, 0, 1);

  /**
   * Lay the pools out down the funnel, widest first. Each band gets the t
   * range it occupies, its vertical extent, and its rim radii, so both the
   * renderer and the drag handler work from one geometry.
   *
   * Zero-share bands are kept (with a minimum visual span) so there is always
   * a boundary to grab: the vortex is how a pool gets opened in the first
   * place.
   */
  function layoutBands(pools = []) {
    const usable = pools.filter((pool) => pool && pool.id);
    const total = usable.reduce((sum, pool) => sum + Math.max(0, Number(pool.percent) || 0), 0);
    const shares = usable.map((pool) => (
      total > 0 ? Math.max(0, Number(pool.percent) || 0) / total : 0
    ));
    // Purely visual minimum so 0% rings stay visible and draggable.
    const visualShares = shares.map((share) => Math.max(share, MIN_VISUAL_SPAN));
    const visualTotal = visualShares.reduce((sum, value) => sum + value, 0) || 1;

    let t = 0;
    return usable.map((pool, index) => {
      const realShare = shares[index];
      const visual = visualShares[index] / visualTotal;
      const tTop = t;
      const tBottom = index === usable.length - 1 ? 1 : Math.min(1, t + visual);
      t = tBottom;
      const yTop = yForT(tTop);
      const yBottom = yForT(tBottom);
      return {
        ...pool,
        share: realShare,
        tTop,
        tBottom,
        yTop,
        yBottom,
        rTop: radiusForT(tTop),
        rBottom: radiusForT(tBottom),
        midY: (yTop + yBottom) / 2,
        midRadius: (radiusForT(tTop) + radiusForT(tBottom)) / 2,
      };
    });
  }

  /**
   * Move `delta` points of share across the boundary between band `index` and
   * `index + 1`, honouring each band's min/max. Positive grows the upper band.
   */
  function transferShare(pools, index, delta) {
    const next = pools.map((pool) => ({ ...pool, percent: Number(pool.percent) }));
    const upper = next[index];
    const lower = next[index + 1];
    if (!upper || !lower) return next;
    const upperMin = Number.isFinite(upper.minPercent) ? upper.minPercent : 0;
    const lowerMin = Number.isFinite(lower.minPercent) ? lower.minPercent : 0;
    const upperMax = Number.isFinite(upper.maxPercent) ? upper.maxPercent : Infinity;
    const lowerMax = Number.isFinite(lower.maxPercent) ? lower.maxPercent : Infinity;

    const maxGrow = Math.min(upperMax - upper.percent, lower.percent - lowerMin);
    const maxShrink = Math.min(upper.percent - upperMin, lowerMax - lower.percent);
    const applied = delta >= 0
      ? Math.min(delta, Math.max(0, maxGrow))
      : Math.max(delta, -Math.max(0, maxShrink));
    upper.percent = roundPercent(upper.percent + applied);
    lower.percent = roundPercent(lower.percent - applied);
    return next;
  }

  /**
   * How much the UPPER band must gain for the boundary to sit at `t`.
   *
   * The boundary between band `index` and everything below it sits at `t`
   * (0 at the mouth, 1 at the throat). The supply below it must equal the
   * remaining share `(1 - t) * 100`, so the upper band gains exactly the
   * difference between what those bands hold now and what they should hold.
   *
   * Sign matches transferShare: positive grows the upper band, which is what
   * dragging a ring *down* the funnel means (the mouth takes more supply).
   */
  function boundaryDeltaForUpper(pools, index, t) {
    const bands = layoutBands(pools);
    const below = bands.slice(index + 1);
    if (!below.length) return 0;
    const currentInner = below.reduce((sum, band) => sum + Math.max(0, Number(band.percent) || 0), 0);
    const desiredInner = (1 - clamp(t, 0, 1)) * 100;
    return currentInner - desiredInner;
  }

  /** Fee tier -> spin speed and band colour. */
  function spinForFeeTier(feeTier) {
    const tier = Number(feeTier);
    if (!Number.isFinite(tier)) return { speed: 1, color: '#4fd1c5' };
    if (tier <= 3) return { speed: 1.6, color: '#f6ad55' };
    if (tier <= 5) return { speed: 1.2, color: '#ed8936' };
    return { speed: 0.9, color: '#4fd1c5' };
  }

  /** Front half of the ellipse rim at (y) with radius r. */
  function frontArc(r, y) {
    const ry = r * PERSPECTIVE;
    return `M ${(AXIS_X - r).toFixed(2)} ${y.toFixed(2)} A ${r.toFixed(2)} ${ry.toFixed(2)} 0 0 0 ${(AXIS_X + r).toFixed(2)} ${y.toFixed(2)}`;
  }

  /** Back half of the ellipse rim at (y) with radius r (the far rim). */
  function backArc(r, y) {
    const ry = r * PERSPECTIVE;
    return `M ${(AXIS_X - r).toFixed(2)} ${y.toFixed(2)} A ${r.toFixed(2)} ${ry.toFixed(2)} 0 0 1 ${(AXIS_X + r).toFixed(2)} ${y.toFixed(2)}`;
  }

  /** One frustum slice: the visible surface of a band between two rims. */
  function funnelPath(band) {
    const { rTop, rBottom, yTop, yBottom } = band;
    const ryTop = rTop * PERSPECTIVE;
    const ryBottom = rBottom * PERSPECTIVE;
    return [
      `M ${(AXIS_X - rTop).toFixed(2)} ${yTop.toFixed(2)}`,
      `A ${rTop.toFixed(2)} ${ryTop.toFixed(2)} 0 0 0 ${(AXIS_X + rTop).toFixed(2)} ${yTop.toFixed(2)}`,
      `L ${(AXIS_X + rBottom).toFixed(2)} ${yBottom.toFixed(2)}`,
      `A ${rBottom.toFixed(2)} ${ryBottom.toFixed(2)} 0 0 1 ${(AXIS_X - rBottom).toFixed(2)} ${yBottom.toFixed(2)}`,
      'Z',
    ].join(' ');
  }

  /** The helix inside the funnel: radius shrinks toward the throat. */
  function helixPath(turns = 3.4, steps = 180) {
    const points = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const r = radiusForT(t) * 0.92;
      const angle = t * turns * TAU - Math.PI / 2;
      const x = AXIS_X + r * Math.cos(angle);
      const y = yForT(t) + r * PERSPECTIVE * 0.6 * Math.sin(angle);
      points.push(`${x.toFixed(2)} ${y.toFixed(2)}`);
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
    let drag = null;

    const poolState = () => {
      const model = read() || {};
      return Array.isArray(model.pools) ? model.pools : [];
    };

    const render = () => {
      const model = read() || {};
      const pools = Array.isArray(model.pools) ? model.pools : [];
      const bands = layoutBands(pools);
      const deposit = Number(model.depositSol);
      const core = bands[bands.length - 1] || null;
      const total = bands.reduce((sum, band) => sum + Math.max(0, Number(band.percent) || 0), 0);

      const bandMarkup = bands.map((band, index) => {
        const { color } = spinForFeeTier(band.feeTier);
        const opacity = 0.16 + Math.min(0.34, (Number(band.percent) || 0) / 220);
        const next = bands[index + 1];
        return `
          <g class="vortex-band" data-band="${index}">
            <path class="vortex-slice" d="${funnelPath(band)}"
                  fill="url(#vortexBand${index % 3})" fill-opacity="${opacity.toFixed(2)}"
                  stroke="${color}" stroke-opacity="0.45" stroke-width="1"></path>
            <path class="vortex-rim vortex-rim-back" d="${backArc(band.rTop, band.yTop)}"
                  fill="none" stroke="${color}" stroke-opacity="0.25" stroke-width="1"></path>
            <path class="vortex-rim vortex-rim-front" d="${frontArc(band.rBottom, band.yBottom)}"
                  fill="none" stroke="${color}" stroke-opacity="0.55" stroke-width="1.25"></path>
            <text class="vortex-band-label" x="${(AXIS_X + band.midRadius + 8).toFixed(2)}"
                  y="${band.midY.toFixed(2)}" fill="${color}">
              ${escapeHtml(band.symbol)} ${band.percent}%
            </text>
          </g>`;
      }).join('');

      const handles = bands.slice(0, -1).map((band, index) => {
        const y = band.yBottom;
        const r = band.rBottom;
        return `
          <g class="vortex-boundary" data-boundary="${index}" role="slider" tabindex="0"
             aria-label="Adjust the boundary between ${escapeHtml(band.symbol)} and ${escapeHtml(bands[index + 1]?.symbol || 'the core')}"
             aria-valuenow="${band.percent}" aria-valuemin="0" aria-valuemax="100">
            <ellipse class="vortex-handle-ring" cx="${AXIS_X}" cy="${y.toFixed(2)}"
                     rx="${r.toFixed(2)}" ry="${(r * PERSPECTIVE).toFixed(2)}"></ellipse>
            <circle class="vortex-handle" cx="${AXIS_X}" cy="${(y + r * PERSPECTIVE).toFixed(2)}" r="8"></circle>
          </g>`;
      }).join('');

      host.innerHTML = `
        <div class="vortex-head">
          <span class="eyebrow">Flywheel vortex</span>
          <strong>${core ? `${escapeHtml(core.symbol)} core at ${core.percent}%` : 'No pools configured'}</strong>
        </div>
        <div class="vortex-stage">
          <svg class="vortex-svg" viewBox="0 0 ${VIEW} ${VIEW}" role="img"
               aria-label="Pool allocation funnel: ${bands.map((b) => `${b.symbol} ${b.percent}%`).join(', ')}">
            <defs>
              <linearGradient id="vortexBand0" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#4fd1c5"></stop>
                <stop offset="100%" stop-color="#2c7a7b"></stop>
              </linearGradient>
              <linearGradient id="vortexBand1" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#f6ad55"></stop>
                <stop offset="100%" stop-color="#c05621"></stop>
              </linearGradient>
              <linearGradient id="vortexBand2" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#e2e8f0"></stop>
                <stop offset="100%" stop-color="#718096"></stop>
              </linearGradient>
              <radialGradient id="vortexThroat" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="#ffffff" stop-opacity="0.95"></stop>
                <stop offset="100%" stop-color="#f6ad55" stop-opacity="0.15"></stop>
              </radialGradient>
            </defs>
            <ellipse class="vortex-mouth" cx="${AXIS_X}" cy="${Y_TOP}" rx="${R_TOP}" ry="${(R_TOP * PERSPECTIVE).toFixed(2)}"
                     fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="1"></ellipse>
            ${bandMarkup}
            <path class="vortex-helix" d="${helixPath()}" fill="none"
                  stroke="rgba(255,255,255,0.42)" stroke-width="1.1" stroke-dasharray="5 7"></path>
            <ellipse cx="${AXIS_X}" cy="${Y_BOTTOM}" rx="${R_BOTTOM * 0.72}" ry="${(R_BOTTOM * 0.72 * PERSPECTIVE).toFixed(2)}"
                     fill="url(#vortexThroat)"></ellipse>
            <text class="vortex-sink" x="${AXIS_X}" y="${(Y_BOTTOM + 3).toFixed(2)}" text-anchor="middle"
                  fill="#1a202c" font-size="8.5">sink</text>
            ${handles}
            <text class="vortex-inflow" x="${AXIS_X}" y="${(Y_TOP - 10).toFixed(2)}" text-anchor="middle"
                  fill="rgba(255,255,255,0.55)" font-size="9">inflow</text>
          </svg>
        </div>
        <div class="vortex-readout">
          <span><small>Deposit</small><strong>${Number.isFinite(deposit) ? `${deposit.toFixed(3)} SOL` : '—'}</strong></span>
          <span><small>Bands</small><strong>${bands.length}</strong></span>
          <span><small>Total</small><strong>${total.toFixed(1)}%</strong></span>
        </div>
        <p class="vortex-hint">Drag a ring down the funnel to send supply into the core. The throat spins fastest; total deposit stays finite.</p>
      `;
      bindPointer();
    };

    const applyDelta = (boundaryIndex, delta) => {
      if (!Number.isFinite(delta) || Math.abs(delta) < 0.05) return;
      const next = transferShare(poolState(), boundaryIndex, delta);
      if (typeof write === 'function') write(next);
      render();
    };

    function bindPointer() {
      if (!host.querySelector('.vortex-svg')) return;

      // Pointer -> viewBox coordinates. The control is drawn in the SVG plane
      // (no CSS 3D transform), so this mapping is exact.
      //
      // The SVG is re-queried on every call on purpose: each update re-renders
      // the control, which replaces the SVG element. Measuring a detached
      // element returns a zero-size rect, which used to map every later pointer
      // position to the same edge of the funnel and made the drag snap back.
      const pointFor = (event) => {
        const live = host.querySelector('.vortex-svg');
        if (!live) return null;
        const rect = live.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return {
          x: (event.clientX - rect.left) * (VIEW / rect.width),
          y: (event.clientY - rect.top) * (VIEW / rect.height),
        };
      };

      // Direct manipulation: the ring follows the pointer down the funnel, so
      // supply flows into the core at the speed the operator drags rather than
      // jumping by a percentage per pixel. Updates are coalesced to one per
      // animation frame so a fast drag stays smooth.
      let frame = null;
      let pendingPoint = null;
      const flush = () => {
        frame = null;
        if (!drag || !pendingPoint) return;
        const point = pendingPoint;
        pendingPoint = null;
        const delta = boundaryDeltaForUpper(poolState(), drag.index, tForY(point.y));
        if (Math.abs(delta) < 0.05) return;
        applyDelta(drag.index, delta);
      };

      const onMove = (event) => {
        if (!drag) return;
        const point = pointFor(event);
        if (!point) return;
        pendingPoint = point;
        if (frame == null) frame = global.requestAnimationFrame(flush);
      };

      const stop = () => {
        drag = null;
        pendingPoint = null;
        if (frame != null && global.cancelAnimationFrame) global.cancelAnimationFrame(frame);
        frame = null;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
      };

      host.querySelectorAll('.vortex-boundary').forEach((handle) => {
        handle.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          drag = { index: Number(handle.dataset.boundary) };
          if (handle.setPointerCapture) {
            try { handle.setPointerCapture(event.pointerId); } catch { /* ignore */ }
          }
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', stop);
          window.addEventListener('pointercancel', stop);
        });
        handle.addEventListener('keydown', (event) => {
          const index = Number(handle.dataset.boundary);
          if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
            event.preventDefault();
            applyDelta(index, 1);
          } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
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
    boundaryDeltaForUpper,
    spinForFeeTier,
    funnelPath,
    helixPath,
    yForT,
    tForY,
    radiusForT,
    mount,
    constants: { VIEW, AXIS_X, Y_TOP, Y_BOTTOM, R_TOP, R_BOTTOM, PERSPECTIVE },
  };
}(typeof window !== 'undefined' ? window : globalThis));
