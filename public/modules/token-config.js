function addPool(initial = {}) {
  // Default supplyPercent to whatever's left of the 100% budget so we never
  // create a new pool that pushes the total over 100. Callers that pass an
  // explicit supplyPercent (wallet-generation passes 100, future presets
  // will pass their own) bypass this default unchanged. If the budget is
  // already full the new pool comes up at 0% and the validation surfaces a
  // "set an allocation" hint inline.
  const sumExisting = pools.reduce((s, p) => s + (Number(p.supplyPercent) || 0), 0);
  const defaultPct = Math.max(0, 100 - sumExisting);
  pools.push({
    quoteToken: initial.quoteToken || 'SOL',
    supplyPercent: initial.supplyPercent ?? defaultPct,
    ammConfigIndex: 3,
    quoteUsdOverride: null,
    quoteDecimalsOverride: null,
    quoteSymbolOverride: null,
    resolvedSymbol: null,
    resolvedDecimals: null,
    resolvedPriceUsd: null,
    resolvedMint: null,
    // Optional display-only fields populated by /api/quote-token-info.
    // Either may be null if no indexer (Gecko, DexScreener) had the
    // token — the UI just hides the logo or falls back to the symbol.
    resolvedName: null,
    resolvedImageUrl: null,
    // Raydium CLMM compatibility info, set by resolvePoolQuote():
    //   resolvedCompatible: true | false | null (null = couldn't check)
    //   resolvedIsToken2022: bool — true when the mint is owned by the
    //                        Token-2022 program (vs the classic SPL Token
    //                        program). Token-2022 mints with allowlisted
    //                        extensions are still compatible.
    //   resolvedDisallowedNames: [string] — friendly names of any Token-2022
    //                        extensions this mint has that Raydium CLMM
    //                        doesn't accept. Empty when compatible.
    //   resolvedCompatError: string | null — populated when the on-chain
    //                        check failed (RPC issue / mint missing).
    resolvedCompatible: null,
    resolvedIsToken2022: false,
    resolvedDisallowedNames: [],
    resolvedCompatError: null,
    // Initial distribution. Defaults to a single 100% slice (one
    // position, one Fee Key NFT). The simple-config "Split the LP"
    // toggle passes a multi-slice distribution here for users who
    // want N positions, each minting its own transferable NFT.
    distribution: initial.distribution || [
      { sharePercent: 100, recipient: null, useExternalRecipient: false },
    ],
    // Per-pool bootstrap configuration.
    //   { mode: 'minimal' } — 1-whole-token reserve, narrow tick range
    //   { mode: 'custom', solValue: N, supplyPercent: M } — user-funded
    //
    // Under "user thinks in SOL" semantics, solValue is the canonical
    // input — the absolute SOL value of starting liquidity the user
    // wants on this pool. supplyPercent is DERIVED from solValue,
    // pool.supplyPercent, the target market cap, and the SOL/USD price.
    // It's recomputed any time those inputs change (the user types SOL,
    // the target mcap input is edited, the SOL price resolves), and
    // the wide slices auto-rebalance to absorb the delta so positions
    // total stays at 100%.
    //
    // supplyPercent is stored alongside solValue (rather than recomputed
    // every read) so the positions-total indicator and the wire-format
    // conversion don't have to redo the derivation logic on every paint.
    // Whenever solValue or any input it depends on changes, we call
    // recomputePoolBootstrapAndRebalance() to refresh supplyPercent and
    // rebalance slices in one shot.
    bootstrapConfig: initial.bootstrapConfig || { mode: 'minimal' },
    // Per-pool ladder configuration.
    //   { mode: 'off' } — no ladder positions
    //   { mode: 'manual', bands: [...] } — explicit list of bands
    // Each band: { supplyPercent, lowerMultiplier, upperMultiplier }
    // where multipliers are relative to launch price (e.g., 1.5–2.5 =
    // a band spanning 1.5× to 2.5× of launch price). The simple-UI
    // ladder toggle populates manual-mode bands using the log-spaced
    // preset; customize mode lets the user edit, add, or remove
    // individual bands. The wire format the backend receives is
    // always 'off' or 'manual' from the trebuchet frontend; the
    // backend's older 'simple' mode is preserved for direct API
    // users (scripts) but unused here.
    ladderConfig: initial.ladderConfig || { mode: 'off', bands: [] },
    // UI-only: whether this pool's body is expanded in the editor. Set
    // by initialIsExpanded() at construction; the user can flip it via
    // the header click or via auto-expansion when the pool needs
    // attention. Buildmode/render code never reads this on a collapsed
    // pool, since collapsed pools only render the header strip.
    _isExpanded: initial._isExpanded ?? false,
  });
  renderPools();
  resolvePoolQuote(pools.length - 1);
}

