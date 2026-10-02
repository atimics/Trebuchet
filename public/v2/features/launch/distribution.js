function parseSliceShares(value) {
  const shares = String(value || '')
    .split(/[,\s/|]+|[-–—]+/)
    .map((part) => parseNumericInput(part, NaN))
    .filter((part) => Number.isFinite(part) && part > 0);
  const safeShares = shares.length ? shares : [100];
  const total = safeShares.reduce((sum, item) => sum + item, 0);
  if (total <= 0) return [100];
  const normalized = safeShares.map((item) => Number(((item / total) * 100).toFixed(2)));
  const drift = Number((100 - normalized.reduce((sum, item) => sum + item, 0)).toFixed(2));
  normalized[normalized.length - 1] = Number((normalized[normalized.length - 1] + drift).toFixed(2));
  return normalized;
}

function formatPercent(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(2).replace(/\.?0+$/, '');
}

function normalizedSliceText(value) {
  return parseSliceShares(value).map(formatPercent).join(',');
}

// What the "Position slices" text means, in plain words, so a bare "100" (one
// position) or "30,30" (scaled up to 50,50) is never a surprise. Mirrors
// parseSliceShares: the same separators, the same scaling.
function describeSliceInput(value) {
  const tokens = String(value || '').split(/[,\s/|]+|[-–—]+/).filter(Boolean);
  const numbers = tokens.map((token) => parseNumericInput(token, NaN));
  const rejected = tokens.filter((token, index) => !(Number.isFinite(numbers[index]) && numbers[index] > 0));
  const valid = numbers.filter((number) => Number.isFinite(number) && number > 0);
  const rawTotal = valid.reduce((sum, number) => sum + number, 0);
  const slices = parseSliceShares(value);
  const list = slices.map((share) => `${formatPercent(share)}%`).join(' + ');
  const parts = [];
  let tone = 'ok';
  if (rejected.length) {
    tone = 'warn';
    parts.push(`Ignored: ${rejected.slice(0, 3).join(', ')}${rejected.length > 3 ? ', ...' : ''}.`);
  }
  if (!valid.length) {
    parts.push(tokens.length ? 'No usable numbers, so one position (100%).' : 'Empty, so one position (100%).');
  } else if (slices.length === 1) {
    parts.push('1 position, all of this pool.');
  } else {
    parts.push(`${slices.length} positions: ${list}.`);
  }
  if (valid.length && Math.abs(rawTotal - 100) > 0.005) {
    tone = 'warn';
    parts.push(`Your numbers total ${formatPercent(rawTotal)}, so they are scaled to 100%.`);
  }
  return { slices, rawTotal, rejected, tone, invalid: rejected.length > 0, text: parts.join(' ') };
}

// Limits for the numeric fields of a pool's advanced panel. The launch plan
// clamps to these; the panel says so instead of changing the number silently.
function checkPoolNumberField(kind, raw) {
  const text = String(raw ?? '').trim();
  const spec = {
    premium: { min: 0, max: 500, fallback: 25, blank: 'fallback', unit: '%' },
    ladderBands: { min: 0, max: CLASSIC_LADDER_MAX_BANDS, fallback: 0, blank: 'zero', whole: true, unit: ' bands' },
    supportSol: { min: 0, max: Infinity, fallback: 0, blank: 'zero', unit: ' SOL' },
  }[kind];
  if (!spec) return { value: Number(raw), issue: null };
  const range = Number.isFinite(spec.max) ? `0 to ${spec.max}` : '0 or more';
  if (!text) {
    return spec.blank === 'zero'
      ? { value: 0, issue: null }
      : { value: spec.fallback, issue: `Enter a number from ${range}. Using ${spec.fallback}${spec.unit}.` };
  }
  const number = parseNumericInput(text, NaN);
  if (!Number.isFinite(number)) return { value: spec.fallback, issue: `"${text.slice(0, 12)}" is not a number. Using ${spec.fallback}${spec.unit}.` };
  if (number < spec.min) return { value: spec.min, issue: `Cannot be below ${spec.min}. Using ${spec.min}${spec.unit}.` };
  if (number > spec.max) return { value: spec.max, issue: `The most allowed is ${spec.max}${spec.unit}. Using ${spec.max}${spec.unit}.` };
  if (spec.whole && !Number.isInteger(number)) return { value: Math.floor(number), issue: `Whole numbers only. Using ${Math.floor(number)}.` };
  return { value: number, issue: null };
}

