// A coin's card: its price and a pie of how its liquidity splits across its pools. It opens on
// hovering or focusing anything marked data-token-card (a coin in the list, a token symbol), and
// the coin page header shows the price and a small pie inline. Reads are kept a minute and only
// made for what is hovered or on screen.

const TOKEN_CARD_MAX_AGE_MS = 60_000;
const TOKEN_CARD_HOVER_DELAY_MS = 250;
const TOKEN_CARD_WIDTH = 300;
const TOKEN_CARD_SLICES = 4;
const tokenCardCache = new Map();

function tokenCardEligible(mint) {
  const value = String(mint || '').trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) && !value.startsWith('Demo');
}

function tokenSymbolHtml(mint, symbol) {
  const text = escapeHtml(symbol || shortAddress(mint));
  if (!tokenCardEligible(mint)) return `<span>${text}</span>`;
  return `<span class="token-symbol" tabindex="0" data-token-card="${escapeHtml(mint)}">${text}</span>`;
}

function tokenCardData(mint) {
  const cached = tokenCardCache.get(mint);
  if (cached && (cached.pending || Date.now() - cached.at < TOKEN_CARD_MAX_AGE_MS)) return cached.pending || Promise.resolve(cached.value);
  if (state.apiStatus !== 'connected' || !state.apiClient?.getTokenCard) return Promise.resolve(null);
  const pending = state.apiClient.getTokenCard(mint)
    .then((response) => { tokenCardCache.set(mint, { at: Date.now(), value: response.card }); return response.card; })
    .catch((error) => { tokenCardCache.set(mint, { at: Date.now(), error: error.message || 'Could not read this coin' }); throw error; });
  tokenCardCache.set(mint, { ...(cached || {}), pending });
  return pending;
}