function removePool(idx) {
  pools.splice(idx, 1);
  renderPools();
  updateContinueToFundingState();
}

// Add a slice to a pool's distribution. Splits the last existing slice
// in half so the total wide allocation doesn't change — the user is
// subdividing for ownership splitting, not reallocating supply. The
// new slice arrives with no recipient set; user can wire one up via
// "Send to a different wallet" checkbox in the row.
function addSlice(poolIdx) {
  const p = pools[poolIdx];
  // Adding a slice always splits the LAST existing slice in half.
  // This keeps the positions total invariant — the wide bucket's
  // size doesn't change, we just subdivide it further for ownership
  // splitting.
  //
  // If there are no existing slices (edge case — distribution was
  // emptied), seed with what's left of the wide bucket after bs +
  // bands. Should never happen in practice since addPool seeds one
  // slice, but we guard so a corrupt state can still recover.
  if (p.distribution.length === 0) {
    const bsPct = (p.bootstrapConfig?.mode === 'custom')
      ? Number(p.bootstrapConfig.supplyPercent) || 0 : 0;
    const bandsPct = (p.ladderConfig?.mode === 'manual' && Array.isArray(p.ladderConfig.bands))
      ? p.ladderConfig.bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0) : 0;
    const widePct = Math.max(0, 100 - bsPct - bandsPct);
    p.distribution.push({ sharePercent: widePct, recipient: null, useExternalRecipient: false });
  } else {
    const last = p.distribution[p.distribution.length - 1];
    const lastShare = Number(last.sharePercent) || 0;
    const half = Number((lastShare / 2).toFixed(4));
    last.sharePercent = half;
    p.distribution.push({ sharePercent: half, recipient: null, useExternalRecipient: false });
  }
  renderPools();
}

function removeSlice(poolIdx, sliceIdx) {
  const p = pools[poolIdx];
  if (p.distribution.length <= 1) return;
  // Absorb the removed slice's share into the last remaining slice so
  // the positions total stays at whatever it was. Without this, removing
  // a slice would silently shrink the wide bucket and the user would
  // see a confusing "now total is 75%" warning that they didn't trigger
  // intentionally. The remaining slice grows to take back the freed
  // share.
  const removedShare = Number(p.distribution[sliceIdx].sharePercent) || 0;
  p.distribution.splice(sliceIdx, 1);
  if (p.distribution.length > 0) {
    const last = p.distribution[p.distribution.length - 1];
    last.sharePercent = Number(
      ((Number(last.sharePercent) || 0) + removedShare).toFixed(4),
    );
  }
  renderPools();
}

// ---------------------------------------------------------------------------
// Simple-config rendering and pool rebuild
// ---------------------------------------------------------------------------

