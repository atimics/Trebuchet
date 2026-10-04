function vanityCandidateTarget(candidate) {
  if (candidate?.target) return candidate.target;
  const prefix = String(candidate?.prefix || '').trim();
  const suffix = String(candidate?.suffix || '').trim();
  if (prefix && suffix) return `${prefix}...${suffix}`;
  return prefix || suffix || candidate?.mode || 'vanity';
}

const VANITY_BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// The live rate is measured over this window: the grinder reports in per-thread bursts.
const VANITY_RATE_WINDOW_MS = 10000;
const VANITY_RATE_STORAGE_KEY = 'trebuchet:v2:vanity-rate';
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

// The speed to plan with: what this computer measured (Calibrate, or its last grind). Machines
// differ too much to guess, so until then there is none.
function vanityPlanningRate() {
  try {
    const saved = Number(window.localStorage?.getItem(VANITY_RATE_STORAGE_KEY));
    if (Number.isFinite(saved) && saved > 0) return saved;
  } catch { /* storage is optional */ }
  return null;
}

function rememberVanityRate(rate) {
  if (!(Number(rate) > 0)) return;
  try { window.localStorage?.setItem(VANITY_RATE_STORAGE_KEY, String(Math.round(rate))); } catch { /* storage is optional */ }
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
  const planningRate = vanityPlanningRate();
  const planningSeconds = expectedAttempts > 0 && planningRate ? expectedAttempts / planningRate : null;
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
    planningRate,
    planningSeconds,
    liveEtaSeconds,
    difficulty: invalid.length ? 'invalid' : vanityPatternDifficulty(expectedAttempts),
  };
}

function vanityEstimateSummary(prefix, suffix) {
  const estimate = vanityPatternEstimate(prefix, suffix, null);
  if (estimate.invalid.length) {
    return {
      label: 'Not allowed',
      detail: `Remove ${estimate.invalid.map((ch) => `"${ch}"`).join(', ')}. Addresses can't contain 0, O, I or l.`,
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
      label: 'Nothing to grind',
      detail: '',
      className: '',
    };
  }
  const live = estimate.rate
    ? `Live ${formatVanityRate(estimate.rate)}/s, ETA ${formatVanityDuration(estimate.liveEtaSeconds)}`
    : estimate.planningRate ? `~${formatVanityDuration(estimate.planningSeconds)} at ${formatVanityRate(estimate.planningRate)}/s` : 'Speed not measured';
  return {
    label: { easy: 'Quick', moderate: 'Takes a while', hard: 'Slow', extreme: 'Very slow' }[estimate.difficulty] || 'Estimate',
    detail: `About ${formatVanityAttempts(estimate.expectedAttempts)} tries (95% by ${formatVanityAttempts(estimate.p95)}). ${live}.`,
    className: estimate.difficulty === 'extreme' ? 'danger' : estimate.difficulty === 'hard' ? 'warn' : '',
  };
}

function vanityAvailabilityMeta() {
  if (state.apiStatus === 'connected' && !state.vanityAvailable) {
    return {
      label: 'Grinder unavailable',
      detail: state.vanityReason || 'This build has no grinder.',
      className: 'danger',
      icon: 'fa-triangle-exclamation',
    };
  }
  if (state.apiStatus === 'connected' && state.secretPin.locked) {
    return {
      label: 'Unlock to grind',
      detail: 'Grinding asks for your Recovery PIN, then saves the address on this computer.',
      className: 'warn',
      icon: 'fa-lock',
    };
  }
  if (state.apiStatus === 'connected') {
    return { label: 'Ready to grind', detail: '', className: '', icon: 'fa-wand-magic-sparkles' };
  }
  return { label: 'Desktop app only', detail: 'Open the Trebuchet desktop app to grind.', className: 'warn', icon: 'fa-eye' };
}

