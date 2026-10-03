// The launch wallet's balances, laid against what the launch needs (Fund) or
// what can be taken back (Recover), and the worth of each airdrop wallet.

const LEDGER_FRESH_MS = 30000;

// Reads the chain for the launch wallet at most every 30 seconds, only while the
// Fund or Recover tab is open. The refresh redraws the panels that show it.
function ensureLaunchWalletBalance() {
  if (state.demoActive) return;
  const walletPublicKey = selectedLaunchWalletPublicKey();
  if (!walletPublicKey || state.apiStatus !== 'connected') return;
  const prefund = state.manualPrefund || {};
  if (prefund.polling) return;
  const age = Date.now() - Date.parse(prefund.lastUpdatedAt || '');
  if (prefund.walletPublicKey === walletPublicKey && Number.isFinite(age) && age < LEDGER_FRESH_MS) return;
  window.setTimeout(() => { refreshManualPrefundBalance({ quiet: true }).catch(() => null); }, 0);
}

function ledgerTokenSymbol(mint, token = {}) {
  const coin = (state.coins?.list || []).find((item) => item.mint === mint);
  return coin?.symbol || token.symbol || shortAddress(mint);
}

function ledgerAmount(value, digits = 4) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  if (amount >= 1000000) return compactAmount(amount);
  return amount.toLocaleString(undefined, { maximumFractionDigits: amount >= 1000 ? 0 : digits });
}

function ledgerRowHtml({ symbol, held, needed = null, note = '', tone = '' }) {
  const status = needed == null
    ? (note ? `<em>${escapeHtml(note)}</em>` : '<em></em>')
    : Number(held) + 1e-9 >= Number(needed)
      ? '<em class="is-ok"><i class="fa-solid fa-check" aria-hidden="true"></i> enough</em>'
      : `<em class="is-short">needs ${escapeHtml(ledgerAmount(Number(needed) - Number(held)))} more</em>`;
  return `<div class="ledger-row${tone ? ` is-${tone}` : ''}"><span>${escapeHtml(symbol)}</span><b>${escapeHtml(ledgerAmount(held))}</b>${needed == null ? `<small></small>${status}` : `<small>of ${escapeHtml(ledgerAmount(needed))}</small>${status}`}</div>`;
}

function ledgerBalance() {
  const snapshot = selectedWalletDetailedBalance();
  return snapshot?.balance || null;
}

function ledgerShell(head, rows, foot = '') {
  return `<section class="ledger" aria-label="${escapeHtml(head)}"><div class="ledger-head"><span>${escapeHtml(head)}</span></div>${rows}${foot}</section>`;
}

// Fund: SOL and every pair token the plan has to hold, against what the wallet holds.
function fundLedgerHtml() {
  if (state.demoActive) return '';
  if (!selectedLaunchWalletPublicKey()) return '';
  const balance = ledgerBalance();
  if (!balance) return ledgerShell('In the wallet', '<div class="ledger-row"><span>Reading the chain…</span></div>');
  const estimate = classicFundingEstimateStatus(currentLaunchConfig()).matchesConfig ? state.classicFundingEstimate : null;
  const rows = [ledgerRowHtml({
    symbol: 'SOL',
    held: balance.sol,
    needed: estimate?.totalSol != null ? Number(estimate.totalSol) : null,
    note: estimate ? '' : 'not estimated',
  })];
  quoteManualPrefundItems().forEach((item) => {
    const token = balance.tokens?.[item.mint];
    rows.push(ledgerRowHtml({
      symbol: item.symbol,
      held: Number(token?.amountUi) || 0,
      needed: item.amount,
      note: item.amount == null ? 'not estimated' : '',
    }));
  });
  return ledgerShell('In the wallet', rows.join(''));
}