// Rebuild the pools array from the current simpleConfig state. Always
// produces either one pool (SOL at 100%) or two pools (SOL at 90% +
// flywheel at 10%). Wipes any existing pools — this function is the
// authority on what pools look like when in default mode.
//
// Pools come up collapsed by default (since they're at trivial defaults
// with no user customization). Resolution kicks off automatically per
// the existing addPool() behavior.
function rebuildPoolsFromSimple() {
  // Wipe the existing pool list. We assume the caller knows what they're
  // doing — switching from customize → default mode should confirm
  // before calling this.
  pools.length = 0;

  // Helper: compute the wide-bucket total for a pool given its bs + ladder
  // configs. With unified semantics, bs + sum(ladder) + sum(wide slices)
  // = 100% of pool. So wide total = 100 - bs - sum(bands). Slices then
  // split this wide total equally.
  function widePctForPool(bsCfg, ladderCfg) {
    const bsPct = bsCfg && bsCfg.mode === 'custom' ? Number(bsCfg.supplyPercent) : 0;
    const ladderTotal = ladderCfg && Array.isArray(ladderCfg.bands)
      ? ladderCfg.bands.reduce((s, b) => s + Number(b.supplyPercent || 0), 0)
      : 0;
    return Math.max(0, 100 - bsPct - ladderTotal);
  }

  if (simpleConfig.flywheelEnabled) {
    const fw = FLYWHEELS[simpleConfig.flywheelKey];
    if (fw && fw.available && fw.mint) {
      const flywheelPct = Math.max(
        FLYWHEEL_MIN_PERCENT,
        Math.min(FLYWHEEL_MAX_PERCENT, Number(simpleConfig.flywheelPercent) || DEFAULT_FLYWHEEL_PERCENT),
      );
      const solPercent = 100 - flywheelPct;

      // Compute bootstrap and ladder for each pool. Bootstrap is derived
      // per-pool (since the pool's supplyPercent matters for converting
      // dollar value to % of pool); ladder is the same shape on both.
      const solBs = deriveBootstrapConfigFromSimple(solPercent, 2);
      const solLadder = deriveLadderConfigFromSimple();
      const fwBs = deriveBootstrapConfigFromSimple(flywheelPct, 2);
      const fwLadder = deriveLadderConfigFromSimple();

      // Distribution slices share the wide bucket. Split-the-LP applies
      // only to the SOL pool in simple mode; flywheel pool always gets
      // one slice. Each slice's sharePercent is "% of pool" (new unified
      // semantics).
      const solSplitCount = simpleConfig.splitEnabled ? simpleConfig.splitCount : 1;
      const solDistribution = buildEqualSplitDistribution(
        solSplitCount, widePctForPool(solBs, solLadder),
      );
      const fwDistribution = buildEqualSplitDistribution(
        1, widePctForPool(fwBs, fwLadder),
      );
      addPool({
        quoteToken: 'SOL',
        supplyPercent: solPercent,
        distribution: solDistribution,
        bootstrapConfig: solBs,
        ladderConfig: solLadder,
      });
      addPool({
        quoteToken: fw.mint,
        supplyPercent: flywheelPct,
        distribution: fwDistribution,
        bootstrapConfig: fwBs,
        ladderConfig: fwLadder,
      });
      return;
    }
    // Selected flywheel is not available (e.g. user picked it before
    // it launches, or the entry got removed); fall through to single-
    // SOL-pool default. The dropdown should prevent this in normal use.
  }

  // Default / flywheel-disabled / unavailable-flywheel case. Only one
  // pool (SOL), so splitting that pool is the only kind of split that
  // makes sense here.
  const bsCfg = deriveBootstrapConfigFromSimple(100, 1);
  const ladderCfg = deriveLadderConfigFromSimple();
  const distribution = buildEqualSplitDistribution(
    simpleConfig.splitEnabled ? simpleConfig.splitCount : 1,
    widePctForPool(bsCfg, ladderCfg),
  );
  addPool({
    quoteToken: 'SOL',
    supplyPercent: 100,
    distribution,
    bootstrapConfig: bsCfg,
    ladderConfig: ladderCfg,
  });
}

// Translate the simple-UI bootstrap toggle into a per-pool bootstrapConfig.
//
// The canonical user-intent value is the SOL value of starting liquidity
// (simpleConfig.bootstrapSolValue) split evenly across pools. We return
// both the solValue (canonical) and the derived supplyPercent (% of
// this pool), so the customize-mode UI can display either and the
// wire-format conversion can use supplyPercent without recomputing.
//
// supplyPercent uses the live SOL price when available (read from the
// SOL pool's resolvedPriceUsd), falling back to $200 when no pool has
// resolved yet — same fallback the funding estimator uses. The post-
// resolution refresh in resolvePoolQuote re-runs this and updates each
// pool's supplyPercent + rebalances slices when the live price arrives.
//
// If any input is missing or invalid (no resolved SOL price yet, no
// target mcap set, custom mode but zero SOL value), we return minimal
// mode. Pre-flight will reject if a custom-mode pool ends up with a
// bad supplyPercent, but returning minimal here is the friendlier
// behavior because the user can still launch and then switch to
// customize to fix it.
function deriveBootstrapConfigFromSimple(poolSupplyPercent, poolCount) {
  if (simpleConfig.mode !== 'default') return { mode: 'minimal' };
  if (simpleConfig.bootstrapMode !== 'custom') return { mode: 'minimal' };
  const totalSol = Number(simpleConfig.bootstrapSolValue);
  if (!Number.isFinite(totalSol) || totalSol <= 0) return { mode: 'minimal' };
  if (!Number.isFinite(poolCount) || poolCount <= 0) return { mode: 'minimal' };
  if (!Number.isFinite(poolSupplyPercent) || poolSupplyPercent <= 0) return { mode: 'minimal' };

  // Each pool gets an equal share of the total bootstrap SOL.
  const perPoolSol = totalSol / poolCount;
  // Derive supplyPercent for initial display. The on-input handlers
  // and the targetMarketCap/resolvePoolQuote hooks all recompute this
  // via computeBootstrapSupplyPercent() which uses the same logic.
  const supplyPercent = computeBootstrapSupplyPercent(perPoolSol, poolSupplyPercent);
  if (supplyPercent == null) return { mode: 'minimal' };
  return { mode: 'custom', solValue: perPoolSol, supplyPercent };
}