const ACTIVE_LAUNCH_KEY = 'trebuchet-v2-active-launch';
// Stored in place of a launch id when the operator closes the open launch, so
// the next load starts blank instead of re-opening the first saved launch.
const NO_ACTIVE_LAUNCH = '__none__';

// A saved address a launch has already minted can't be a new coin's address. Its key stays saved.
function vanityAddressUsedReason(publicKey) {
  const address = String(publicKey || '').trim();
  if (!address) return null;
  const candidate = (state.vanityCandidates || []).find((item) => item.publicKey === address);
  const launched = (state.coins?.list || []).find((coin) => coin.kind === 'onchain' && coin.launchedHere && coin.mint === address);
  if (!candidate?.usedBy && !launched) return null;
  // The launch wallet's own interrupted mint is still this launch's address.
  const owner = candidate?.usedBy?.walletPublicKey || launched?.walletPublicKey || null;
  if (owner && owner === selectedLaunchWalletPublicKey()) return null;
  const symbol = candidate?.usedBy?.symbol || launched?.symbol || '';
  return symbol ? `Used by $${symbol}` : 'Already used';
}

function freeVanityCandidates() {
  return (state.vanityCandidates || []).filter((candidate) => !vanityAddressUsedReason(candidate.publicKey));
}

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

// The launches list: every saved launch, the open one marked, plus a way to
// start a blank one. Without it a saved launch re-opened on every start with
// no way to leave it or reach the others.
function launchIsInProgress() {
  return Number(state.recovery?.activeJournalCount || 0) > 0;
}

function renderSavedLaunchList() {
  const host = $('#savedLaunches');
  if (!host) return;
  const launches = Array.isArray(state.savedLaunches) ? state.savedLaunches : [];
  const locked = launchIsInProgress();
  const rows = launches.map((entry) => {
    const token = entry.config?.token || {};
    const isOpen = entry.id === state.loadedSavedLaunchId;
    const symbol = String(token.symbol || '').toUpperCase() || '?';
    const name = String(token.name || entry.name || 'Untitled');
    return `<button class="saved-launch-row${isOpen ? ' is-open' : ''}" type="button" data-action="open-saved-launch" data-launch-id="${escapeHtml(entry.id)}"${isOpen ? ' aria-current="true"' : ''}${locked && !isOpen ? ' disabled' : ''}>
      <strong>$${escapeHtml(symbol)}</strong><span>${escapeHtml(name)}</span>
    </button>`;
  }).join('');
  const list = `
    <span class="saved-launches-title">Launches</span>
    <div class="saved-launch-rows">${rows}</div>
    <button class="saved-launch-new" type="button" data-action="new-launch"${locked ? ' disabled' : ''}><i class="fa-solid fa-plus" aria-hidden="true"></i> New launch</button>
    ${locked ? '<small class="saved-launches-note">A launch is in progress. Finish or recover it in History before switching.</small>' : ''}
  `;
  if (host) {
    const empty = !launches.length && !state.loadedSavedLaunchId;
    host.hidden = empty;
    host.innerHTML = empty ? '' : list;
  }
}

// Switching reloads the page: the editor holds a lot of per-launch state, and a
// clean start is the only way to be sure none of the old launch leaks into the
// next one. The saved launch itself is already persisted, so nothing is lost.
function switchActiveLaunch(id) {
  if (launchIsInProgress()) return;
  rememberActiveLaunchId(id || NO_ACTIVE_LAUNCH);
  window.location.reload();
}

// The saved (server-side) launch is explicit user intent: it opens once, and
// is never reapplied over edits made after it loaded.
function restoreDetectedLaunch() {
  if (!state.savedLaunches?.length) return false;
  if (state.loadedSavedLaunchId) return false;
  const rememberedId = rememberedActiveLaunchId();
  if (rememberedId === NO_ACTIVE_LAUNCH) return false;
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
        renderSavedLaunchList();
      })
      .catch(() => { /* auto-save is best-effort; the explicit errors surface elsewhere */ });
  }, 900);
}

