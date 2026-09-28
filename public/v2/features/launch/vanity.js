function vanityCandidateTarget(candidate) {
  if (candidate?.target) return candidate.target;
  const prefix = String(candidate?.prefix || '').trim();
  const suffix = String(candidate?.suffix || '').trim();
  if (prefix && suffix) return `${prefix}...${suffix}`;
  return prefix || suffix || candidate?.mode || 'vanity';
}

function vanityCandidateDetail(candidate) {
  if (!candidate) return 'Fresh random mint keypair';
  const parts = [];
  const rarity = String(candidate.rarity || '').trim();
  const attempts = Number(candidate.attempts);
  parts.push(vanityCandidateTarget(candidate));
  if (rarity) parts.push(rarity);
  if (Number.isFinite(attempts) && attempts > 0) parts.push(`${attempts.toLocaleString()} tries`);
  if (candidate.persisted) parts.push('saved');
  return parts.join(' / ');
}

const VANITY_BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const VANITY_PLANNING_RATE = 50000;
const VANITY_VISIBLE_CANDIDATE_LIMIT = 4;

function vanityRarityGrade(rarity) {
  const normalized = String(rarity || 'Common').trim().toLowerCase();
  if (['mythic', 'commissioned'].includes(normalized)) return 'commissioned';
  if (['legendary', 'rati', 'rati-grade'].includes(normalized)) return 'rati';
  if (['rare', 'epic'].includes(normalized)) return 'rare';
  if (['fine', 'uncommon'].includes(normalized)) return 'fine';
  return 'common';
}

function formatVanityAttempts(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '0';
  if (number < 1000000) return Math.round(number).toLocaleString();
  return new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: number >= 1e12 ? 2 : 1,
  }).format(number);
}

// Three significant figures ("716K"): a steady rate should read steady.
function formatVanityRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '0';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 }).format(number);
}

function formatVanityDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return 'now';
  if (value < 60) return `${Math.ceil(value)}s`;
  if (value < 3600) return `${Math.ceil(value / 60)}m`;
  if (value < 86400) return `${Math.ceil(value / 3600)}h`;
  if (value < 31536000) return `${Math.ceil(value / 86400)}d`;
  return `${Math.ceil(value / 31536000)}y`;
}

// From the real odds, not the pattern length: "A" and "R" differ ~60x.
function vanityPatternDifficulty(expectedAttempts) {
  if (!expectedAttempts) return 'random';
  if (!Number.isFinite(expectedAttempts)) return 'impossible';
  if (expectedAttempts <= 1e6) return 'easy';
  if (expectedAttempts <= 1e9) return 'moderate';
  if (expectedAttempts <= 1e11) return 'hard';
  return 'extreme';
}

function vanityExpectedAttempts(start, end, caseInsensitive, length = null) {
  if (TrebuchetCore.invalidBase58Characters(`${start}${end}`).length) return 0;
  return TrebuchetCore.expectedVanityAttempts(start, end, { caseInsensitive, length });
}

function vanityPatternEstimate(prefix, suffix, stats = state.vanityProgressStats) {
  const start = String(prefix || '').trim();
  const end = String(suffix || '').trim();
  const targetLength = start.length + end.length;
  const invalid = [...`${start}${end}`].filter((ch) => !VANITY_BASE58_ALPHABET.includes(ch));
  const caseInsensitive = stats?.caseInsensitive ?? ($('#vanityCaseInsensitive')?.checked === true);
  const length = stats ? (stats.length || null) : (Number($('#vanityLength')?.value) || null);
  const expectedAttempts = targetLength > 0 || length ? vanityExpectedAttempts(start, end, caseInsensitive, length) : 0;
  const p50 = expectedAttempts * Math.log(2);
  const p95 = expectedAttempts * -Math.log(0.05);
  const liveRate = Number(stats?.rate);
  const attempts = Number(stats?.attempts || 0);
  const planningSeconds = expectedAttempts > 0 ? expectedAttempts / VANITY_PLANNING_RATE : 0;
  const liveEtaSeconds = liveRate > 0 && expectedAttempts > attempts
    ? (expectedAttempts - attempts) / liveRate
    : null;
  return {
    prefix: start,
    suffix: end,
    targetLength,
    invalid: Array.from(new Set(invalid)),
    expectedAttempts,
    p50,
    p95,
    attempts: Number.isFinite(attempts) ? attempts : 0,
    rate: Number.isFinite(liveRate) ? liveRate : null,
    planningSeconds,
    liveEtaSeconds,
    difficulty: invalid.length ? 'invalid' : vanityPatternDifficulty(expectedAttempts),
  };
}

