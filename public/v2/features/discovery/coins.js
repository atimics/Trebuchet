async function refreshCoins() {
  if (state.apiStatus !== 'connected' || !state.apiClient?.listCoins) return;
  state.coins = { ...state.coins, loading: true, error: null };
  renderCoins();
  try {
    const response = await state.apiClient.listCoins();
    state.coins = { ...state.coins, list: Array.isArray(response.coins) ? response.coins : [], loaded: true, loading: false };
  } catch (error) {
    state.coins = { ...state.coins, loading: false, error: error.message || 'Could not load coins' };
  }
  renderCoins();
}

function coinByKey(key) {
  return (state.coins.list || []).find((coin) => coin.key === key) || null;
}

// A real launch that has a mint but has not finished. The launch workspace
// holds one launch at a time, so it must not be swapped out mid-flight.
function liveLaunchInProgress() {
  if (state.realExecutionRunning || state.fullRunRunning) return true;
  const proof = state.launchProof;
  if (!proof || isDemoLaunchProof(proof)) return false;
  return Boolean(proofTokenMint(proof)) && !transferHasWalletEmptyFinalSweepEvidence(proof.transfer);
}

function guardLaunchWorkspaceSwitch() {
  if (!liveLaunchInProgress()) return true;
  const symbol = currentLaunchConfig().token.symbol;
  notify(`${symbol} has a launch in progress. Finish or resume it before working on another coin.`);
  setView('launch');
  return false;
}

// Clear everything that belongs to the coin being worked on, so the next
// one never shows its estimate, plan, practice run, or proof.
function clearLaunchWorkspaceState() {
  state.tokenLogo = null;
  state.tokenLogoError = null;
  state.launchIdentity = { palette: null, posterDataUrl: null };
  const logoInput = document.getElementById('tokenLogoFile');
  if (logoInput) logoInput.value = '';
  state.classicFundingEstimate = null;
  state.executionReadiness = null;
  state.launchPlan = null;
  state.transactions = [];
  state.lastRunEnvelope = null;
  state.lastDemoLaunchRun = null;
  state.restoredLaunchJournalId = null;
  state.heldShare = { selected: [] };
  state.selectedVanityPublicKey = null;
  if (state.launchProof && !liveLaunchInProgress()) state.launchProof = null;
  invalidateClassicOutputs();
}

function newCoin() {
  if (!guardLaunchWorkspaceSwitch()) return;
  clearLaunchWorkspaceState();
  state.loadedSavedLaunchId = null;
  state.customPools = [];
  state.airdropCsvText = '';
  restoreLaunchConfigFromJournal({
    launchConfig: {
      token: { name: '', symbol: '', description: '', supply: '1,000,000,000', sealedLaunch: true, mintFormat: 'token-2022' },
      launchSol: 0,
      vanity: {},
      poolTopology: {
        targetMarketCapUsd: 25000,
        pools: [{
          id: 'sol-main', quoteToken: 'SOL', quoteSymbol: 'SOL', supplyPercent: 100,
          ammConfigIndex: DEFAULT_POOL_CONFIG_INDEX, distribution: [{ sharePercent: 100 }],
          ladder: { mode: 'off' }, support: { mode: 'off' },
        }],
        preallocation: { supplyPercent: 0 },
        airdrop: { recipients: [] },
        sweepDestination: null,
        heldShare: { funders: [] },
      },
    },
  });
  state.pairStartPremiumPct = PAIR_START_PREMIUM_PCT;
  state.solPoolConfigIndex = DEFAULT_POOL_CONFIG_INDEX;
  state.pairPoolConfigIndex = DEFAULT_POOL_CONFIG_INDEX;
  applyLaunchBudgetRecommendation(1, { announce: false });
  if ($('#targetMarketCapUsd')) $('#targetMarketCapUsd').value = '25,000';
  state.coins = { ...state.coins, key: null };
  setView('launch');
  setLaunchWorkspace('configure');
  renderAll();
  $('#tokenName')?.focus();
}

// The page's saved-launch list and the coin list come from separate requests, so
// the page can be missing a draft the coin list shows (the list request failed or
// the page is older than the draft). Ask the server before calling it gone.
async function savedDraftEntry(draftId) {
  const known = (state.savedLaunches || []).find((item) => item.id === draftId);
  if (known) return known;
  try {
    const payload = await state.apiClient?.listSavedLaunches?.();
    const launches = Array.isArray(payload?.launches)
      ? payload.launches.filter((entry) => entry && entry.id && entry.config)
      : [];
    if (launches.length) state.savedLaunches = launches;
    return launches.find((item) => item.id === draftId) || null;
  } catch {
    return null;
  }
}

async function openDraftForCreation(draftId) {
  const entry = await savedDraftEntry(draftId);
  if (!entry) {
    notify('That draft is no longer saved');
    refreshCoins().catch(() => null);
    return;
  }
  if (state.loadedSavedLaunchId !== draftId) {
    if (!guardLaunchWorkspaceSwitch()) return;
    clearLaunchWorkspaceState();
    restoreLaunchConfigFromJournal({
      launchConfig: entry.config,
      token: { mint: entry.config?.vanity?.selectedPublicKey || null },
    });
    state.loadedSavedLaunchId = entry.id;
    rememberActiveLaunchId(entry.id);
  }
  setView('launch');
  setLaunchWorkspace('configure');
  renderAll();
}

function openCoin(key) {
  const target = coinByKey(key);
  // A draft is created on its own page: its steps.
  if (target?.kind === 'draft') {
    openDraftForCreation(target.draftId).catch((error) => notify(error?.message || 'Could not open that draft'));
    return;
  }
  state.coins = { ...state.coins, key, detail: null, detailError: null };
  resetPoolSupport();
  setView('coins');
  const coin = coinByKey(key);
  if (coin?.kind === 'onchain') {
    loadCoinDetail(coin.mint).catch(() => null);
    loadCoinPositions(coin.mint).catch(() => null);
  }
  renderCoins();
}