// The grind area: this computer's speed, what the typed pattern would take, and the jobs:
// the one running, the ones queued after it, and the ones that ended, with their stats.
function grindJobHtml(job) {
  const tries = (value) => `${formatVanityAttempts(value)} tries`;
  const elapsed = ((job.endedAt || Date.now()) - (job.startedAt || Date.now())) / 1000;
  const average = elapsed > 0 && job.attempts ? job.attempts / elapsed : null;
  const pct = job.expected ? Math.round((job.attempts / job.expected) * 100) : null;
  const target = `<code>${escapeHtml(job.target)}</code>${job.caseInsensitive ? ' <small>any case</small>' : ''}${job.length ? ` <small>${escapeHtml(String(job.length))} chars</small>` : ''}`;
  const button = (action, label, inner) => `<button class="icon-button grind-job-close" type="button" data-action="${action}" data-job="${escapeHtml(job.id)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${inner}</button>`;
  const dismiss = button('dismiss-grind-job', 'Dismiss', '<i class="fa-solid fa-xmark" aria-hidden="true"></i>');
  if (job.status === 'running') {
    const left = job.rate && job.attempts < job.expected
      ? `~${formatVanityDuration((job.expected - job.attempts) / job.rate)} to expected`
      : job.rate ? 'past expected' : 'measuring speed';
    return `<li class="grind-job is-running"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i><span>${target}<small>${tries(job.attempts)} · ${pct ?? 0}% of expected · ${job.rate ? `${formatVanityRate(job.rate)}/s` : '—'} · ${escapeHtml(left)} · ${formatVanityDuration(elapsed)} so far</small></span>${button('stop-grind-job', 'Stop this grind', '<i class="fa-solid fa-stop" aria-hidden="true"></i> Stop')}</li>`;
  }
  if (job.status === 'queued') {
    const rate = vanityPlanningRate();
    return `<li class="grind-job is-queued"><i class="fa-regular fa-clock" aria-hidden="true"></i><span>${target}<small>Queued · about ${tries(job.expected)}${rate ? ` · ~${formatVanityDuration(job.expected / rate)}` : ''}</small></span>${button('stop-grind-job', 'Remove from the queue', '<i class="fa-solid fa-xmark" aria-hidden="true"></i>')}</li>`;
  }
  const stats = `${tries(job.attempts)} in ${formatVanityDuration(elapsed)}${average ? ` · ${formatVanityRate(average)}/s` : ''}${pct != null ? ` · ${pct}% of expected` : ''}`;
  if (job.status === 'found') {
    return `<li class="grind-job is-found"><i class="fa-solid fa-check" aria-hidden="true"></i><span>${target}<small>Found <code>${escapeHtml(fullAddress(job.publicKey))}</code> · ${stats}</small></span>${dismiss}</li>`;
  }
  if (job.status === 'stopped') {
    return `<li class="grind-job is-stopped"><i class="fa-solid fa-stop" aria-hidden="true"></i><span>${target}<small>Stopped · ${stats}</small></span>${dismiss}</li>`;
  }
  return `<li class="grind-job is-failed"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>${target}<small>${escapeHtml(job.error || 'Failed')} · ${stats}</small></span>${dismiss}</li>`;
}