// Compute the supplyPercent (% of pool) for a bootstrap given:
//   solValue        — absolute SOL of starting liquidity for THIS pool
//   poolSupplyPct   — pool's allocation as % of total token supply
//
// Reads targetMarketCap from the DOM and the SOL price from the SOL
// pool's resolvedPriceUsd (falls back to $200 if unresolved). Returns
// null if any input is missing/invalid; callers treat null as "leave
// the supplyPercent alone."
function computeBootstrapSupplyPercent(solValue, poolSupplyPct) {
  const sol = Number(solValue);
  if (!Number.isFinite(sol) || sol <= 0) return null;
  if (!Number.isFinite(poolSupplyPct) || poolSupplyPct <= 0) return null;
  const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
  if (!Number.isFinite(targetMc) || targetMc <= 0) return null;
  const solPool = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
  const solUsd = solPool && Number(solPool.resolvedPriceUsd) > 0
    ? Number(solPool.resolvedPriceUsd) : 200;
  const bsUsd = sol * solUsd;
  const poolUsd = targetMc * poolSupplyPct / 100;
  if (poolUsd <= 0) return null;
  const pct = (bsUsd / poolUsd) * 100;
  if (!Number.isFinite(pct) || pct <= 0) return null;
  return pct;
}

// Refresh one pool's bootstrap supplyPercent from its stored solValue,
// then absorb the delta into the wide slices so positions total stays
// at 100%. Called from any path that can change the derived supplyPercent
// without changing user intent: targetMarketCap input, SOL price
// resolution, and the SOL input in customize mode itself.
//
// No-op when bootstrap is in minimal mode (no solValue to recompute)
// or when the recompute fails (missing mcap/price). In both cases the
// supplyPercent stays at whatever it was, so the total may drift —
// the warning indicator surfaces that to the user.
function recomputePoolBootstrapAndRebalance(pool) {
  if (!pool || !pool.bootstrapConfig || pool.bootstrapConfig.mode !== 'custom') return;
  const oldPct = Number(pool.bootstrapConfig.supplyPercent) || 0;
  const newPct = computeBootstrapSupplyPercent(
    pool.bootstrapConfig.solValue,
    Number(pool.supplyPercent),
  );
  if (newPct == null) return;
  pool.bootstrapConfig.supplyPercent = newPct;
  rebalanceWideSlicesByDelta(pool, newPct - oldPct);
}

// Translate the simple-UI ladder toggle into a per-pool ladderConfig.
//
// When the toggle is off (or the user is in customize mode but
// rebuildPoolsFromSimple is somehow called), return { mode: 'off' }.
// When on, generate the log-spaced default bands the simple UI would
// have produced — same math as the original simple-mode auto-generated
// bands. From this point, the user can edit individual bands in
// customize mode and the per-pool ladderConfig becomes the source of
// truth.
//
// Each band has supplyPercent (equal share of the global ladder %),
// lowerMultiplier, upperMultiplier. Multipliers are computed from
// the log-spacing math: ln(ceiling) / (2N - 1) per "unit", N bands +
// (N-1) gaps. Band i covers [ratio^(2i), ratio^(2i+1)].
function deriveLadderConfigFromSimple() {
  if (simpleConfig.mode !== 'default') return { mode: 'off', bands: [] };
  if (!simpleConfig.ladderEnabled) return { mode: 'off', bands: [] };
  const supplyPercent = Math.max(
    LADDER_MIN_PERCENT,
    Math.min(LADDER_MAX_PERCENT, Number(simpleConfig.ladderPercent) || LADDER_DEFAULT_PERCENT),
  );
  const bandCount = Math.max(
    LADDER_MIN_BANDS,
    Math.min(LADDER_MAX_BANDS, Number(simpleConfig.ladderBandCount) || LADDER_DEFAULT_BANDS),
  );
  return {
    mode: 'manual',
    bands: generateLogSpacedBands({
      supplyPercent,
      bandCount,
      ceilingMultiplier: LADDER_CEILING_MULTIPLIER,
    }),
  };
}