async function loadCoinPositions(mint) {
  if (!state.apiClient?.listCoinPositions) return;
  const previous = state.coinPositions.mint === mint ? state.coinPositions : {};
  state.coinPositions = { mint, list: previous.list || [], withdrawals: previous.withdrawals || [], loading: true, error: null, withdrawing: null };
  renderCoins();
  const [positions, withdrawals] = await Promise.allSettled([
    state.apiClient.listCoinPositions(mint), state.apiClient.listPositionWithdrawals(mint),
  ]);
  if (state.coins.key !== `mint:${mint}`) return;
  state.coinPositions = { ...state.coinPositions, loading: false,
    list: positions.status === 'fulfilled' ? positions.value.positions || [] : previous.list || [],
    withdrawals: withdrawals.status === 'fulfilled' ? withdrawals.value.withdrawals || [] : previous.withdrawals || [],
    error: [positions, withdrawals].filter((row) => row.status === 'rejected').map((row) => row.reason.message || 'Read the saved positions again.').join(' ') || null };
  renderCoins();
}

function withdrawalReviewDetail(job) {
  const sol = (value) => formatRawTokenAmount(String(value), 9);
  const minima = job.tokens.map((row) => `${formatRawTokenAmount(row.minimumRaw, row.decimals)} ${row.native ? 'SOL' : fullAddress(row.mint)}`).join(', ');
  return `Close position ${fullAddress(job.nftMint)} in pool ${fullAddress(job.poolId)} on ${job.network}. `
    + `Return at least ${minima} to wallet ${fullAddress(job.walletPublicKey)}. `
    + `Fee ceiling: ${sol(job.feeCeilingLamports)} SOL. Account rent ceiling: ${sol(job.rentCeilingLamports)} SOL. `
    + `Total spending ceiling: ${sol(job.maxSpendLamports)} SOL. Position rent and collected fees also return to this wallet. `
    + 'Closing this position removes its liquidity from the pool.';
}

async function approveCoinWithdrawal(job, practiceInput) {
  const ok = await confirmOperatorAction({
    title: job.practice ? 'Withdraw practice position' : job.status === 'paused' ? 'Resume saved withdrawal' : 'Withdraw position',
    detail: job.practice ? 'Close this practice position and return its funds to the practice wallet.' : withdrawalReviewDetail(job),
    confirmLabel: job.status === 'paused' ? 'Resume withdrawal' : 'Withdraw', danger: true, confirmationText: 'WITHDRAW',
  });
  if (!ok) return;
  const response = await state.apiClient.withdrawPosition(job.practice ? practiceInput : {
    walletPublicKey: job.walletPublicKey, jobId: job.jobId, planDigest: job.planDigest, maxSpendLamports: job.maxSpendLamports,
  });
  if (response.result?.status === 'failed') throw new Error(`The saved withdrawal failed. Paid fee: ${formatRawTokenAmount(String(response.result.feeLamports), 9)} SOL. Review the position for a new withdrawal.`);
  notify('Position withdrawal verified');
}

async function withdrawCoinPosition(nftMint) {
  const mint = state.coinPositions.mint;
  const position = (state.coinPositions.list || []).find((item) => item.nftMint === nftMint);
  if (!position || !mint || state.coinPositions.withdrawing) return;
  state.coinPositions = { ...state.coinPositions, withdrawing: nftMint, error: null }; renderCoins();
  try {
    const input = { walletPublicKey: position.owner, poolId: position.poolId, nftMint, tokenMint: mint, expected: { liquidity: position.liquidity } };
    const saved = (state.coinPositions.withdrawals || []).find((job) => job.nftMint === nftMint && ['paused', 'running'].includes(job.status));
    const job = saved || (await state.apiClient.preparePositionWithdrawal(input)).job;
    if (!job) throw new Error('Read the saved withdrawal review again.');
    if (!job.practice && !saved) state.coinPositions.withdrawals = [...(state.coinPositions.withdrawals || []), job];
    await approveCoinWithdrawal(job, input);
  } catch (error) { notify(error.message || 'Resume the saved withdrawal from this page.'); }
  finally { state.coinPositions.withdrawing = null; }
  await loadCoinPositions(mint);
  loadCoinDetail(mint).catch(() => null);
}

async function resumeCoinWithdrawal(jobId) {
  const job = (state.coinPositions.withdrawals || []).find((row) => row.jobId === jobId), mint = state.coinPositions.mint;
  if (!job || !mint || state.coinPositions.withdrawing) return;
  state.coinPositions.withdrawing = job.nftMint; renderCoins();
  try { await approveCoinWithdrawal(job); }
  catch (error) { notify(error.message || 'Read the saved withdrawal status again.'); }
  finally { state.coinPositions.withdrawing = null; }
  await loadCoinPositions(mint); loadCoinDetail(mint).catch(() => null);
}

function coinWithdrawalHistoryHtml() {
  const jobs = state.coinPositions.withdrawals || [], sol = (value) => formatRawTokenAmount(String(value), 9);
  return jobs.length ? `<ul class="coin-positions">${jobs.slice().reverse().map((job) => {
    const pending = ['paused', 'review_required'].includes(job.status);
    const detail = job.result ? `${job.status === 'confirmed' ? 'Withdrawal verified' : 'Transaction failed'} · fee ${sol(job.result.feeLamports)} SOL`
      : job.status === 'running' ? 'Withdrawal in progress' : job.status === 'paused' ? 'Saved withdrawal needs recovery' : 'Saved withdrawal ready for review';
    return `<li><span><strong>${escapeHtml(detail)}</strong><small>Position ${escapeHtml(fullAddress(job.nftMint))} · wallet ${escapeHtml(fullAddress(job.walletPublicKey))}</small></span>
      ${pending ? `<button class="pill-button" type="button" data-action="resume-coin-withdrawal" data-job="${escapeHtml(job.jobId)}" ${state.coinPositions.withdrawing ? 'disabled' : ''}>${job.status === 'paused' ? 'Resume' : 'Review'}</button>` : ''}</li>`;
  }).join('')}</ul>` : '';
}