function vanityEstimateSummary(prefix, suffix) {
  const estimate = vanityPatternEstimate(prefix, suffix);
  if (estimate.invalid.length) {
    return {
      label: 'Invalid Base58',
      detail: `Remove ${estimate.invalid.map((ch) => `"${ch}"`).join(', ')}; Solana addresses cannot contain 0, O, I, or l.`,
      className: 'danger',
    };
  }
  if (estimate.difficulty === 'impossible') {
    return {
      label: 'Impossible',
      // Addresses shorter than 43 characters come only from keys with a
      // leading zero byte, and those all start with "1".
      detail: estimate.prefix
        ? `No address of that length can start with "${estimate.prefix}". Choose 43 characters or Any.`
        : 'Addresses this short always start with "1". Start with 1, or choose 43 characters or Any.',
      className: 'danger',
    };
  }
  if (!estimate.targetLength) {
    return {
      label: 'Random CA',
      detail: 'No start/end target. Grind is optional and instant random mint generation remains available.',
      className: '',
    };
  }
  const live = estimate.rate
    ? `Live ${formatVanityRate(estimate.rate)}/s, ETA ${formatVanityDuration(estimate.liveEtaSeconds)}`
    : `At ${formatVanityAttempts(VANITY_PLANNING_RATE)}/s: ~${formatVanityDuration(estimate.planningSeconds)}`;
  return {
    label: `${estimate.difficulty[0].toUpperCase()}${estimate.difficulty.slice(1)} pattern`,
    detail: `Expected ${formatVanityAttempts(estimate.expectedAttempts)} tries; 50% by ${formatVanityAttempts(estimate.p50)}, 95% by ${formatVanityAttempts(estimate.p95)}. ${live}.`,
    className: estimate.difficulty === 'extreme' ? 'danger' : estimate.difficulty === 'hard' ? 'warn' : '',
  };
}

function vanityAvailabilityMeta() {
  if (state.vanityRunning) {
    return { label: 'Grinding', detail: state.vanityProgress || 'Native grinder is searching.', className: 'warn', icon: 'fa-spinner fa-spin' };
  }
  if (state.apiStatus === 'connected' && !state.vanityAvailable) {
    return {
      label: 'Grinder unavailable',
      detail: state.vanityReason || 'Native vanity_keygen helper is not available in this build.',
      className: 'danger',
      icon: 'fa-triangle-exclamation',
    };
  }
  if (state.apiStatus === 'connected' && state.secretPin.locked) {
    return {
      label: 'Unlock to grind',
      detail: 'Grind will ask for the Recovery PIN, then save the Vanity CA locally.',
      className: 'warn',
      icon: 'fa-lock',
    };
  }
  if (state.apiStatus === 'connected') {
    return { label: 'Native grinder ready', detail: 'Saved Vanity CA options stay selectable across runs.', className: '', icon: 'fa-wand-magic-sparkles' };
  }
  return { label: 'Static preview', detail: 'Open through the Trebuchet desktop app to run the native grinder.', className: 'warn', icon: 'fa-eye' };
}

const ACTIVE_LAUNCH_KEY = 'trebuchet-v2-active-launch';

function rememberActiveLaunchId(id) {
  try {
    if (id) window.localStorage?.setItem(ACTIVE_LAUNCH_KEY, id);
    else window.localStorage?.removeItem(ACTIVE_LAUNCH_KEY);
  } catch {
    // Local storage is optional in restricted contexts.
  }
}

function rememberedActiveLaunchId() {
  try {
    return window.localStorage?.getItem(ACTIVE_LAUNCH_KEY) || null;
  } catch {
    return null;
  }
}

const BASE58_SAFE_RE = /^[1-9A-HJ-NP-Za-km-z]*$/;

// Auto-save is a background convenience: it must never fire a request that
// the server would reject (that shows up as a console error), so validate
// locally first and stay silent until the launch is coherent.
function canAutoSaveLaunch(config) {
  const token = config?.token || {};
  const name = String(token.name || '').trim();
  const symbol = String(token.symbol || '').trim();
  const supply = String(token.supply || '').replace(/,/g, '').trim();
  if (!name || !symbol) return false;
  if (!/^[1-9]\d*$/.test(supply)) return false;
  const pools = Array.isArray(config?.poolTopology?.pools) ? config.poolTopology.pools : [];
  if (!pools.length) return false;
  // A launch allocation must actually be complete: dragging the vortex (or
  // clearing a field) must never auto-save a degenerate plan such as a single
  // SOL pool at 0%, which cannot be launched and loses the flywheel pairing.
  // Same total as Core's buildLaunchPlan: pools + team share + airdrop.
  const topology = config?.poolTopology || {};
  const totalSupplyPercent = pools.reduce((sum, pool) => sum + Number(pool?.supplyPercent || 0), 0)
    + Number(topology.preallocation?.supplyPercent || 0)
    + (topology.airdrop?.enabled ? Number(topology.airdrop.supplyPercent || 0) : 0);
  if (totalSupplyPercent < 99.5 || totalSupplyPercent > 100.5) return false;
  const solPool = pools.find((pool) => String(pool?.quoteSymbol || '').toUpperCase() === 'SOL');
  if (solPool && Number(solPool.supplyPercent || 0) <= 0) return false;
  const prefix = String(config?.vanity?.prefix || '');
  const suffix = String(config?.vanity?.suffix || '');
  if (!BASE58_SAFE_RE.test(prefix) || !BASE58_SAFE_RE.test(suffix)) return false;
  return true;
}