// Generate N log-spaced ladder bands covering [1×, ceiling×] with equal
// gap widths between bands. Each band is given an equal share of the
// total ladder supply. This is the math the backend's 'simple' mode
// used to do server-side; we do it client-side now so the bands are
// editable as manual-mode bands.
//
// Math: total log span = ln(ceiling), per-unit log = total/(2N-1)
// (N bands + N-1 gaps). Band i (0-indexed) covers
// [e^(2i × perUnit), e^((2i+1) × perUnit)].
function generateLogSpacedBands({ supplyPercent, bandCount, ceilingMultiplier }) {
  const perBandPct = supplyPercent / bandCount;
  const totalLog = Math.log(ceilingMultiplier);
  const perUnitLog = totalLog / (2 * bandCount - 1);
  const bands = [];
  for (let i = 0; i < bandCount; i++) {
    const lowerMul = Math.exp(2 * i * perUnitLog);
    const upperMul = Math.exp((2 * i + 1) * perUnitLog);
    bands.push({
      // toFixed → Number to bound trailing precision (the slider step
      // is 0.01, so 4 decimals is plenty for our needs).
      supplyPercent: Number(perBandPct.toFixed(4)),
      lowerMultiplier: Number(lowerMul.toFixed(4)),
      upperMultiplier: Number(upperMul.toFixed(4)),
    });
  }
  return bands;
}