// A position's range is priced in its pool's quote token.
function fmtQuotePrice(value, position) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '—';
  const text = number < 0.0001 ? number.toExponential(3) : number.toPrecision(4);
  return `${text} ${position.isSolPool ? 'SOL' : (position.quoteSymbol || 'quote')}`;
}

function coinPositionsHtml() {
  const { list, loading, error, withdrawing } = state.coinPositions;
  const coinSymbol = coinByKey(`mint:${state.coinPositions.mint}`)?.symbol || 'coin';
  if (loading && !list.length) return '<p class="pool-support-status"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Reading your wallets\' positions…</p>';
  const rows = (list || []).map((position) => `
    <li>
      <span>
        <strong>${escapeHtml(position.quoteSymbol || 'pair')} pool · ${walletChipHtml(position.owner)}</strong>
        <small>${escapeHtml(fmtQuotePrice(position.priceLow, position))} to ${escapeHtml(fmtQuotePrice(position.priceHigh, position))} per coin · ${position.inRange ? 'the price is inside this range' : 'the price is outside this range'}</small>
      </span>
      <span class="coin-position-holds">${Number(position.quoteAmount).toFixed(4)} ${escapeHtml(position.quoteSymbol || '')} + ${escapeHtml(compactAmount(position.tokenAmount))} ${escapeHtml(coinSymbol)}</span>
      <button class="pill-button danger" type="button" data-action="withdraw-coin-position" data-nft="${escapeHtml(position.nftMint)}" ${withdrawing ? 'disabled' : ''}>${withdrawing === position.nftMint ? 'Withdrawing…' : 'Withdraw'}</button>
    </li>`).join('');
  return `
    ${rows ? `<ul class="coin-positions">${rows}</ul>` : '<p class="coins-empty">No withdrawable positions.</p>'}
    ${coinWithdrawalHistoryHtml()}
    ${error ? `<p class="pool-support-error">${escapeHtml(error)}</p>` : ''}`;
}

function openCoinByMint(mint) {
  const key = `mint:${mint}`;
  if (!coinByKey(key)) {
    state.coins = { ...state.coins, list: [{ key, kind: 'onchain', mint, name: null, symbol: null, status: 'On-chain' }, ...state.coins.list] };
  }
  openCoin(key);
}

// A launched coin's status from the chain, once its page has read it: the
// same check its creation facts show. Unknown until then.
function coinChainStatus(creation) {
  const steps = creation?.steps || [];
  if (!steps.length) return null;
  if (steps.some((step) => step.state === 'mismatch')) return 'Chain disagrees';
  if (steps.some((step) => ['todo', 'unrecorded'].includes(step.state))) return 'Unfinished';
  return 'Live';
}

function coinStatus(coin) {
  return (coin?.mint && state.coins.checked?.[coin.mint]) || coin?.status || '';
}

async function loadCoinDetail(mint) {
  if (!state.apiClient?.getCoin) return;
  state.coins = { ...state.coins, detailLoading: true, detailError: null };
  renderCoins();
  try {
    const response = await state.apiClient.getCoin(mint);
    if (state.coins.key !== `mint:${mint}`) return;
    const checkedStatus = coinChainStatus(response.coin?.creation);
    state.coins = {
      ...state.coins,
      detail: response.coin,
      detailLoading: false,
      checked: checkedStatus ? { ...(state.coins.checked || {}), [mint]: checkedStatus } : state.coins.checked,
      airdropPlan: null,
    };
    // The sweep sends the saved airdrop first: read it so the page can say so before anyone sweeps.
    const sweepWallet = response.coin?.creation?.walletManaged ? response.coin.creation.walletPublicKey : null;
    if (sweepWallet && state.apiClient.getAirdropPlan) {
      state.apiClient.getAirdropPlan(sweepWallet).then((plan) => {
        if (state.coins.key !== `mint:${mint}` || !plan || plan.tokenMint !== mint) return;
        state.coins = { ...state.coins, airdropPlan: plan };
        renderCoins();
      }).catch(() => null);
    }
  } catch (error) {
    state.coins = { ...state.coins, detailLoading: false, detailError: error.message || 'Could not read the coin' };
  }
  renderCoins();
}

async function addCoinByMint() {
  const input = $('#addCoinMint');
  const mint = String(input?.value || '').trim();
  if (!mint) {
    notify('Paste the coin\'s mint address');
    return;
  }
  if (!state.apiClient?.addCoin) {
    notify('Adding a coin needs the Trebuchet desktop app');
    return;
  }
  try {
    const response = await state.apiClient.addCoin(mint);
    if (input) input.value = '';
    await refreshCoins();
    openCoinByMint(response.coin.mint);
    notify(`${response.coin.symbol || shortAddress(response.coin.mint)} added`);
  } catch (error) {
    notify(error.message || 'Could not add that coin');
  }
}

async function removeAddedCoin(mint) {
  const ok = await confirmOperatorAction({
    title: 'Remove from coins',
    detail: `Hide ${fullAddress(mint)} from your coins. Nothing on-chain changes, and its activity is kept.`,
    confirmLabel: 'Remove',
  });
  if (!ok) return;
  try {
    await state.apiClient.removeCoin(mint);
    state.coins = { ...state.coins, key: null };
    await refreshCoins();
  } catch (error) {
    notify(error.message || 'Could not remove that coin');
  }
}

function coinTitle(coin) {
  return coin?.name || coin?.symbol || (coin?.mint ? shortAddress(coin.mint) : 'Untitled coin');
}