// The saved (server-side) launch is explicit user intent: it opens once, and
// is never reapplied over edits made after it loaded.
function restoreDetectedLaunch() {
  if (!state.savedLaunches?.length) return false;
  if (state.loadedSavedLaunchId) return false;
  const rememberedId = rememberedActiveLaunchId();
  const entry = state.savedLaunches.find((item) => item.id === rememberedId) || state.savedLaunches[0];
  if (!entry) return false;
  const loaded = restoreLaunchConfigFromJournal({
    launchConfig: entry.config,
    token: { mint: entry.config?.vanity?.selectedPublicKey || null },
  });
  if (!loaded) return false;
  state.loadedSavedLaunchId = entry.id;
  rememberActiveLaunchId(entry.id);
  state.restoredLaunchJournalId = null;
  // A saved launch opens in the editor.
  setLaunchWorkspace('configure');
  return true;
}

let launchAutoSaveTimer = null;

// No save button: the current launch config is persisted automatically as it
// is edited, so a restart never loses it. The entry appears in the left pane
// the moment it exists.
function scheduleLaunchAutoSave() {
  if (!state.apiClient?.saveLaunch || state.apiStatus !== 'connected') return;
  clearTimeout(launchAutoSaveTimer);
  launchAutoSaveTimer = setTimeout(() => {
    const config = currentLaunchConfig();
    if (!canAutoSaveLaunch(config)) return;
    const token = config.token || {};
    const identity = `${token.symbol || ''}:${token.name || ''}`.toLowerCase();
    const matching = (state.savedLaunches || []).find((item) => (
      `${item.config?.token?.symbol || ''}:${item.config?.token?.name || ''}`.toLowerCase() === identity
    ));
    const targetId = state.loadedSavedLaunchId || matching?.id || null;
    state.apiClient.saveLaunch({
      id: targetId,
      name: token.name || token.symbol,
      config,
    })
      .then((payload) => {
        const entry = payload?.launch;
        if (!entry?.id) return;
        state.loadedSavedLaunchId = entry.id;
        rememberActiveLaunchId(entry.id);
        const list = Array.isArray(state.savedLaunches) ? state.savedLaunches.slice() : [];
        const index = list.findIndex((item) => item.id === entry.id);
        if (index >= 0) list[index] = entry; else list.unshift(entry);
        state.savedLaunches = list;
      })
      .catch(() => { /* auto-save is best-effort; the explicit errors surface elsewhere */ });
  }, 900);
}