// Paint the simple-config UI into #simpleConfigBody. Called whenever
// simpleConfig changes or when switching mode. Uses textContent /
// dataset on the elements we listen to, but constructs them with
// innerHTML for terseness — none of the values are user-controlled
// strings, so injection isn't a concern.
function renderSimpleConfig() {
  const body = document.getElementById('simpleConfigBody');
  if (!body) return;

  // Defensive: if simpleConfig.flywheelKey points at an unavailable
  // flywheel (e.g. someone re-flagged 'reserve' as unavailable, or a
  // future session-restore path loaded a stale key), fall back to the
  // first available one. Without this, the dropdown would render with
  // a disabled option pre-selected, which is awkward and confusing.
  const currentFw = FLYWHEELS[simpleConfig.flywheelKey];
  if (!currentFw || !currentFw.available) {
    const firstAvailable = Object.values(FLYWHEELS).find((fw) => fw.available);
    if (firstAvailable) {
      simpleConfig.flywheelKey = firstAvailable.key;
    }
  }

  // Build the list of <option> entries from FLYWHEELS, marking
  // unavailable ones as disabled so users see them but can't pick them.
  const options = Object.values(FLYWHEELS).map((fw) => {
    const selected = fw.key === simpleConfig.flywheelKey ? 'selected' : '';
    const disabled = !fw.available ? 'disabled' : '';
    return `<option value="${escapeHtml(fw.key)}" ${selected} ${disabled}>${escapeHtml(fw.label)}</option>`;
  }).join('');

  const dropdownDisabled = !simpleConfig.flywheelEnabled ? 'disabled' : '';
  const checked = simpleConfig.flywheelEnabled ? 'checked' : '';
  // Slider value — clamp at render time too, in case anything pushed it
  // out of range. The defensive clamp in rebuildPoolsFromSimple is the
  // ultimate authority but it's nicer if the UI shows the right number.
  const sliderValue = Math.max(
    FLYWHEEL_MIN_PERCENT,
    Math.min(FLYWHEEL_MAX_PERCENT, Number(simpleConfig.flywheelPercent) || DEFAULT_FLYWHEEL_PERCENT),
  );

  // Split-LP state. Slider value clamped here too — same belt-and-
  // suspenders rationale as the flywheel slider above.
  const splitChecked = simpleConfig.splitEnabled ? 'checked' : '';
  const splitSliderDisabled = !simpleConfig.splitEnabled ? 'disabled' : '';
  const splitValue = Math.max(
    SPLIT_MIN_COUNT,
    Math.min(SPLIT_MAX_COUNT, Number(simpleConfig.splitCount) || 1),
  );
  const splitReadoutText = `${splitValue} ${splitValue === 1 ? 'position' : 'positions'}`;

  // Help text varies based on toggle state. When on, describe what the
  // flywheel does. When off, describe what the simple SOL launch does.
  const helpText = simpleConfig.flywheelEnabled
    ? 'A flywheel routes a portion of trade fees into a reserve token like XLRT, building accumulation pressure on it. Recommended for most launches.'
    : 'Your token will launch in a single SOL pool with all supply allocated. No flywheel mechanic — simple and standard.';

  // Bootstrap-mode state. Clamp the SOL value defensively to prevent
  // negative or absurd values from a corrupted state from rendering
  // weirdly. The funding estimator does its own validation server-side;
  // this is just for display.
  const bsCustomChecked = simpleConfig.bootstrapMode === 'custom' ? 'checked' : '';
  const bsInputDisabled = simpleConfig.bootstrapMode === 'custom' ? '' : 'disabled';
  const bsSolValue = Math.max(0, Number(simpleConfig.bootstrapSolValue) || 0);

  // Ladder state. Disabled sliders when toggle is off — keeps the visible
  // values but conveys "this isn't doing anything" to the user.
  const ladderChecked = simpleConfig.ladderEnabled ? 'checked' : '';
  const ladderSlidersDisabled = simpleConfig.ladderEnabled ? '' : 'disabled';
  const ladderPercent = Math.max(
    LADDER_MIN_PERCENT,
    Math.min(LADDER_MAX_PERCENT, Number(simpleConfig.ladderPercent) || LADDER_DEFAULT_PERCENT),
  );
  const ladderBandCount = Math.max(
    LADDER_MIN_BANDS,
    Math.min(LADDER_MAX_BANDS, Number(simpleConfig.ladderBandCount) || LADDER_DEFAULT_BANDS),
  );

  body.innerHTML = `
    <div class="simple-config-row">
      <label class="simple-config-toggle">
        <input type="checkbox" id="simpleFlywheelToggle" ${checked}>
        <strong>Use a flywheel</strong>
      </label>
      <a class="is-size-7 ml-2" id="simpleFlywheelLearnMore" href="#" role="button"
         aria-haspopup="dialog" aria-controls="flywheelInfoModal">Learn more</a>
      <div class="select is-small simple-config-dropdown" ${dropdownDisabled}>
        <select id="simpleFlywheelSelect" ${dropdownDisabled}>
          ${options}
        </select>
      </div>
      <div class="simple-config-slider" ${dropdownDisabled}>
        <input type="range" id="simpleFlywheelSlider"
               min="${FLYWHEEL_MIN_PERCENT}" max="${FLYWHEEL_MAX_PERCENT}" step="1"
               value="${sliderValue}" ${dropdownDisabled}>
        <span class="simple-config-slider-value" id="simpleFlywheelSliderValue">${sliderValue}%</span>
      </div>
    </div>
    <p class="simple-config-help-text">${escapeHtml(helpText)}</p>
    <div class="simple-config-row">
      <label class="simple-config-toggle">
        <input type="checkbox" id="simpleSplitToggle" ${splitChecked}>
        <strong>Split the LP</strong>
      </label>
      <div class="simple-config-slider" ${splitSliderDisabled}>
        <input type="range" id="simpleSplitSlider"
               min="${SPLIT_MIN_COUNT}" max="${SPLIT_MAX_COUNT}" step="1"
               value="${splitValue}" ${splitSliderDisabled}>
        <span class="simple-config-slider-value" id="simpleSplitSliderValue">${splitReadoutText}</span>
      </div>
    </div>
    <p class="simple-config-help-text">Splits the SOL pool into multiple positions, each minting its own transferable Fee Key NFT (when Lock liquidity is enabled below) — useful if you want to give away or sell partial fee streams. To split the flywheel pool too, use Customize.</p>
    <div class="simple-config-row">
      <label class="simple-config-toggle">
        <input type="checkbox" id="simpleBootstrapCustomToggle" ${bsCustomChecked}>
        <strong>Add starting liquidity</strong>
      </label>
      <div class="simple-config-slider">
        <input class="input is-small" type="number" min="0" step="0.1"
               id="simpleBootstrapSolInput"
               style="width: 7rem;"
               value="${bsSolValue}" ${bsInputDisabled}>
        <span class="simple-config-slider-value" id="simpleBootstrapSolUnit">SOL total</span>
      </div>
    </div>
    <p class="simple-config-help-text">By default the bootstrap is a tiny ~$1 position that just makes the pool tradable. Enable this to deposit real starting liquidity across all your pools — the SOL you commit gets split evenly across every pool (SOL pool plus any flywheel pools), and each pool's bootstrap uses a full-range position so the support shows up at every price level. Token-side liquidity carves out of each pool's allocation; you don't need extra tokens.</p>
    <div class="simple-config-row">
      <label class="simple-config-toggle">
        <input type="checkbox" id="simpleLadderToggle" ${ladderChecked}>
        <strong>Ladder positions</strong>
      </label>
      <div class="simple-config-slider" ${ladderSlidersDisabled}>
        <input type="range" id="simpleLadderPercentSlider"
               min="${LADDER_MIN_PERCENT}" max="${LADDER_MAX_PERCENT}" step="5"
               value="${ladderPercent}" ${ladderSlidersDisabled}>
        <span class="simple-config-slider-value" id="simpleLadderPercentValue">${ladderPercent}% supply</span>
      </div>
      <div class="simple-config-slider" ${ladderSlidersDisabled}>
        <input type="range" id="simpleLadderBandsSlider"
               min="${LADDER_MIN_BANDS}" max="${LADDER_MAX_BANDS}" step="1"
               value="${ladderBandCount}" ${ladderSlidersDisabled}>
        <span class="simple-config-slider-value" id="simpleLadderBandsValue">${ladderBandCount} bands</span>
      </div>
    </div>
    <p class="simple-config-help-text">Splits a portion of each pool's supply across discrete log-spaced price bands going up to 1000× launch (with gaps between bands for breakouts). Each band acts as resistance on the way up and support on the way back down. Smooths supply distribution so 90% isn't gobbled up by the time you hit 10× — leaves room for higher-mcap accumulation. The rest of the pool stays in a wide position covering all prices.</p>
    <div class="simple-config-customize-row">
      <button type="button" class="button is-link is-light" id="simpleCustomizeBtn">
        <span class="icon"><i class="fas fa-sliders-h"></i></span>
        <span>Customize pools manually</span>
      </button>
    </div>
  `;

  // Wire up listeners. These elements are recreated on every render,
  // so attaching directly is fine — they're discarded along with the
  // innerHTML on the next render.
  const toggle = body.querySelector('#simpleFlywheelToggle');
  const select = body.querySelector('#simpleFlywheelSelect');
  const slider = body.querySelector('#simpleFlywheelSlider');
  const sliderReadout = body.querySelector('#simpleFlywheelSliderValue');
  const learnMoreLink = body.querySelector('#simpleFlywheelLearnMore');
  const splitToggle = body.querySelector('#simpleSplitToggle');
  const splitSlider = body.querySelector('#simpleSplitSlider');
  const splitReadout = body.querySelector('#simpleSplitSliderValue');
  const bsCustomToggle = body.querySelector('#simpleBootstrapCustomToggle');
  const bsSolInput = body.querySelector('#simpleBootstrapSolInput');
  const ladderToggle = body.querySelector('#simpleLadderToggle');
  const ladderPctSlider = body.querySelector('#simpleLadderPercentSlider');
  const ladderPctReadout = body.querySelector('#simpleLadderPercentValue');
  const ladderBandsSlider = body.querySelector('#simpleLadderBandsSlider');
  const ladderBandsReadout = body.querySelector('#simpleLadderBandsValue');
  const customizeBtn = body.querySelector('#simpleCustomizeBtn');

  // Learn-more link — opens the static flywheel explainer modal. The link
  // sits next to the toggle so the user can discover what flywheels do
  // before deciding to enable one. preventDefault on the click so the
  // href="#" doesn't scroll the page or change the URL hash.
  if (learnMoreLink) {
    learnMoreLink.addEventListener('click', (e) => {
      e.preventDefault();
      openFlywheelInfoModal();
    });
  }

  toggle.addEventListener('change', (e) => {
    simpleConfig.flywheelEnabled = e.target.checked;
    rebuildPoolsFromSimple();
    renderSimpleConfig();
    // No explicit renderPools() — rebuildPoolsFromSimple invokes
    // addPool which already paints the pool list.
  });

  select.addEventListener('change', (e) => {
    simpleConfig.flywheelKey = e.target.value;
    rebuildPoolsFromSimple();
    renderSimpleConfig();
  });

  // Slider has two events:
  //   - `input` fires continuously as the user drags. We update the
  //     readout live so they see the value moving with the thumb, but
  //     don't rebuild pools on every pixel — that would fire a quote
  //     resolution per pixel.
  //   - `change` fires on mouseup / keyboard commit. We rebuild pools
  //     here, once per drag.
  slider.addEventListener('input', (e) => {
    sliderReadout.textContent = `${e.target.value}%`;
  });
  slider.addEventListener('change', (e) => {
    simpleConfig.flywheelPercent = Number(e.target.value);
    rebuildPoolsFromSimple();
    // Don't re-render the simple-config UI on slider change — that
    // would destroy the slider element mid-drag-cycle on some browsers
    // and feels jumpy. The readout is already in sync from the input
    // handler above; pool list (hidden in default mode anyway) is
    // refreshed by addPool calls inside rebuildPoolsFromSimple.
  });

  // Split-LP toggle: enable/disable splitting. State persists so the
  // slider value sticks across uncheck→check cycles. Any change here
  // requires re-rendering the simple-config UI to flip the slider's
  // disabled visual state.
  splitToggle.addEventListener('change', (e) => {
    simpleConfig.splitEnabled = e.target.checked;
    rebuildPoolsFromSimple();
    renderSimpleConfig();
  });

  // Split slider follows the same input/change split as the flywheel
  // slider — live readout on input, pool rebuild on commit.
  splitSlider.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    splitReadout.textContent = `${v} ${v === 1 ? 'position' : 'positions'}`;
  });
  splitSlider.addEventListener('change', (e) => {
    simpleConfig.splitCount = Number(e.target.value);
    rebuildPoolsFromSimple();
  });

  // Bootstrap mode toggle: switch between minimal and custom. State
  // persists across toggle off/on cycles (the SOL value is kept), so a
  // user who accidentally untoggles doesn't lose their entered amount.
  // Re-renders so the SOL input flips between enabled and disabled, and
  // re-runs rebuildPoolsFromSimple so per-pool bootstrapConfig stays in
  // sync (this is what makes the simple→customize transition show the
  // bootstrap state correctly).
  bsCustomToggle.addEventListener('change', (e) => {
    simpleConfig.bootstrapMode = e.target.checked ? 'custom' : 'minimal';
    rebuildPoolsFromSimple();
    renderSimpleConfig();
  });

  // SOL value input. We update on `input` (every keystroke) rather than
  // on `change` so the value is fresh when the user clicks Continue.
  // The estimator will be called against the latest value at submit
  // time — no live re-estimate per keystroke (those are expensive and
  // bursty typing would drown the server). We also re-derive the
  // per-pool bootstrapConfig so a customize-mode switch later sees the
  // current value.
  bsSolInput.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    simpleConfig.bootstrapSolValue = Number.isFinite(v) && v >= 0 ? v : 0;
    rebuildPoolsFromSimple();
  });

  // Ladder toggle: enable/disable the ladder feature. State persists
  // (percent + band count are kept), and the sliders flip between
  // enabled/disabled via re-render. rebuildPoolsFromSimple regenerates
  // each pool's ladderConfig so the bands are populated/cleared.
  ladderToggle.addEventListener('change', (e) => {
    simpleConfig.ladderEnabled = e.target.checked;
    rebuildPoolsFromSimple();
    renderSimpleConfig();
  });

  // Ladder slider handlers update state on each tick and refresh just
  // the readout text — no full re-render needed for the simple UI
  // (rest of it is invariant under these changes). We do rebuild pools
  // so each pool's ladderConfig gets fresh bands sized for the new
  // value, in case the user switches to customize.
  ladderPctSlider.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    simpleConfig.ladderPercent = Number.isFinite(v) ? v : LADDER_DEFAULT_PERCENT;
    ladderPctReadout.textContent = `${simpleConfig.ladderPercent}% supply`;
    rebuildPoolsFromSimple();
  });
  ladderBandsSlider.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    simpleConfig.ladderBandCount = Number.isInteger(v) ? v : LADDER_DEFAULT_BANDS;
    ladderBandsReadout.textContent = `${simpleConfig.ladderBandCount} bands`;
    rebuildPoolsFromSimple();
  });

  customizeBtn.addEventListener('click', () => {
    // Switch into customize mode. Pools stay as they are — user starts
    // tuning from the current state. The Customize button (now hidden)
    // is replaced by a "Use a preset instead" affordance in
    // the customize-mode container that switches back.
    simpleConfig.mode = 'customize';
    applySimpleConfigMode();
  });
}

