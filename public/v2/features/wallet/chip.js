// A wallet address anywhere on the page is one chip. Hovering or focusing it shows what the
// wallet holds now, read from the chain: SOL, each token, and open token accounts with their
// rent. It also says whether Trebuchet holds the wallet's key.

const WALLET_CONTENTS_MAX_AGE_MS = 15_000;
const SWEEP_DUST_LAMPORTS = 1_000_000;
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

function walletSweepable(contents) {
  return Boolean(contents && contents.ownerProgram === '11111111111111111111111111111111'
    && (contents.tokens.length > 0 || contents.lamports >= SWEEP_DUST_LAMPORTS));
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

function walletCardHtml(address, contents, error) {
  const rows = contents ? [
    ['SOL', formatSol(contents.lamports)],
    ...contents.tokens.map((token) => [walletTokenSymbol(token.mint), formatTokenAmount(token.amountRaw, token.decimals)]),
    contents.openAccounts ? ['Open token accounts', `${contents.openAccounts} · ${formatSol(contents.accountRentLamports)} SOL rent`] : null,
  ].filter(Boolean) : [];
  const kind = contents?.ownerProgram && contents.ownerProgram !== '11111111111111111111111111111111' && contents.lamports
    ? 'Program account'
    : contents?.key ? `${WALLET_KEY_LABELS[contents.key]} · key in Trebuchet` : contents ? 'Key not in Trebuchet' : '';
  return `
    <header><code>${escapeHtml(address)}</code>${kind ? `<span>${escapeHtml(kind)}</span>` : ''}</header>
    ${error ? `<p class="is-error">${escapeHtml(error)}</p>` : contents ? `<dl>${rows.map(([name, value]) => `<div><dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>` : '<p><span class="rail-spin" aria-hidden="true"></span></p>'}
    <a href="${escapeHtml(solscanAccountUrl(address))}" target="_blank" rel="noopener">Solscan</a>`;
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
  const width = Math.min(340, window.innerWidth - 32);
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