function renderVanityCandidates() {
  // A running grind cannot change mode: lock the toggle to what is running.
  const caseToggle = $('#vanityCaseInsensitive');
  const lengthSelect = $('#vanityLength');
  if (lengthSelect) {
    lengthSelect.disabled = state.vanityRunning === true;
    if (state.vanityRunning && state.vanityProgressStats) {
      lengthSelect.value = state.vanityProgressStats.length ? String(state.vanityProgressStats.length) : '';
    }
  }
  if (caseToggle) {
    caseToggle.disabled = state.vanityRunning === true;
    if (state.vanityRunning && state.vanityProgressStats) {
      caseToggle.checked = state.vanityProgressStats.caseInsensitive === true;
    }
  }
  const selected = state.vanityCandidates.find((item) => item.publicKey === state.selectedVanityPublicKey) || null;
  const meta = vanityAvailabilityMeta();
  const vanity = currentVanityConfig();
  const rawEstimate = vanityPatternEstimate(vanity.prefix, vanity.suffix);
  const estimate = vanityEstimateSummary(vanity.prefix, vanity.suffix);
  const candidates = state.vanityCandidates.slice(-VANITY_VISIBLE_CANDIDATE_LIMIT).reverse();
  const hiddenCount = Math.max(0, state.vanityCandidates.length - candidates.length);
  const canGrind = state.vanityRunning || (!rawEstimate.invalid.length && (state.apiStatus !== 'connected' || state.vanityAvailable));
  const canRemoveSelected = Boolean(selected?.publicKey);
  const candidateButtons = candidates.map((candidate, index) => {
    const isActive = candidate.publicKey === state.selectedVanityPublicKey;
    const rarity = String(candidate.rarity || 'Common').trim();
    const grade = vanityRarityGrade(rarity);
    const attempts = Number(candidate.attempts);
    const epochs = Number(candidate.epochs);
    const mode = candidate.mode || (candidate.prefix && candidate.suffix ? 'both' : candidate.prefix ? 'prefix' : candidate.suffix ? 'suffix' : 'saved');
    const details = [
      vanityCandidateTarget(candidate),
      Number.isFinite(attempts) && attempts > 0 ? `${formatVanityAttempts(attempts)} tries` : null,
      Number.isFinite(epochs) && epochs >= 0 ? `${epochs.toFixed(2)} epochs` : null,
      mode,
    ].filter(Boolean);
    return `
    <button class="vanity-candidate grade-${escapeHtml(grade)} ${isActive ? 'is-active' : ''}" type="button" data-action="select-vanity" data-public-key="${escapeHtml(candidate.publicKey)}" title="${escapeHtml(candidate.publicKey)}" aria-pressed="${isActive ? 'true' : 'false'}">
      <span class="vanity-candidate-slot">${String(index + 1).padStart(2, '0')}</span>
      <span class="vanity-candidate-main">
        <code class="vanity-ca-address" aria-label="Contract address ${escapeHtml(candidate.publicKey)}">${escapeHtml(shortAddress(candidate.publicKey))}</code>
        <small class="vanity-candidate-meta">
          <b class="vanity-grade grade-${escapeHtml(grade)}">${escapeHtml(rarity)}</b>
          ${details.map((detail) => `<span>${escapeHtml(detail)}</span>`).join('')}
        </small>
      </span>
      <span class="vanity-candidate-state">${isActive ? 'selected' : 'saved'}</span>
    </button>
  `;
  }).join('');
  $('#vanityCandidates').innerHTML = `
    <div class="vanity-terminal-status" aria-label="Vanity grinder status">
      <div class="vanity-status ${escapeHtml(meta.className)}">
        <i class="fa-solid ${escapeHtml(meta.icon)}"></i>
        <strong>${escapeHtml(meta.label)}</strong>
        <small>${escapeHtml(meta.detail)}</small>
      </div>
      <div class="vanity-status vanity-estimate ${escapeHtml(estimate.className)}">
        <i class="fa-solid fa-gauge-high"></i>
        <strong>${escapeHtml(estimate.label)}</strong>
        <small>${escapeHtml(estimate.detail)}</small>
      </div>
    </div>
    ${state.vanityInputError ? `<p class="vanity-feedback" id="vanityFeedback" role="alert">${escapeHtml(state.vanityInputError)}</p>` : '<p class="vanity-feedback" id="vanityFeedback">Enter a start, an end, or both. Base58 only.</p>'}
    <div class="vanity-candidate-list" aria-label="Saved contract addresses">
      <div class="vanity-list-head" aria-hidden="true">
        <span>Slot</span>
        <span>Contract address / grade / grind proof</span>
        <span>State</span>
      </div>
      ${candidateButtons || '<div class="vanity-empty"><span>--</span><code>NO SAVED CONTRACT ADDRESSES</code><small>Run the grinder to retain a local CA.</small></div>'}
    </div>
    <div class="vanity-actions">
      <button class="pill-button ${selected ? '' : 'is-active'}" type="button" data-action="select-vanity" data-public-key="" aria-label="Select random CA" aria-pressed="${selected ? 'false' : 'true'}"><span aria-hidden="true">$</span> random</button>
      <button class="pill-button" type="button" data-action="start-vanity" ${canGrind ? '' : 'disabled'}>
        <span aria-hidden="true">$</span> ${state.vanityRunning ? 'cancel' : 'grind'}
      </button>
      <button class="pill-button" type="button" data-action="remove-selected-vanity" aria-label="Remove selected" ${canRemoveSelected ? '' : 'disabled'}><span aria-hidden="true">$</span> remove</button>
      <button class="pill-button" type="button" data-action="prune-hidden-vanity" aria-label="Prune hidden" ${hiddenCount ? '' : 'disabled'}><span aria-hidden="true">$</span> prune${hiddenCount ? ` ${hiddenCount}` : ''}</button>
      <span class="vanity-progress">${state.vanityCandidates.length} saved${hiddenCount ? ` · ${hiddenCount} hidden` : ''}</span>
    </div>
  `;
}