function grindAreaHtml({ canGrind, estimate }) {
  const running = runningGrindJob();
  const rate = vanityPlanningRate();
  const pattern = estimate.prefix && estimate.suffix ? `${estimate.prefix}...${estimate.suffix}` : estimate.prefix || estimate.suffix;
  const typed = estimate.targetLength && !estimate.invalid.length && Number.isFinite(estimate.expectedAttempts) && estimate.expectedAttempts > 0
    ? `<p class="grind-estimate"><code>${escapeHtml(pattern)}</code> about ${formatVanityAttempts(estimate.expectedAttempts)} tries${rate ? ` · ~${formatVanityDuration(estimate.expectedAttempts / rate)}, 95% by ~${formatVanityDuration(estimate.p95 / rate)}` : ''}</p>`
    : '';
  const jobs = state.grindJobs || [];
  return `
    <div class="grind-area">
      <div class="grind-head">
        <button class="primary-button compact" type="button" data-action="start-vanity" ${canGrind ? '' : 'disabled'}><i class="fa-solid ${running ? 'fa-plus' : 'fa-hammer'}" aria-hidden="true"></i><span>${running ? 'Add to queue' : 'Grind'}</span></button>
        <span class="grind-speed">${state.vanityCalibrating ? 'Measuring this computer…' : rate ? `This computer: ${formatVanityRate(rate)}/s` : 'Speed not measured'}</span>
        <button class="secondary-button compact" type="button" data-action="calibrate-vanity" ${state.vanityCalibrating || running ? 'disabled' : ''}><i class="fa-solid fa-gauge-high" aria-hidden="true"></i><span>${state.vanityCalibrating ? 'Calibrating…' : 'Calibrate'}</span></button>
      </div>
      ${state.vanityCalibrationError ? `<p class="grind-estimate is-error">${escapeHtml(state.vanityCalibrationError)}</p>` : ''}
      ${typed}
      ${jobs.length ? `<ul class="grind-jobs" aria-label="Grinds">${jobs.map(grindJobHtml).join('')}</ul>` : ''}
    </div>`;
}