function isProbablySolanaAddress(value) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(value || '').trim());
}

function parseManualLadderBands(value) {
  return analyzeManualLadder(value).bands;
}

// Reads the custom ladder text. Lines it cannot use are listed in `rejected`
// (1-based line numbers) so the panel can say which ones were skipped.
// Blank lines, # comments and a header line are skipped on purpose.
function analyzeManualLadder(value) {
  const bands = [];
  const rejected = [];
  String(value || '')
    .split(/\r?\n/)
    .forEach((rawLine, lineIndex) => {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) return;
      const parts = line.split(/[,\t ]+/).map((part) => part.trim()).filter(Boolean);
      if (!parts.length || /supply/i.test(parts[0])) return;
      const supplyPercent = parseNumericInput(parts[0], NaN);
      const lowerMultiplier = parseNumericInput(parts[1], NaN);
      const upperMultiplier = parseNumericInput(parts[2], NaN);
      if (
        Number.isFinite(supplyPercent)
        && supplyPercent > 0
        && Number.isFinite(lowerMultiplier)
        && lowerMultiplier >= 1
        && Number.isFinite(upperMultiplier)
        && upperMultiplier > lowerMultiplier
      ) {
        bands.push({
          supplyPercent: Number(supplyPercent.toFixed(4)),
          lowerMultiplier: Number(lowerMultiplier.toFixed(4)),
          upperMultiplier: Number(upperMultiplier.toFixed(4)),
        });
      } else {
        rejected.push({ line: lineIndex + 1, text: line });
      }
    });
  return { bands, rejected };
}

function classicSimpleLadderConfig(bandCount) {
  const count = Math.floor(Number(bandCount || 0));
  if (count <= 0) return { mode: 'off' };
  return {
    mode: 'simple',
    bandCount: count,
    supplyPercent: CLASSIC_LADDER_DEFAULT_SUPPLY_PERCENT,
    ceilingMultiplier: CLASSIC_LADDER_DEFAULT_CEILING_MULTIPLIER,
  };
}

function parseAirdropCsv(text) {
  const recipientsByWallet = new Map();
  const errors = [];
  String(text || '')
    .split(/\r?\n/)
    .forEach((rawLine, index) => {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) return;
      const parts = line.split(/[,\t]/).map((part) => part.trim()).filter(Boolean);
      if (!parts.length) return;
      if (index === 0 && /wallet|address|recipient/i.test(parts[0])) return;
      const wallet = parts[0];
      if (!isProbablySolanaAddress(wallet)) {
        errors.push(`line ${index + 1}: wallet does not look like a Solana address`);
        return;
      }
      const tokenAmount = parts[1] == null || parts[1] === ''
        ? null
        : parseNumericInput(parts[1], NaN);
      if (tokenAmount != null && (!Number.isFinite(tokenAmount) || tokenAmount < 0)) {
        errors.push(`line ${index + 1}: token amount is invalid`);
        return;
      }
      const previous = recipientsByWallet.get(wallet);
      if (previous) {
        previous.tokens = previous.tokens == null || tokenAmount == null
          ? previous.tokens ?? tokenAmount
          : previous.tokens + tokenAmount;
      } else {
        recipientsByWallet.set(wallet, { wallet, tokens: tokenAmount });
      }
    });
  return {
    recipients: [...recipientsByWallet.values()],
    error: errors[0] || null,
    errorCount: errors.length,
  };
}

function computeAirdropExecutionCostSol(recipientCount) {
  return TrebuchetCore.estimateAirdropExecutionCostSol(recipientCount);
}

function ceilPercentTenth(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(99, Math.ceil(number * 10) / 10);
}

