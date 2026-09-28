// ---------------------------------------------------------------------------
// Quick Launch — the streamlined one-batch recipe (CPMM + Token-2022 native).
// Uses the same cost ledger as the CLI and execution planner.
// ---------------------------------------------------------------------------

let QUICK_SOL_USD = 150;

function quickLaunchLedger(quoteSymbol) {
  const quote = String(quoteSymbol || 'SOL').toUpperCase();
  const ledger = TrebuchetCore.buildStreamlinedLedger({ quotes: [quote], poolCount: 1, solUsd: QUICK_SOL_USD });
  const labels = [
    'Create pool',
    'LP + vault accounts',
    'Deposit & lock',
    'Network fee',
    quote === 'SOL' ? 'Start liquidity (SOL)' : 'Start liquidity (swapped in)',
    'Token creation',
  ];
  return {
    lines: ledger.lines.map((line, index) => ({ ...line, label: labels[index] || line.label })),
    subtotal: ledger.subtotalSol,
    variance: ledger.varianceSol,
    total: ledger.totalSol,
  };
}

async function refreshQuickLaunchPrice() {
  // A page opened from disk has no server to ask.
  if (globalThis.location?.protocol === 'file:') return;
  try {
    const response = await fetch('/api/price', { signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined });
    if (!response.ok || !response.json) return;
    const payload = await response.json();
    const usd = Number(payload?.solana?.usd);
    if (Number.isFinite(usd) && usd > 0) {
      QUICK_SOL_USD = usd;
      renderQuickLaunchCost();
    }
  } catch (_error) {
    // Static host or offline preview: keep the bundled fallback (150).
  }
}

function quickLaunchFeeParams() {
  const bps = Number($('#quickFee')?.value || 0);
  const treasury = ($('#quickTreasury')?.value || '').trim();
  return { bps, treasury };
}

function renderQuickLaunchCost() {
  const cost = $('#quickCost');
  if (!cost) return;
  const quote = $('#quickQuote')?.value || 'SOL';
  const ledger = quickLaunchLedger(quote);
  const { bps, treasury } = quickLaunchFeeParams();
  if (bps > 0) {
    ledger.lines.push({
      label: treasury
        ? `Swap fees ${(bps / 100).toFixed(2)}% → treasury`
        : 'Swap fees (% rate set)',
      sol: 0,
    });
  }
  const rows = ledger.lines.map((line) => (
    `<div class="quick-cost-row"><span>${escapeHtml(line.label)}</span><strong>${line.sol.toFixed(4)} SOL</strong></div>`
  )).join('');
  cost.innerHTML = `
    <div class="quick-cost-grid">
      ${rows}
      <div class="quick-cost-row"><span>Small buffer (${(ledger.variance / ledger.subtotal * 100).toFixed(0)}%)</span><strong>${ledger.variance.toFixed(4)}</strong></div>
      <div class="quick-cost-row quick-cost-total"><span>Total launch cost</span><strong>${ledger.total.toFixed(4)} SOL</strong></div>

    </div>`;
  const nameInput = $('#quickTokenName');
  const launchName = $('#launchName');
  if (nameInput && launchName) {
    launchName.textContent = `${nameInput.value.trim() || 'Untitled'} launch`;
  }
}

function quickLaunchDemoRun() {
  const log = $('#quickLaunchLog');
  const button = document.querySelector('[data-action="quick-launch-run"]');
  if (!log || !button || button.getAttribute('aria-busy') === 'true') return;
  button.setAttribute('aria-busy', 'true');
  button.querySelector('span').textContent = 'Preparing your launch…';
  log.hidden = false;

  const symbol = ($('#quickTokenSymbol')?.value || 'TOK').toUpperCase().slice(0, 10) || 'TOK';
  const quote = $('#quickQuote')?.value || 'SOL';
  const { bps, treasury } = quickLaunchFeeParams();
  const steps = [
    `Create ${symbol} token`,
    `Open the ${quote} pool`,
    `Create LP and vault accounts`,
    `Add ${quote} + ${symbol} liquidity`,
  ];
  if (bps > 0) {
    steps.push(`Add swap fees (${(bps / 100).toFixed(2)}%)${treasury ? ` → ${shortAddress(treasury)}` : ''}`);
  }
  steps.push(`Lock the liquidity`);
  log.innerHTML = steps.map((step) => `<li class="is-todo">${escapeHtml(step)}</li>`).join('');
  const items = [...log.querySelectorAll('li')];
  items.forEach((item, index) => {
    setTimeout(() => {
      item.classList.remove('is-todo');
      item.classList.add('is-done');
      if (index === items.length - 1) {
        button.setAttribute('aria-busy', 'false');
        button.querySelector('span').textContent = 'Launch ready';
        const badge = $('#launchStatus');
        if (badge) badge.textContent = 'Armed';
      }
    }, 150 * (index + 1));
  });
}