function renderVanityCandidates() {
  const selected = state.vanityCandidates.find((item) => item.publicKey === state.selectedVanityPublicKey) || null;
  const meta = vanityAvailabilityMeta();
  const vanity = currentVanityConfig();
  const rawEstimate = vanityPatternEstimate(vanity.prefix, vanity.suffix, null);
  const estimate = vanityEstimateSummary(vanity.prefix, vanity.suffix);
  const candidates = state.vanityCandidates.slice(-VANITY_VISIBLE_CANDIDATE_LIMIT).reverse();
  const hiddenCount = Math.max(0, state.vanityCandidates.length - candidates.length);
  const canGrind = !rawEstimate.invalid.length && rawEstimate.difficulty !== 'impossible' && (state.apiStatus !== 'connected' || state.vanityAvailable);
  const canRemoveSelected = Boolean(selected?.publicKey);
  const candidateButtons = candidates.map((candidate) => {
    const isActive = candidate.publicKey === state.selectedVanityPublicKey;
    const rarity = String(candidate.rarity || 'Common').trim();
    const grade = vanityRarityGrade(rarity);
    const attempts = Number(candidate.attempts);
    const epochs = Number(candidate.epochs);
    // Search effort comes from this device's concurrent workers.
    const luck = Number.isFinite(epochs) && epochs > 0 ? ` · local count: ${epochs.toFixed(2)}× the expected tries` : '';
    const details = [
      vanityCandidateTarget(candidate),
      Number.isFinite(attempts) && attempts > 0 ? `${formatVanityAttempts(attempts)} local tries` : null,
    ].filter(Boolean);
    return `
    <button class="vanity-candidate grinder-row grade-${escapeHtml(grade)} ${isActive ? 'is-active' : ''}" type="button" data-action="select-vanity" data-public-key="${escapeHtml(candidate.publicKey)}" title="${escapeHtml(`Local grind grade: ${rarity}${luck}`)}" aria-pressed="${isActive ? 'true' : 'false'}">
      <span class="grinder-radio" aria-hidden="true"></span>
      <span class="grinder-row-main">
        <code aria-label="Contract address ${escapeHtml(candidate.publicKey)}">${escapeHtml(fullAddress(candidate.publicKey))}</code>
        <small><b class="vanity-grade grade-${escapeHtml(grade)}">Local ${escapeHtml(rarity)}</b> · ${details.map(escapeHtml).join(' · ')}</small>
      </span>
      ${isActive ? '<span class="grinder-row-state">In use</span>' : ''}
    </button>
  `;
  }).join('');
  const statusLine = (item) => `
      <li class="grinder-status ${escapeHtml(item.className)}">
        <i class="fa-solid ${escapeHtml(item.icon)}" aria-hidden="true"></i>
        <strong>${escapeHtml(item.label)}</strong>
        <span>${escapeHtml(item.detail)}</span>
      </li>`;
  // Only what needs saying: a problem with the grinder or the pattern. The grind area says the rest.
  const statusItems = [
    meta.label === 'Ready to grind' ? null : meta,
    ['Not allowed', 'Impossible'].includes(estimate.label) ? { ...estimate, icon: 'fa-triangle-exclamation' } : null,
  ].filter(Boolean);
  const statuses = $('#vanityStatuses');
  if (statuses) {
    statuses.innerHTML = statusItems.length
      ? `<ul class="grinder-statuses" aria-label="Grinder status">${statusItems.map(statusLine).join('')}</ul>`
      : '';
  }
  const preview = $('#vanityPreview');
  if (preview) preview.innerHTML = vanityPreviewHtml(vanity, selected);
  const grind = $('#vanityGrind');
  if (grind) {
    grind.innerHTML = grindAreaHtml({ canGrind, estimate: rawEstimate });
  }
  const savedCount = state.vanityCandidates.length;
  $('#vanityCandidates').innerHTML = `
    <div class="grinder-results-head"><span>Addresses</span><span class="grinder-count">${savedCount} saved${hiddenCount ? `, ${hiddenCount} not shown` : ''}</span></div>
    ${state.vanityInputError
      ? `<p class="grinder-note is-error" id="vanityFeedback" role="alert">${escapeHtml(state.vanityInputError)}</p>`
      : '<p class="grinder-note" id="vanityFeedback"></p>'}
    <div class="grinder-list" role="group" aria-label="Saved contract addresses">
      <button class="grinder-row ${selected ? '' : 'is-active'}" type="button" data-action="select-vanity" data-public-key="" aria-pressed="${selected ? 'false' : 'true'}">
        <span class="grinder-radio" aria-hidden="true"></span>
        <span class="grinder-row-main"><code>Random address</code><small></small></span>
        ${selected ? '' : '<span class="grinder-row-state">In use</span>'}
      </button>
      ${candidateButtons}
    </div>
    <div class="grinder-actions">
      <button class="secondary-button compact" type="button" data-action="remove-selected-vanity" ${canRemoveSelected ? '' : 'disabled'}>Remove selected</button>
      ${hiddenCount ? `<button class="text-button" type="button" data-action="prune-hidden-vanity">Delete ${hiddenCount} older</button>` : ''}
    </div>
  `;
}

// The address as it will read: the chosen start and end bright, the rest as dots.
// With a ground address selected it shows the real address, matching part marked.
function vanityPreviewHtml(vanity, selected) {
  const prefix = String(vanity.prefix || '');
  const suffix = String(vanity.suffix || '');
  const length = Number(vanity.length) || 44;
  if (selected?.publicKey) {
    const address = selected.publicKey;
    const head = Math.min(prefix.length, address.length);
    const tail = Math.min(suffix.length, address.length - head);
    const middle = address.slice(head, address.length - tail);
    return `<small>Contract address</small><code class="grinder-mask is-real"><b>${escapeHtml(address.slice(0, head))}</b>${escapeHtml(middle)}<b>${escapeHtml(tail ? address.slice(-tail) : '')}</b></code>`;
  }
  const fill = Math.max(0, length - prefix.length - suffix.length);
  return `<small>${prefix || suffix ? 'Pattern' : 'Random address'}</small><code class="grinder-mask"><b>${escapeHtml(prefix)}</b><span>${'·'.repeat(fill)}</span><b>${escapeHtml(suffix)}</b></code>`;
}
