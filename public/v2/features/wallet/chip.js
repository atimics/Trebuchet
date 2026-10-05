// A wallet address anywhere on the page is one chip. Hovering or focusing it shows a small card:
// what the wallet holds now, read from the chain, and whether Trebuchet holds its key.

const WALLET_CONTENTS_MAX_AGE_MS = 15_000;
// The sweep drains to zero, so anything above a few transaction fees is worth sending on.
const SWEEP_DUST_LAMPORTS = 20_000;
const walletContentsCache = new Map();

function walletChipHtml(address, { label = '' } = {}) {
  const value = String(address || '').trim();
  if (!value) return '';
  return `<span class="wallet-chip" tabindex="0" data-wallet-chip="${escapeHtml(value)}" title="${escapeHtml(value)}">`
    + `<code>${escapeHtml(shortAddress(value))}</code>${label ? `<small>${escapeHtml(label)}</small>` : ''}</span>`;
}

function walletContents(address, { fresh = false } = {}) {
  const cached = walletContentsCache.get(address);
  if (!fresh && cached && (cached.pending || Date.now() - cached.at < WALLET_CONTENTS_MAX_AGE_MS)) return cached.pending || Promise.resolve(cached.value);
  if (state.apiStatus !== 'connected' || !state.apiClient?.getWalletContents) return Promise.resolve(null);
  const pending = state.apiClient.getWalletContents(address, { fresh })
    .then((value) => { walletContentsCache.set(address, { at: Date.now(), value }); return value; })
    .catch((error) => { walletContentsCache.delete(address); throw error; });
  walletContentsCache.set(address, { ...(cached || {}), pending });
  return pending;
}

function cachedWalletContents(address) {
  return walletContentsCache.get(address)?.value || null;
}

function walletTokenSymbol(mint) {
  return (state.coins?.list || []).find((coin) => coin.mint === mint)?.symbol || shortAddress(mint);
}

function formatSol(lamports) {
  return Number((Number(lamports || 0) / 1e9).toFixed(6)).toString();
}

// The sweep moves tokens and SOL, and closes empty token accounts to return their rent.
function walletSweepable(contents) {
  return Boolean(contents && contents.ownerProgram === '11111111111111111111111111111111'
    && (contents.tokens.length > 0 || contents.lamports >= SWEEP_DUST_LAMPORTS || contents.openAccounts > 0));
}