// Recover: everything the wallet holds that a sweep would return.
function recoverLedgerHtml() {
  if (state.demoActive) return '';
  if (!selectedLaunchWalletPublicKey()) return '';
  const balance = ledgerBalance();
  if (!balance) return ledgerShell('Can be returned', '<div class="ledger-row"><span>Reading the chain…</span></div>');
  const launchMint = typeof proofTokenMint === 'function' ? proofTokenMint(currentLaunchProof()) : null;
  const tokens = Object.entries(balance.tokens && typeof balance.tokens === 'object' ? balance.tokens : {})
    .filter(([, token]) => Number(token?.amountUi) > 0)
    .map(([mint, token]) => ({ mint, symbol: ledgerTokenSymbol(mint, token), amount: Number(token.amountUi) }))
    .sort((a, b) => (b.mint === launchMint) - (a.mint === launchMint) || b.amount - a.amount);
  const rows = [ledgerRowHtml({ symbol: 'SOL', held: balance.sol })]
    .concat(tokens.map((token) => ledgerRowHtml({
      symbol: token.symbol,
      held: token.amount,
      note: token.mint === launchMint ? 'launch token' : '',
    })));
  return ledgerShell('Can be returned', rows.join(''));
}

function renderRecoverLedger() {
  const slot = $('#recoverLedger');
  if (slot) slot.innerHTML = recoverLedgerHtml();
}

// Tab summary: what the wallet holds, in a few words.
function launchWalletHoldingsSummary() {
  if (!selectedLaunchWalletPublicKey()) return 'No wallet';
  const balance = ledgerBalance();
  if (!balance) return 'Not checked';
  const tokenCount = Object.values(balance.tokens || {}).filter((token) => Number(token?.amountUi) > 0).length;
  return `${ledgerAmount(balance.sol)} SOL${tokenCount ? ` · ${tokenCount} token${tokenCount === 1 ? '' : 's'}` : ''}`;
}

// Airdrop: each wallet's tokens, its share of the airdrop, and what that is worth
// at the launch market cap.
function airdropValueHtml(airdrop) {
  const recipients = Array.isArray(airdrop?.recipients) ? airdrop.recipients : [];
  if (!recipients.length) return '';
  const supply = parseWholeNumber($('#tokenSupply')?.value) || 0;
  const marketCap = Math.max(0, Number(currentClassicModel().targetMarketCapUsd) || 0);
  const total = recipients.reduce((sum, row) => sum + (Number(row.tokens) || 0), 0);
  const usd = (tokens) => (supply > 0 && marketCap > 0 ? (tokens / supply) * marketCap : null);
  const money = (value) => (value == null ? '—' : `$${value >= 100 ? Math.round(value).toLocaleString() : value.toFixed(2)}`);
  const biggest = Math.max(...recipients.map((row) => Number(row.tokens) || 0), 1);
  const shown = recipients.slice(0, 8).map((row) => {
    const tokens = Number(row.tokens) || 0;
    const share = total > 0 ? (tokens / total) * 100 : 0;
    return `<div class="airdrop-value-row${row.source === 'funder' ? ' is-funder' : ''}" title="${escapeHtml(row.wallet || '')}">
      <span class="airdrop-value-bar" style="width:${Math.max(2, (tokens / biggest) * 100)}%"></span>
      <code>${escapeHtml(shortAddress(row.wallet))}</code>
      <span>${escapeHtml(compactAmount(tokens))}</span>
      <small>${escapeHtml(formatPercent(share))}%</small>
      <b>${escapeHtml(money(usd(tokens)))}</b>
    </div>`;
  }).join('');
  const more = recipients.length > 8 ? `<div class="airdrop-value-more">+${recipients.length - 8} more</div>` : '';
  return `<div class="airdrop-value-head"><span>${recipients.length} wallet${recipients.length === 1 ? '' : 's'}</span><span>${escapeHtml(compactAmount(total))} tokens</span><b>${escapeHtml(money(usd(total)))} at launch price</b></div>${shown}${more}`;
}