function currentAirdropBudgetConfig() {
  const percentInput = document.getElementById('airdropSupplyPercent');
  const autoFitInput = document.getElementById('airdropAutoFit');
  return {
    requestedSupplyPercent: parsePercentInput(percentInput?.value, 2),
    autoFit: autoFitInput ? autoFitInput.checked !== false : true,
  };
}

function computeAirdropBudget(parsedRecipients, recipientCount, supply, requestedSupplyPercent, autoFit) {
  const explicitTokens = parsedRecipients.reduce(
    (sum, row) => sum + (row.tokens == null ? 0 : Number(row.tokens) || 0),
    0,
  );
  const blankRecipientCount = parsedRecipients.filter((row) => row.tokens == null).length;
  const requiredSupplyPercent = supply > 0 && explicitTokens > 0
    ? ceilPercentTenth((explicitTokens / supply) * 100)
    : 0;
  const effectiveSupplyPercent = recipientCount > 0
    ? autoFit ? Math.max(requestedSupplyPercent, requiredSupplyPercent) : requestedSupplyPercent
    : 0;
  const budgetTokens = supply * (effectiveSupplyPercent / 100);
  const remainingTokens = budgetTokens - explicitTokens;
  const overBudget = explicitTokens > budgetTokens + 0.000001;
  const equalTokens = blankRecipientCount > 0
    ? Math.max(0, remainingTokens) / blankRecipientCount
    : 0;

  return {
    requestedSupplyPercent,
    requiredSupplyPercent,
    supplyPercent: effectiveSupplyPercent,
    autoFit,
    budgetTokens,
    explicitTokens,
    remainingTokens,
    blankRecipientCount,
    equalTokens,
    overBudget,
    executionCostSol: computeAirdropExecutionCostSol(recipientCount),
    budgetError: overBudget
      ? `CSV token amounts need ${requiredSupplyPercent.toFixed(requiredSupplyPercent % 1 === 0 ? 0 : 1)}% of supply. Enable Auto-fit, raise the budget, or reduce recipient amounts.`
      : null,
  };
}

// Held-back tokens can be shared with the wallets that funded the launch,
// split by the SOL each sent. Only wallets in the current funder list count,
// so a choice never outlives the launch wallet or environment it was made
// for (Practice funders can never reach a Live launch). Wallets already in
// the airdrop CSV keep their CSV row instead.
function heldSharePlan(supply = parseWholeNumber($('#tokenSupply')?.value) || 1000000000) {
  const heldPercent = parsePercentInput($('#preallocationSupplyPercent')?.value, 0);
  const csvWallets = new Set(parseAirdropCsv(state.airdropCsvText).recipients.map((row) => row.wallet));
  const known = new Map((state.destinations.funders || []).map((entry) => [entry.address, entry]));
  const funders = (state.heldShare.selected || [])
    .map((address) => known.get(address))
    .filter((entry) => entry && entry.sol > 0 && !csvWallets.has(entry.address));
  const totalSol = funders.reduce((sum, entry) => sum + entry.sol, 0);
  if (!(heldPercent > 0) || !funders.length || !(totalSol > 0)) {
    return { active: false, heldPercent, funders, csvWallets, rows: [], heldTokens: 0, totalSol: 0 };
  }
  const heldTokens = Math.floor(supply * (heldPercent / 100));
  // Whole tokens; rounding dust stays with the main return wallet's sweep.
  const rows = funders.map((entry) => ({
    wallet: entry.address,
    tokens: Math.floor(heldTokens * (entry.sol / totalSol)),
    source: 'funder',
    fundedSol: entry.sol,
  }));
  return { active: true, heldPercent, funders, csvWallets, rows, heldTokens, totalSol };
}

// Once a live token exists, the airdrop recipients are bound to its plan.
function heldShareLocked() {
  if (state.demoActive) return false;
  return Boolean(currentLaunchProof()?.token?.mint || state.lastRunEnvelope?.status === 'armed');
}