function walletContentsSummary(contents) {
  if (!contents) return '';
  return [
    `${formatSol(contents.lamports)} SOL`,
    contents.tokens.length ? `${contents.tokens.length} token${contents.tokens.length === 1 ? '' : 's'}` : null,
    contents.openAccounts ? `${contents.openAccounts} open account${contents.openAccounts === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');
}

const WALLET_KEY_LABELS = { launch: 'Launch wallet', retired: 'Finished launch wallet', vanity: 'Vanity address' };
const WALLET_CARD_WIDTH = 280;

// A fixed-size card: what the wallet is, its value, what it is made of (a bar and the top three
// holdings by value), and how many more. Values come from prices the app already has.
const WALLET_CARD_TOP = 3;

function formatUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (number >= 1000) return `$${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(number)}`;
  if (number >= 1) return `$${number.toFixed(2)}`;
  if (number > 0) return `$${number.toPrecision(2)}`;
  return '$0';
}

function walletComposition(contents) {
  const solAmount = Number(contents.lamports || 0) / 1e9;
  const holdings = [
    { name: 'SOL', amount: solAmount, valueUsd: contents.solUsd != null ? solAmount * contents.solUsd : null, sol: true },
    ...contents.tokens.map((token) => ({
      name: token.symbol || walletTokenSymbol(token.mint),
      amount: Number(token.amountRaw) / 10 ** Number(token.decimals || 0),
      valueUsd: token.valueUsd ?? null,
    })),
  ].filter((holding) => holding.amount > 0);
  // Priced holdings by value first, then the rest as listed.
  holdings.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
  const priced = holdings.filter((holding) => holding.valueUsd != null);
  const totalUsd = priced.reduce((sum, holding) => sum + holding.valueUsd, 0);
  return { holdings, totalUsd: priced.length ? totalUsd : null, unpriced: holdings.length - priced.length };
}

function walletCardHtml(address, contents, error) {
  const kind = contents?.ownerProgram && contents.ownerProgram !== '11111111111111111111111111111111' && contents.lamports
    ? 'Program account'
    : contents?.key ? WALLET_KEY_LABELS[contents.key] : contents ? 'Key not in Trebuchet' : '';
  const head = `<header><code title="${escapeHtml(address)}">${escapeHtml(shortAddress(address))}</code>${kind ? `<span>${escapeHtml(kind)}${contents?.key ? ' · key held' : ''}</span>` : ''}</header>`;
  const foot = (extra = '') => `<footer>${extra}<a href="${escapeHtml(solscanAccountUrl(address))}" target="_blank" rel="noopener">Solscan</a></footer>`;
  if (error) return `${head}<p class="wallet-card-body is-error">${escapeHtml(error)}</p>${foot()}`;
  if (!contents) return `${head}<p class="wallet-card-body"><span class="rail-spin" aria-hidden="true"></span></p>${foot()}`;
  const { holdings, totalUsd, unpriced } = walletComposition(contents);
  if (!holdings.length) {
    return `${head}<p class="wallet-card-body wallet-card-empty">Empty</p>${foot(contents.openAccounts ? `<span>${contents.openAccounts} open account${contents.openAccounts === 1 ? '' : 's'}</span>` : '')}`;
  }
  const top = holdings.slice(0, WALLET_CARD_TOP);
  const more = holdings.length - top.length;
  const share = (holding) => (totalUsd && holding.valueUsd != null ? holding.valueUsd / totalUsd : null);
  const bar = totalUsd
    ? `<div class="wallet-card-bar" aria-hidden="true">${top.map((holding, index) => `<span class="is-${index}" style="width:${Math.max(2, (share(holding) || 0) * 100)}%"></span>`).join('')}<span class="is-rest"></span></div>`
    : '';
  const rows = top.map((holding, index) => `<li><i class="is-${index}" aria-hidden="true"></i><span>${escapeHtml(holding.name)}</span><b>${escapeHtml(holding.sol ? formatSol(contents.lamports) : compactAmount(holding.amount))}</b><small>${share(holding) != null ? `${Math.round(share(holding) * 100)}%` : formatUsd(holding.valueUsd) || ''}</small></li>`).join('');
  const value = totalUsd != null ? `${formatUsd(totalUsd)}${unpriced ? ` + ${unpriced} unpriced` : ''}` : `${holdings.length} holding${holdings.length === 1 ? '' : 's'}`;
  return `${head}
    <div class="wallet-card-body"><strong class="wallet-card-value">${escapeHtml(value)}</strong>${bar}<ul>${rows}</ul></div>
    ${foot([more ? `<span>+${more} more</span>` : '', contents.openAccounts ? `<span>${contents.openAccounts} open account${contents.openAccounts === 1 ? '' : 's'}</span>` : ''].join(''))}`;
}

function walletChipCard() {
  let card = document.getElementById('walletChipCard');
  if (!card) {
    card = document.createElement('div');
    card.id = 'walletChipCard';
    card.className = 'wallet-chip-card';
    card.setAttribute('role', 'tooltip');
    card.hidden = true;
    card.addEventListener('mouseleave', () => hideWalletChipCard());
    document.body.appendChild(card);
  }
  return card;
}

let walletChipTarget = null;
let walletChipHideTimer = null;

function placeWalletChipCard(card, chip) {
  const box = chip.getBoundingClientRect();
  const width = Math.min(WALLET_CARD_WIDTH, window.innerWidth - 32);
  card.style.width = `${width}px`;
  card.style.left = `${Math.max(16, Math.min(box.left, window.innerWidth - width - 16))}px`;
  const below = box.bottom + 6;
  card.style.top = `${below + card.offsetHeight > window.innerHeight - 8 ? Math.max(8, box.top - card.offsetHeight - 6) : below}px`;
}

function showWalletChipCard(chip) {
  clearTimeout(walletChipHideTimer);
  const address = chip.dataset.walletChip;
  const card = walletChipCard();
  walletChipTarget = chip;
  chip.setAttribute('aria-describedby', 'walletChipCard');
  card.innerHTML = walletCardHtml(address, cachedWalletContents(address), null);
  card.hidden = false;
  placeWalletChipCard(card, chip);
  walletContents(address)
    .then((contents) => { if (walletChipTarget === chip) { card.innerHTML = walletCardHtml(address, contents, null); placeWalletChipCard(card, chip); } })
    .catch((error) => { if (walletChipTarget === chip) card.innerHTML = walletCardHtml(address, null, error.message || 'Could not read this wallet'); });
}

function hideWalletChipCard({ now = false } = {}) {
  clearTimeout(walletChipHideTimer);
  const hide = () => {
    const card = document.getElementById('walletChipCard');
    if (card && !card.matches(':hover')) card.hidden = true;
    walletChipTarget?.removeAttribute('aria-describedby');
    walletChipTarget = null;
  };
  if (now) hide(); else walletChipHideTimer = setTimeout(hide, 150);
}

function bindWalletChips() {
  document.addEventListener('mouseover', (event) => {
    const chip = event.target.closest?.('[data-wallet-chip]');
    if (chip && chip !== walletChipTarget) showWalletChipCard(chip);
  });
  document.addEventListener('mouseout', (event) => {
    const chip = event.target.closest?.('[data-wallet-chip]');
    if (chip && !chip.contains(event.relatedTarget) && !event.relatedTarget?.closest?.('#walletChipCard')) hideWalletChipCard();
  });
  document.addEventListener('focusin', (event) => {
    const chip = event.target.closest?.('[data-wallet-chip]');
    if (chip) showWalletChipCard(chip);
  });
  document.addEventListener('focusout', (event) => {
    if (event.target.closest?.('[data-wallet-chip]')) hideWalletChipCard();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && walletChipTarget) hideWalletChipCard({ now: true });
  });
}