// ---------------------------------------------------------------------------
// Coin cards: one way to show a coin, everywhere
// ---------------------------------------------------------------------------
//
// A card's base color comes from the coin's address (CA): a hue hashed from
// it, so a coin always looks the same and two coins rarely look alike. A
// coin with no address yet (a draft) has a neutral base. The accents come
// from the coin's logo colors, read once per image and cached; until then
// (or without a logo) they are derived from the address too.

const COIN_PALETTES = new Map(); // image src -> { primaryHex, accentHex }
const COIN_PALETTES_PENDING = new Set();

function coinAddressHue(address) {
  let hash = 2166136261;
  for (const character of String(address || '')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 360;
}

// Remote images go through the same-origin proxy: they load reliably and
// their colors can be read.
function coinImageSrc(url) {
  let value = String(url || '').trim();
  if (!value) return '';
  if (value.startsWith('ipfs://')) value = `https://ipfs.io/ipfs/${value.slice(7).replace(/^ipfs\//, '')}`;
  if (value.startsWith('ar://')) value = `https://arweave.net/${value.slice(5)}`;
  if (/^(data:|blob:|\/)/i.test(value)) return value;
  return /^https?:\/\//i.test(value) ? `/api/proxy-image?url=${encodeURIComponent(value)}` : '';
}

function coinAccentFallback(address) {
  if (!address) return null;
  const hue = coinAddressHue(address);
  return {
    primaryHex: launchIdentityRgbHex(launchIdentityHslToRgb([hue / 360, 0.72, 0.6])),
    accentHex: launchIdentityRgbHex(launchIdentityHslToRgb([((hue + 137) % 360) / 360, 0.66, 0.6])),
  };
}

function coinCardStyle(address, src) {
  const vars = [];
  if (address) vars.push(`--coin-hue:${coinAddressHue(address)}`);
  const palette = (src && COIN_PALETTES.get(src)) || coinAccentFallback(address);
  if (palette) vars.push(`--coin-accent:${palette.primaryHex}`, `--coin-accent-2:${palette.accentHex}`);
  return vars.join(';');
}

/**
 * One coin card. `coin` is { name, symbol, address, image }; `variant` is
 * row (Coins list), header (coin page), title (page title while creating),
 * or mini (sidebar and top bar). `tag`/`attrs` make it a button or link.
 */
function coinCardHtml(coin = {}, { variant = 'row', tag = 'div', attrs = '', status = '', trailing = '' } = {}) {
  const address = String(coin.address || '').trim() || null;
  const src = coinImageSrc(coin.image);
  const initials = escapeHtml(String(coin.symbol || coin.name || '').slice(0, 2).toUpperCase());
  const name = coin.name || coin.symbol || 'New coin';
  // Test mints are simulator ids, not addresses anyone can look up.
  const addressText = address?.startsWith('Demo')
    ? 'not on-chain'
    : address
      ? (variant === 'header' ? address : shortAddress(address))
      : 'no address yet';
  return `
    <${tag} class="coin-card-ui coin-card-ui--${variant} ${address ? '' : 'is-unaddressed'}" ${attrs} data-coin-image="${escapeHtml(src)}" style="${escapeHtml(coinCardStyle(address, src))}">
      <span class="coin-card-ui__mark" data-initials="${initials}">${src ? `<img src="${escapeHtml(src)}" alt="">` : initials}</span>
      <span class="coin-card-ui__copy">
        ${status ? `<small class="coin-card-ui__status">${escapeHtml(status)}</small>` : ''}
        <strong>${escapeHtml(name)}${coin.symbol && coin.name ? ` <em>${escapeHtml(coin.symbol)}</em>` : ''}</strong>
        ${variant === 'mini' ? '' : `<code>${escapeHtml(addressText)}</code>`}
      </span>
      ${trailing}
    </${tag}>`;
}

// Read each card's logo colors once, then paint every card for that image.
function hydrateCoinCards() {
  $$('.coin-card-ui__mark img').forEach((image) => {
    if (image.dataset.bound) return;
    image.dataset.bound = '1';
    const showInitials = () => {
      const mark = image.parentElement;
      if (mark) mark.textContent = mark.dataset.initials || '';
    };
    // The image may have failed before this ran; then no error event comes.
    if (image.complete && image.naturalWidth === 0) {
      showInitials();
      return;
    }
    image.addEventListener('error', showInitials, { once: true });
  });
  const apply = (src, palette) => {
    $$('[data-coin-image]').forEach((node) => {
      if (node.dataset.coinImage !== src) return;
      node.style.setProperty('--coin-accent', palette.primaryHex);
      node.style.setProperty('--coin-accent-2', palette.accentHex);
    });
  };
  $$('[data-coin-image]').forEach((node) => {
    const src = node.dataset.coinImage;
    if (!src) return;
    const cached = COIN_PALETTES.get(src);
    if (cached) {
      apply(src, cached);
      return;
    }
    if (COIN_PALETTES_PENDING.has(src)) return;
    COIN_PALETTES_PENDING.add(src);
    const image = new Image();
    image.onload = () => {
      const palette = extractLaunchIdentityArt(image).palette;
      COIN_PALETTES.set(src, palette);
      COIN_PALETTES_PENDING.delete(src);
      apply(src, palette);
    };
    image.onerror = () => COIN_PALETTES_PENDING.delete(src);
    image.src = src;
  });
}

function renderCoins() {
  const listView = $('#coinsListView');
  const page = $('#coinPage');
  if (!listView || !page) return;
  const { key } = state.coins;
  const coin = key ? coinByKey(key) : null;
  listView.hidden = Boolean(coin);
  page.hidden = !coin;
  if (coin) {
    renderCoinPage(coin);
    return;
  }
  const target = $('#coinsList');
  if (!target) return;
  if (state.apiStatus !== 'connected') {
    target.innerHTML = '<p class="coins-empty">Not connected.</p>';
    return;
  }
  if (state.coins.loading && !state.coins.loaded) {
    target.innerHTML = '<p class="coins-empty">Loading coins…</p>';
    return;
  }
  const coins = state.coins.list || [];
  if (!coins.length) {
    target.innerHTML = `<p class="coins-empty">No coins yet. Start a new one, or add one that already exists by its mint address.${state.coins.error ? ` (${escapeHtml(state.coins.error)})` : ''}</p>`;
    return;
  }
  target.innerHTML = coins.map((item) => coinCardHtml(
    { name: item.name, symbol: item.symbol, address: item.mint || item.reservedAddress, image: item.image || item.logoDataUrl },
    {
      variant: 'row',
      tag: 'button',
      attrs: `type="button" data-action="open-coin" data-coin-key="${escapeHtml(item.key)}"`,
      status: coinStatus(item),
    },
  )).join('');
  hydrateCoinCards();
}

function formatTokenAmount(raw, decimals) {
  const value = Number(raw || 0) / 10 ** Number(decimals || 0);
  return compactAmount(value);
}


const coinEvidence = new Map();

function coinMarketEvidenceHtml(mint) {
  if (mint.startsWith('Demo')) return '<section class="coin-section"><h2>Reserves and fee rights</h2></section>';
  const entry = coinEvidence.get(mint) || {};
  const renderer = window.TrebuchetMarketEvidence;
  return `<section class="coin-section" aria-label="Market evidence">
    <div class="section-heading"><div><span class="eyebrow">Verification</span><h2>Reserves and fee rights</h2></div>
      <button class="pill-button" type="button" data-action="read-coin-evidence" data-mint="${escapeHtml(mint)}" ${entry.loading ? 'disabled' : ''}>${entry.loading ? 'Checking chain…' : 'Check chain'}</button>
    </div>
    
    ${entry.error ? `<p class="pool-support-error" role="status">${escapeHtml(entry.error)}</p>` : ''}
    ${renderer?.render(entry.evidence) || ''}
    ${entry.evidence ? `<button class="pill-button" type="button" data-action="download-coin-evidence" data-mint="${escapeHtml(mint)}">Download market evidence</button>` : ''}
    <div class="market-sell-quote">
      <label for="sellQuoteAmount">Tokens to sell</label>
      <input id="sellQuoteAmount" data-sell-quote-mint="${escapeHtml(mint)}" inputmode="decimal" autocomplete="off" value="${escapeHtml(entry.amount || '')}" placeholder="1000">
      <button class="pill-button" type="button" data-action="quote-coin-sale" data-mint="${escapeHtml(mint)}" ${entry.quoting ? 'disabled' : ''}>${entry.quoting ? 'Reading route…' : 'Get sell quote'}</button>
      <div role="status">${entry.quoteError ? `<p class="pool-support-error">${escapeHtml(entry.quoteError)}</p>` : renderer?.sellQuote(entry.quote) || ''}</div>
    </div>
  </section>`;
}

async function readCoinMarketEvidence(mint) {
  const previous = coinEvidence.get(mint) || {};
  if (previous.loading || !state.apiClient?.getCoinEvidence) return;
  coinEvidence.set(mint, { ...previous, loading: true, error: null });
  renderCoins();
  try {
    const result = await state.apiClient.getCoinEvidence(mint);
    coinEvidence.set(mint, { ...coinEvidence.get(mint), evidence: result.evidence, loading: false });
  } catch (error) {
    coinEvidence.set(mint, { ...coinEvidence.get(mint), loading: false, error: error.message || 'Chain inspection needs another try.' });
  }
  if (state.coins.key === `mint:${mint}`) renderCoins();
}

async function quoteCoinSale(mint) {
  const previous = coinEvidence.get(mint) || {};
  if (previous.quoting || !state.apiClient?.getSellQuote) return;
  const amount = String(previous.amount || '').trim();
  coinEvidence.set(mint, { ...previous, amount, quoting: true, quote: null, quoteError: null });
  renderCoins();
  try {
    const result = await state.apiClient.getSellQuote(mint, amount);
    coinEvidence.set(mint, { ...coinEvidence.get(mint), quote: result.quote, quoting: false });
  } catch (error) {
    coinEvidence.set(mint, { ...coinEvidence.get(mint), quoting: false, quoteError: error.message || 'Sell quote needs another try.' });
  }
  if (state.coins.key === `mint:${mint}`) renderCoins();
}

function coinMarketsHtml(markets) {
  if (!markets) return '';
  if (markets.error) return `<p class="pool-support-error">Could not read the markets: ${escapeHtml(markets.error)}</p>`;
  const pools = markets.pools || [];
  if (!pools.length) return '<p class="coins-empty">No Raydium pools hold this coin yet.</p>';
  const drains = pools.filter((pool) => pool.drainsSolPool);
  return `
    ${drains.length ? `<p class="coin-drain-warning" role="note"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> This coin is cheaper in its ${drains.map((pool) => escapeHtml(pool.quoteSymbol || 'pair')).join(', ')} pool${drains.length === 1 ? '' : 's'} than in its SOL pool. Bots buy it there and sell it into the SOL pool, taking SOL buyers' money, until the gap closes. Buy support only holds below that price.</p>` : ''}
    <div class="coin-markets" role="table" aria-label="Markets">
      <div class="coin-market-row is-head" role="row"><span role="columnheader">Pool</span><span role="columnheader">Price in SOL</span><span role="columnheader">vs SOL pool</span><span role="columnheader">Quote reserve</span><span role="columnheader">Coin side</span><span role="columnheader">Fee</span></div>
      ${pools.map((pool) => `
        <div class="coin-market-row ${pool.isMainSolPool ? 'is-main' : ''} ${pool.drainsSolPool ? 'is-drain' : ''}" role="row">
          <span role="cell"><strong>${escapeHtml(pool.quoteSymbol || shortAddress(pool.quoteMint))}</strong><small>${escapeHtml(pool.isMainSolPool ? 'main SOL pool' : shortAddress(pool.poolId))}</small></span>
          <span role="cell">${escapeHtml(fmtPoolPrice(pool.priceSol))}</span>
          <span role="cell">${pool.gapPct === null || pool.gapPct === undefined ? '—' : `${pool.gapPct > 0 ? '+' : ''}${pool.gapPct.toFixed(1)}%`}</span>
          <span role="cell">${pool.quoteReserve === null || pool.quoteReserve === undefined ? '—' : `${escapeHtml(Number(pool.quoteReserve).toLocaleString('en-US', { maximumFractionDigits: 9 }))} ${escapeHtml(pool.quoteSymbol || shortAddress(pool.quoteMint))}`}${!pool.isSolPool && pool.quoteReserveSol != null ? `<small>valued at ${escapeHtml(fmtPoolPrice(pool.quoteReserveSol))}</small>` : ''}</span>
          <span role="cell">${escapeHtml(compactAmount(pool.tokenReserve))}</span>
          <span role="cell">${pool.feeRate === null ? '—' : `${Number((pool.feeRate * 100).toFixed(3))}%`}</span>
        </div>`).join('')}
    </div>`;
}

// What each fact that doesn't hold asks for, in the create view's words.
const CREATION_STEP_ACTIONS = {
  token: 'Finish the token',
  pools: 'Open the pools',
  locks: 'Lock the liquidity',
  reveal: 'Reveal the identity',
  return: 'Sweep the launch wallet',
};

function coinCreationHtml(creation, coin) {
  if (!creation) return '';
  const mismatches = creation.steps.filter((step) => step.state === 'mismatch');
  // A step neither recorded nor checkable on-chain has not been done as far as anyone can tell:
  // it is still the next step. Skipping it offered a sweep before the liquidity was locked.
  const next = creation.steps.find((step) => ['todo', 'mismatch', 'unrecorded'].includes(step.state)) || null;
  let action = '';
  if (next) {
    if (next.id === 'return' && creation.walletManaged && creation.walletPublicKey) {
      // The sweep runs the saved airdrop first, then returns the rest: say both before it is pressed.
      const plan = state.coins.airdropPlan?.tokenMint === coin?.mint ? state.coins.airdropPlan : null;
      const delivered = new Set((creation.journal?.airdrop?.transferred || []).map((row) => row.wallet));
      const pending = plan ? plan.recipients.filter((row) => !delivered.has(row.wallet)) : [];
      const tokens = (rows) => rows.reduce((sum, row) => sum + (Number(row.tokens) || 0), 0).toLocaleString('en-US', { maximumFractionDigits: 4 });
      const airdropNote = plan ? `<p class="coin-airdrop-note" role="note"><i class="fa-solid fa-parachute-box" aria-hidden="true"></i> Airdrop: ${pending.length
        ? `${tokens(pending)} tokens to ${pending.length} wallet${pending.length === 1 ? '' : 's'} are sent first${delivered.size ? ` (${delivered.size} already delivered)` : ''}`
        : `all ${plan.recipients.length} wallets delivered`}. Then every token and SOL left in the launch wallet goes to the return wallet.</p>` : '';
      const sweeping = state.sweepingWalletPublicKey === creation.walletPublicKey;
      const last = !sweeping && state.lastRecoverySweep?.publicKey === creation.walletPublicKey ? state.lastRecoverySweep : null;
      const progress = sweeping
        ? `<p class="coin-airdrop-note" role="status"><span class="rail-spin" aria-hidden="true"></span> ${escapeHtml(coinSweepProgressText(creation.walletPublicKey, plan, delivered))}</p>`
        : last ? `<p class="coin-airdrop-note${last.error ? ' is-error' : ''}" role="status">${escapeHtml(last.message)}</p>` : '';
      action = `${sweeping ? '' : airdropNote}${progress}<button class="primary-button compact" type="button" data-action="sweep-recovery-wallet" data-wallet="${escapeHtml(creation.walletPublicKey)}" ${sweeping ? 'disabled' : ''}><span>${sweeping ? (pending.length ? 'Airdropping and sweeping…' : 'Sweeping…') : pending.length ? 'Airdrop, then sweep' : 'Sweep the launch wallet'}</span><i class="fa-solid ${sweeping ? 'fa-spinner fa-spin' : pending.length ? 'fa-parachute-box' : 'fa-broom'}"></i></button>`;
    } else if (creation.hasPlan && creation.walletManaged) {
      action = `<button class="primary-button compact" type="button" data-action="continue-coin-step" data-mint="${escapeHtml(coin?.mint || '')}"><span>${escapeHtml(CREATION_STEP_ACTIONS[next.id] || 'Open the coin')}</span><i class="fa-solid fa-arrow-right"></i></button>`;
    } else if (!creation.walletManaged) {
      action = '<p class="pool-support-intro">The launch wallet is not in this app, so what is left can\'t be done from here.</p>';
    } else {
      action = '<p class="pool-support-intro">This launch was recorded before Trebuchet saved launch plans, so what is left can\'t be done from here.</p>';
    }
  }
  return `
    <ul class="coin-creation">
      ${creation.steps.map((step) => {
        const meta = COIN_FACT_MARKS[step.state] || COIN_FACT_MARKS.todo;
        return `<li class="is-${escapeHtml(step.state)}" title="${escapeHtml(meta.label)}">
          <i class="fa-solid ${meta.icon}" aria-hidden="true"></i>
          <span><strong>${escapeHtml(step.label)}</strong><small><span class="visually-hidden">${escapeHtml(meta.label)}: </span>${step.id === 'return' && creation.walletPublicKey ? walletChipHtml(creation.walletPublicKey) : escapeHtml(step.detail || '')}</small></span>
        </li>`;
      }).join('')}
    </ul>
    ${action ? `<div class="coin-actions">${action}</div>` : ''}`;
}

// Bring up a coin's remaining steps from its launch record, at the step it
// needs. Checks the record has a plan BEFORE touching the coin being
// worked on, so a record without one never shows another coin's design.
// What the running sweep is doing now: each airdrop wallet as it lands, then the rest.
function coinSweepProgressText(walletPublicKey, plan, delivered) {
  const live = state.sweepAirdropProgress?.publicKey === walletPublicKey ? state.sweepAirdropProgress : null;
  const total = plan?.recipients?.length || 0;
  if (!total) return 'Sweeping every token and SOL to the return wallet. Keep the app open.';
  if (!live) return delivered.size >= total
    ? 'Sweeping every token and SOL to the return wallet. Keep the app open.'
    : `Airdrop: ${delivered.size} of ${total} wallets sent. Starting… Keep the app open.`;
  const sent = Math.min(total, delivered.size + (live.completed || 0));
  const failed = live.failedCount ? `, ${live.failedCount} failed` : '';
  if (live.status === 'done') return `Airdrop: ${sent} of ${total} wallets sent${failed}. Now sweeping every token and SOL to the return wallet.`;
  const left = Math.max(0, total - sent);
  return `Airdrop: ${sent} of ${total} wallets sent${failed}. About ${Math.max(1, Math.ceil(left * 15 / 60))} min left; each transfer waits for full confirmation. Keep the app open.`;
}

function continueCoinStep(mint) {
  const journal = state.coins.detail?.mint === mint ? state.coins.detail?.creation?.journal : null;
  if (!journal || !recoveryLaunchConfig(journal)) {
    notify('This launch\'s plan was not saved, so its steps can\'t be run here');
    return;
  }
  const sameCoin = proofTokenMint(state.launchProof) === mint;
  if (!sameCoin && !guardLaunchWorkspaceSwitch()) return;
  if (!sameCoin) clearLaunchWorkspaceState();
  if (!restoreLaunchConfigFromJournal(journal)) {
    notify('This launch\'s plan could not be restored');
    return;
  }
  state.loadedSavedLaunchId = null;
  if (journal.walletPublicKey
      && state.managedWallets.some((wallet) => wallet.publicKey === journal.walletPublicKey)) {
    state.selectedWalletPublicKey = journal.walletPublicKey;
    state.accountId = journal.walletPublicKey;
  }
  setView('launch');
  setLaunchWorkspace(recoveryWorkspaceForJournal(journal));
  renderAll();
  checkExecutionReadiness().catch(() => null);
}

function coinActivityHtml(events = []) {
  if (!events.length) return '<p class="coins-empty">Nothing recorded yet.</p>';
  const label = {
    launched_here: 'Launched with Trebuchet',
    practice_launch: 'Test launch',
    support_added: 'Buy support added',
    position_withdrawn: 'Position withdrawn',
  };
  return `<ul class="coin-activity">${events.map((event) => `
    <li>
      <span><strong>${escapeHtml(label[event.type] || event.type)}</strong><small>${escapeHtml(formatDate(event.at))}${event.sol ? ` · ${Number(event.sol).toFixed(4)} SOL` : ''}${event.practice ? ' · test' : ''}</small></span>
      <em>${escapeHtml(event.outcome || '')}${event.txId && !String(event.txId).startsWith('Demo') ? ` · <a href="${escapeHtml(solscanTxUrl(event.txId))}" target="_blank" rel="noopener">tx</a>` : ''}</em>
    </li>`).join('')}</ul>`;
}

function draftPlanHtml(entry) {
  const config = entry?.config || {};
  const topology = config.poolTopology || {};
  const pools = Array.isArray(topology.pools) ? topology.pools : [];
  const supportSol = pools.reduce((sum, pool) => sum + (pool?.support?.mode === 'custom' ? Number(pool.support.solValue || 0) : 0), 0);
  const held = Number(topology.preallocation?.supplyPercent || 0);
  const facts = [
    ['Supply', compactAmount(parseWholeNumber(String(config.token?.supply || '1000000000')) || 1e9)],
    ['Target market cap', `$${compactAmount(Number(topology.targetMarketCapUsd || 0))}`],
    ['Pools', pools.length ? pools.map((pool) => `${pool.quoteSymbol || pool.quoteToken || 'pair'} ${Number(pool.supplyPercent || 0)}%`).join(' · ') : 'None yet'],
    ['SOL in the pool', supportSol > 0 ? fmtSol(supportSol) : 'None'],
    ['Held back', held > 0 ? `${held}%` : 'None'],
    ['Address', config.vanity?.selectedPublicKey ? `${fullAddress(config.vanity.selectedPublicKey)} (reserved)` : 'Chosen when the token is created'],
  ];
  return `<dl class="pool-support-facts">${facts.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl>`;
}

// The coin page header: the coin's card, with its explorer links.
function coinHeaderHtml({ name, symbol, image = null, status = '', address = null, links = false }) {
  const trailing = links && address
    ? `<span class="coin-links"><a class="pill-button link-button" href="https://solscan.io/token/${escapeHtml(address)}" target="_blank" rel="noopener">Solscan</a><a class="pill-button link-button" href="https://raydium.io/swap/?inputMint=sol&outputMint=${escapeHtml(address)}" target="_blank" rel="noopener">Raydium</a></span>`
    : '';
  return coinCardHtml({ name, symbol, address, image }, { variant: 'header', tag: 'header', status, trailing });
}

function renderCoinPage(coin) {
  if ($('#coinPageFooter')) $('#coinPageFooter').innerHTML = '';
  const body = $('#coinPageBody');
  const supportPanel = $('#poolSupportPanel');
  if (!body) return;
  const detail = state.coins.detail && state.coins.detail.mint === coin.mint ? state.coins.detail : null;
  const account = detail?.account && !detail.account.error ? detail.account : null;
  const name = account?.metadata?.name || detail?.info?.name || coin.name;
  const symbol = account?.metadata?.symbol || detail?.info?.symbol || coin.symbol;
  const header = coinHeaderHtml({
    name,
    symbol,
    image: detail?.image || coin.image || coin.logoDataUrl || null,
    status: coinStatus(coin),
    address: coin.mint || coin.reservedAddress || null,
    links: Boolean(coin.mint && !coin.practice),
  });

  if (coin.kind === 'draft') {
    // A draft's page is its creation steps (see openCoin).
    body.innerHTML = header;
    if (supportPanel) supportPanel.hidden = true;
    return;
  }

  const identity = account ? [
    ['Supply', escapeHtml(formatTokenAmount(account.supply, account.decimals))],
    ['Mint authority', account.mintAuthority ? walletChipHtml(account.mintAuthority) : 'Revoked'],
    ['Freeze authority', account.freezeAuthority ? walletChipHtml(account.freezeAuthority) : 'Revoked'],
    ['Metadata', account.metadata ? (account.metadata.updateAuthority ? `Editable by ${walletChipHtml(account.metadata.updateAuthority)}` : 'Immutable') : 'Metaplex / unknown'],
  ] : [];
  body.innerHTML = `${header}
    ${state.coins.detailLoading ? '<p class="pool-support-status"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Reading the coin from the chain…</p>' : ''}
    ${state.coins.detailError ? `<p class="pool-support-error">${escapeHtml(state.coins.detailError)}</p>` : ''}

    ${identity.length ? `<section class="coin-section"><div class="section-heading"><div><span class="eyebrow">On-chain</span><h2>Token</h2></div></div><dl class="pool-support-facts">${identity.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`).join('')}</dl></section>` : ''}
    ${detail?.creation ? `<section class="coin-section"><div class="section-heading"><div><span class="eyebrow">Creation</span><h2>${detail.creation.nextStep ? 'Unfinished' : 'Launched'}</h2></div></div>${coinCreationHtml(detail.creation, coin)}</section>` : ''}
    ${detail?.markets ? `<section class="coin-section"><div class="section-heading"><div><span class="eyebrow">Markets</span><h2>Pools</h2></div><button class="pill-button" type="button" data-action="refresh-coin">Refresh</button></div>${coinMarketsHtml(detail.markets)}</section>` : ''}
    ${coinMarketEvidenceHtml(coin.mint)}
    <section class="coin-section"><div class="section-heading"><div><span class="eyebrow">Positions</span><h2>Your positions</h2></div><button class="pill-button" type="button" data-action="refresh-coin-positions">Refresh</button></div>${coinPositionsHtml()}</section>
    <section class="coin-section"><div class="section-heading"><div><span class="eyebrow">Activity</span><h2>What has happened</h2></div></div>${coinActivityHtml(detail?.events || [])}</section>`;
  // Removing a coin is the page's last, least-used action: it sits after
  // buy support, not between the coin's activity and its actions.
  const footer = $('#coinPageFooter');
  if (footer) {
    footer.innerHTML = coin.status === 'Added'
      ? `<button class="text-button" type="button" data-action="remove-coin" data-mint="${escapeHtml(coin.mint)}">Remove from coins</button>`
      : '';
  }
  if (supportPanel) {
    supportPanel.hidden = false;
    // A test coin has no real pool: buy support is simulated against a
    // sample pool, and the panel says so.
    const intro = supportPanel.querySelector('.pool-support-intro');
    if (intro) {
      intro.textContent = coin.practice ? 'Test: nothing is sent.' : '';
    }
    const target = $('#poolSupportTarget');
    if (target && target.value !== coin.mint) {
      target.value = coin.mint;
      resetPoolSupport();
    }
  }
}

// The coin being created: its identity is the page title (name, ticker,
// status, address), over its creation steps. It takes no extra height, so
// the steps keep the whole page.
// The create view's status for a live mint, from the same facts its list shows.
function launchViewChainStatus() {
  const facts = coinFacts();
  if (facts.some((fact) => fact.state === 'mismatch')) return 'Chain disagrees';
  // "Recorded" holds: the chain can't read every fact (liquidity locks).
  return ['mint', 'liquidity', 'finish'].every((id) => ['done', 'recorded'].includes(facts.find((fact) => fact.id === id)?.state))
    ? 'Live'
    : 'Being created';
}

function renderCoinContext() {
  const bar = $('#coinContext');
  if (bar) {
    bar.hidden = true;
    bar.innerHTML = '';
  }
  if (state.activeView !== 'launch') return;
  const name = String($('#tokenName')?.value || '').trim();
  const symbol = String($('#tokenSymbol')?.value || '').trim();
  const proof = currentLaunchProof();
  const mint = proofTokenMint(proof) || null;
  const practice = isDemoLaunchProof(proof);
  const reserved = state.selectedVanityPublicKey || null;
  const status = mint
    ? practice ? 'Test coin' : launchViewChainStatus()
    : reserved ? 'Address reserved' : 'Draft';
  const address = mint || reserved;
  const eyebrow = $('#viewEyebrow');
  const title = $('#viewTitle');
  // Written once: redrawing it on every change would replace the button
  // under a click that is still in progress (a blur fires "change").
  if (eyebrow && !eyebrow.querySelector('[data-action="coins-back"]')) {
    eyebrow.innerHTML = `<button class="text-button coin-back-inline" type="button" data-action="coins-back"><i class="fa-solid fa-arrow-left"></i> Coins</button>`;
  }
  if (title) {
    title.innerHTML = coinCardHtml(
      { name, symbol, address, image: state.tokenLogo?.dataUrl ? launchIdentityImageSrc(state.tokenLogo, { animate: false }) : null },
      { variant: 'title', tag: 'span', status },
    );
    hydrateCoinCards();
  }
}

// ---------------------------------------------------------------------------
// Buy support for an existing pool (Wallet view)
// ---------------------------------------------------------------------------