function toggleHeldShareFunder(address) {
  if (heldShareLocked()) {
    notify('Recipients are locked once the token is created');
    return;
  }
  const selected = new Set(state.heldShare.selected || []);
  if (selected.has(address)) selected.delete(address);
  else selected.add(address);
  state.heldShare = { selected: [...selected] };
  invalidateClassicOutputs();
  renderAll();
}

function currentAirdropPlan() {
  const parsed = parseAirdropCsv(state.airdropCsvText);
  const manualCount = parsePositiveInteger($('#airdropWallets').value, 0);
  const supply = parseWholeNumber($('#tokenSupply').value) || 1000000000;
  const share = heldSharePlan(supply);
  const csvCount = parsed.recipients.length || manualCount;
  const recipientCount = csvCount + share.rows.length;
  const enabled = recipientCount > 0;
  const budgetConfig = currentAirdropBudgetConfig();
  const budget = computeAirdropBudget(
    [...parsed.recipients, ...share.rows],
    recipientCount,
    supply,
    (csvCount > 0 ? budgetConfig.requestedSupplyPercent : 0) + (share.active ? share.heldPercent : 0),
    budgetConfig.autoFit,
  );
  const recipients = [
    ...parsed.recipients.map((row) => ({
      wallet: row.wallet,
      tokens: Number((row.tokens == null ? budget.equalTokens : row.tokens).toFixed(9)),
    })),
    ...share.rows,
  ];
  state.airdropParseError = parsed.error;
  state.airdropRecipients = recipients;
  state.airdropBudgetError = budget.budgetError;
  return {
    enabled,
    recipientCount,
    supplyPercent: budget.supplyPercent,
    requestedSupplyPercent: budget.requestedSupplyPercent,
    requiredSupplyPercent: budget.requiredSupplyPercent,
    autoFit: budget.autoFit,
    source: parsed.recipients.length ? 'csv' : manualCount ? 'manual-count' : share.active ? 'funders' : 'off',
    csvRecipientCount: csvCount,
    funderShareCount: share.rows.length,
    funderSharePercent: share.active ? share.heldPercent : 0,
    recipients,
    parseError: parsed.error,
    parseErrorCount: parsed.errorCount,
    budgetError: budget.budgetError,
    budgetTokens: budget.budgetTokens,
    explicitTokens: budget.explicitTokens,
    remainingTokens: budget.remainingTokens,
    blankRecipientCount: budget.blankRecipientCount,
    executionCostSol: budget.executionCostSol,
    totalTokens: recipients.reduce((sum, row) => sum + (Number(row.tokens) || 0), 0),
  };
}

function currentPreallocationPlan() {
  const input = document.getElementById('preallocationSupplyPercent');
  const supplyPercent = parsePercentInput(input?.value, 0);
  // Shared with funding wallets: the airdrop carries this slice instead.
  if (supplyPercent > 0 && heldSharePlan().active) {
    return { enabled: false, supplyPercent: 0, source: 'funder-share', sharedPercent: supplyPercent };
  }
  return {
    enabled: supplyPercent > 0,
    supplyPercent,
    source: supplyPercent > 0 ? 'held-reserve' : 'off',
  };
}

function compactAmount(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return '0';
  return new Intl.NumberFormat(undefined, {
    notation: amount >= 1000000 ? 'compact' : 'standard',
    maximumFractionDigits: amount >= 1000000 ? 1 : 0,
  }).format(amount);
}

// Addresses are shown in full wherever there is room (fullAddress). The
// short form is only for tight spots, and it is remembered (shortAddressFull,
// below) so that clicking it still copies the whole address.
function shortAddress(value) {
  const text = String(value || '');
  if (text.length <= 12) return text || 'Unknown';
  const short = window.TrebuchetV2Api?.shortAddress
    ? window.TrebuchetV2Api.shortAddress(text)
    : `${text.slice(0, 4)}...${text.slice(-4)}`;
  if (short !== text) {
    shortAddressFull.set(short, text);
    if (shortAddressFull.size > 2000) shortAddressFull.delete(shortAddressFull.keys().next().value);
  }
  return short;
}

function fullAddress(value) {
  const text = String(value || '').trim();
  return text || 'Unknown';
}

const shortAddressFull = new Map();