function formatTokenPrice(card) {
  if (!card || card.priceSol === null || card.priceSol === undefined) return null;
  if (card.priceUsd !== null && card.priceUsd !== undefined) {
    const usd = Number(card.priceUsd);
    return usd >= 1 ? `$${usd.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : `$${usd.toPrecision(3)}`;
  }
  return `${Number(card.priceSol).toPrecision(3)} SOL`;
}

// Up to four pools by size, then the rest as one slice.
function tokenCardSlices(card) {
  const pools = (card?.pools || []).filter((pool) => pool.share > 0);
  const top = pools.slice(0, TOKEN_CARD_SLICES).map((pool, index) => ({
    label: pool.quoteSymbol || shortAddress(pool.quoteMint || pool.poolId),
    venue: pool.venue === 'meteora-damm-v2' ? 'Meteora' : 'Raydium',
    share: pool.share,
    tone: `is-${index}`,
  }));
  const rest = pools.slice(TOKEN_CARD_SLICES).reduce((sum, pool) => sum + pool.share, 0);
  if (rest > 0) top.push({ label: `${pools.length - TOKEN_CARD_SLICES} more`, venue: '', share: rest, tone: 'is-rest' });
  return top;
}

// A ring of stroked arcs: each slice is a dash on one circle, offset by the slices before it.
function tokenPieSvg(slices, size) {
  const radius = 15.9155; // a circumference of 100, so a share is its dash length
  let offset = 25; // start at 12 o'clock
  const arcs = slices.map((slice) => {
    const length = Math.max(0, Math.min(100, slice.share * 100));
    const arc = `<circle class="${slice.tone}" r="${radius}" cx="21" cy="21" fill="none" stroke-width="8" stroke-dasharray="${length.toFixed(3)} ${(100 - length).toFixed(3)}" stroke-dashoffset="${offset.toFixed(3)}"></circle>`;
    offset -= length;
    return arc;
  }).join('');
  return `<svg class="token-pie" viewBox="0 0 42 42" width="${size}" height="${size}" aria-hidden="true"><circle class="token-pie-track" r="${radius}" cx="21" cy="21" fill="none" stroke-width="8"></circle>${arcs}</svg>`;
}

function tokenCardHtml(mint, card, error) {
  const listed = (state.coins?.list || []).find((coin) => coin.mint === mint);
  const symbol = card?.symbol || listed?.symbol || shortAddress(mint), name = card?.name || listed?.name || '';
  const head = `<header><strong>${escapeHtml(symbol)}</strong>${name && name !== symbol ? `<span>${escapeHtml(name)}</span>` : ''}<b>${escapeHtml(formatTokenPrice(card) || '')}</b></header>`;
  const foot = (extra = '') => `<footer>${extra}<a href="${escapeHtml(solscanAccountUrl(mint))}" target="_blank" rel="noopener">Solscan</a></footer>`;
  if (error) return `${head}<p class="token-card-body is-error">${escapeHtml(error)}</p>${foot()}`;
  if (!card) return `${head}<p class="token-card-body"><span class="rail-spin" aria-hidden="true"></span></p>${foot()}`;
  const slices = tokenCardSlices(card);
  if (!slices.length) return `${head}<p class="token-card-body token-card-empty">No pools with liquidity</p>${foot()}`;
  const liquidity = card.liquidityUsd !== null && card.liquidityUsd !== undefined
    ? `${formatUsd(card.liquidityUsd)} liquidity`
    : `${Number(card.liquiditySol.toPrecision(3))} SOL liquidity`;
  const rows = slices.map((slice) => `<li><i class="${slice.tone}" aria-hidden="true"></i><span>${escapeHtml(slice.label)}${slice.venue ? `<small>${escapeHtml(slice.venue)}</small>` : ''}</span><b>${Math.round(slice.share * 100)}%</b></li>`).join('');
  const poolCount = card.pools.length;
  return `${head}
    <div class="token-card-body">${tokenPieSvg(slices, 76)}<ul>${rows}</ul></div>
    ${foot(`<span>${escapeHtml(liquidity)}</span><span>${poolCount} pool${poolCount === 1 ? '' : 's'}</span>`)}`;
}

// The coin page header: the price and a small pie, filled in once the card is read.
function tokenPriceChipHtml(mint) {
  if (!tokenCardEligible(mint)) return '';
  return `<span class="token-price-chip" tabindex="0" data-token-card="${escapeHtml(mint)}" data-token-inline="${escapeHtml(mint)}">${tokenPriceChipInner(mint)}</span>`;
}

function tokenPriceChipInner(mint) {
  const cached = tokenCardCache.get(mint);
  const card = cached?.value;
  if (!card) return cached?.error ? '<small>No price</small>' : '<span class="rail-spin" aria-hidden="true"></span>';
  const slices = tokenCardSlices(card);
  return `${slices.length ? tokenPieSvg(slices, 18) : ''}<b>${escapeHtml(formatTokenPrice(card) || 'No price')}</b>`;
}

function hydrateTokenPriceChips() {
  document.querySelectorAll('[data-token-inline]').forEach((chip) => {
    const mint = chip.dataset.tokenInline;
    const fill = () => document.querySelectorAll(`[data-token-inline="${CSS.escape(mint)}"]`).forEach((element) => { element.innerHTML = tokenPriceChipInner(mint); });
    const cached = tokenCardCache.get(mint);
    if (cached?.value || cached?.error) { fill(); if (Date.now() - cached.at < TOKEN_CARD_MAX_AGE_MS) return; }
    tokenCardData(mint).then(fill, fill);
  });
}

function tokenCardElement() {
  let card = document.getElementById('tokenCard');
  if (!card) {
    card = document.createElement('div');
    card.id = 'tokenCard';
    card.className = 'token-card';
    card.setAttribute('role', 'tooltip');
    card.hidden = true;
    card.addEventListener('mouseleave', () => hideTokenCard());
    document.body.appendChild(card);
  }
  return card;
}

let tokenCardTarget = null;
let tokenCardShowTimer = null;
let tokenCardHideTimer = null;

function placeTokenCard(card, anchor) {
  const box = anchor.getBoundingClientRect();
  const width = Math.min(TOKEN_CARD_WIDTH, window.innerWidth - 32);
  card.style.width = `${width}px`;
  card.style.left = `${Math.max(16, Math.min(box.left, window.innerWidth - width - 16))}px`;
  const below = box.bottom + 6;
  card.style.top = `${below + card.offsetHeight > window.innerHeight - 8 ? Math.max(8, box.top - card.offsetHeight - 6) : below}px`;
}

function showTokenCard(anchor) {
  clearTimeout(tokenCardHideTimer);
  const mint = anchor.dataset.tokenCard;
  if (!tokenCardEligible(mint)) return;
  const card = tokenCardElement();
  tokenCardTarget = anchor;
  anchor.setAttribute('aria-describedby', 'tokenCard');
  const cached = tokenCardCache.get(mint);
  card.innerHTML = tokenCardHtml(mint, cached?.value || null, null);
  card.hidden = false;
  placeTokenCard(card, anchor);
  tokenCardData(mint)
    .then((value) => { if (tokenCardTarget === anchor) { card.innerHTML = tokenCardHtml(mint, value, null); placeTokenCard(card, anchor); } })
    .catch((error) => { if (tokenCardTarget === anchor) card.innerHTML = tokenCardHtml(mint, null, error.message || 'Could not read this coin'); });
}

function hideTokenCard({ now = false } = {}) {
  clearTimeout(tokenCardShowTimer);
  clearTimeout(tokenCardHideTimer);
  const hide = () => {
    const card = document.getElementById('tokenCard');
    if (card && !card.matches(':hover')) card.hidden = true;
    tokenCardTarget?.removeAttribute('aria-describedby');
    tokenCardTarget = null;
  };
  if (now) hide(); else tokenCardHideTimer = setTimeout(hide, 150);
}

function bindTokenCards() {
  // A short hover delay: moving the pointer across the coin list reads nothing.
  document.addEventListener('mouseover', (event) => {
    const anchor = event.target.closest?.('[data-token-card]');
    if (!anchor || anchor === tokenCardTarget) return;
    clearTimeout(tokenCardShowTimer);
    tokenCardShowTimer = setTimeout(() => { if (anchor.matches(':hover')) showTokenCard(anchor); }, TOKEN_CARD_HOVER_DELAY_MS);
  });
  document.addEventListener('mouseout', (event) => {
    const anchor = event.target.closest?.('[data-token-card]');
    if (anchor && !anchor.contains(event.relatedTarget) && !event.relatedTarget?.closest?.('#tokenCard')) hideTokenCard();
  });
  document.addEventListener('focusin', (event) => {
    const anchor = event.target.closest?.('[data-token-card]');
    if (anchor) showTokenCard(anchor);
  });
  document.addEventListener('focusout', (event) => {
    if (event.target.closest?.('[data-token-card]')) hideTokenCard();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && tokenCardTarget) hideTokenCard({ now: true });
  });
}
