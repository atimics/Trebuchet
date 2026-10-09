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
  state.coins = { ...state.coins, key: null };
  setView('launch');
  setLaunchWorkspace('configure');
  renderAll();
}

// Every coin has one page: its steps. A draft's steps create it; an on-chain
// coin's steps say what the chain and its launch record show.
function openCoin(key) {
  const target = coinByKey(key);
  if (target?.kind === 'draft') {
    openDraftForCreation(target.draftId).catch((error) => notify(error?.message || 'Could not open that draft'));
    return;
  }
  // The launch running in the workspace stays on screen as it runs.
  if (target?.mint && target.mint === proofTokenMint(state.launchProof) && liveLaunchInProgress()) {
    state.coins = { ...state.coins, key: null };
    setView('launch');
    renderAll();
    return;
  }
  // The last read of this coin shows at once; the chain is read again behind it.
  const seen = target?.mint ? coinPageCache.get(target.mint) : null;
  state.coins = { ...state.coins, key, detail: seen?.detail || null, detailError: null, airdrop: seen?.airdrop || null };
  state.launchWorkspace = null;
  resetPoolSupport();
  setView('launch');
  if (target?.kind === 'onchain') {
    loadCoinDetail(target.mint).catch(() => null);
    loadCoinPositions(target.mint).catch(() => null);
    loadCoinAirdrop(target.mint).catch(() => null);
  }
  renderAll();
}

// Each on-chain coin's last read in this session, by mint: its page and its airdrop.
const coinPageCache = new Map();
function rememberCoinPage(mint, patch) {
  coinPageCache.set(mint, { ...(coinPageCache.get(mint) || {}), ...patch });
}

function refreshCoinAfterExecution(mint) {
  coinPageCache.delete(mint);
  if (state.coins.key !== `mint:${mint}`) return;
  state.coins = { ...state.coins, detail: null, detailError: null };
  loadCoinDetail(mint).catch(() => null);
}

// The coin's airdrop: what each wallet received, and what the chain says it holds now.
async function loadCoinAirdrop(mint) {
  if (!state.apiClient?.getCoinAirdrop) return;
  const previous = state.coins.airdrop?.mint === mint ? state.coins.airdrop : coinPageCache.get(mint)?.airdrop || null;
  state.coins = { ...state.coins, airdrop: { mint, recipients: previous?.recipients || null, decimals: previous?.decimals ?? null, loading: true, error: null } };
  renderCoins();
  try {
    const response = await state.apiClient.getCoinAirdrop(mint);
    if (state.coins.key !== `mint:${mint}`) return;
    state.coins = { ...state.coins, airdrop: { mint, ...response.airdrop, loading: false, error: null } };
    rememberCoinPage(mint, { airdrop: state.coins.airdrop });
  } catch (error) {
    if (state.coins.key !== `mint:${mint}`) return;
    state.coins = { ...state.coins, airdrop: { ...state.coins.airdrop, loading: false, error: error.message || 'Could not read the balances' } };
  }
  renderCoins();
}

// Received against held now, as a fact: all of it, more, part, or none.
function airdropHolding(row) {
  if (row.nowRaw == null) return { tone: 'unknown', label: 'Not read', rank: 3 };
  const received = BigInt(row.receivedRaw || '0');
  const now = BigInt(row.nowRaw);
  if (now === 0n) return { tone: 'none', label: 'None left', rank: 0 };
  if (now < received) {
    const left = Number((now * 1000n) / (received || 1n)) / 10;
    return { tone: 'part', label: `${left.toFixed(left < 10 ? 1 : 0)}% left`, rank: 1 };
  }
  return { tone: 'all', label: now > received ? 'Holds more' : 'Holds all', rank: 2 };
}

// What the chain's history shows a wallet did with the coin since its airdrop.
const AIRDROP_ACTIVITY = [['burnedRaw', 'Burned'], ['soldRaw', 'Sold'], ['boughtRaw', 'Bought'], ['sentRaw', 'Sent'], ['transferredInRaw', 'Got']];
function airdropActivity(row, amount) {
  const history = row.history;
  if (!history) return [];
  if (history.error) return ['History not read'];
  const done = AIRDROP_ACTIVITY.filter(([field]) => BigInt(history[field] || '0') > 0n)
    .map(([field, label]) => `${label} ${amount(history[field])}`);
  if (history.partial) done.push('older history not read');
  return done;
}

function coinAirdropHtml(airdrop) {
  if (!airdrop) return '';
  if (airdrop.error && !airdrop.recipients) return `<p class="pool-support-error">${escapeHtml(airdrop.error)}</p>`;
  const rows = airdrop.recipients || [];
  if (!rows.length) return airdrop.loading ? '<p class="coins-empty">Reading the airdrop…</p>' : '';
  const decimals = Number.isFinite(Number(airdrop.decimals)) ? Number(airdrop.decimals) : null;
  const amount = (raw) => (raw == null || decimals == null ? '—' : compactAmount(Number(BigInt(raw)) / 10 ** decimals));
  const ranked = rows.map((row) => ({ row, holding: airdropHolding(row), activity: airdropActivity(row, amount) }))
    .sort((a, b) => a.holding.rank - b.holding.rank || Number(BigInt(b.row.receivedRaw) - BigInt(a.row.receivedRaw)));
  const count = (tone) => ranked.filter((item) => item.holding.tone === tone).length;
  const did = (field) => rows.filter((row) => BigInt(row.history?.[field] || '0') > 0n).length;
  const totals = [
    count('all') ? `${count('all')} hold all${ranked.some((item) => item.holding.label === 'Holds more') ? ' or more' : ''}` : null,
    count('part') ? `${count('part')} hold part` : null,
    count('none') ? `${count('none')} hold none` : null,
    ...[['burnedRaw', 'burned'], ['soldRaw', 'sold'], ['boughtRaw', 'bought'], ['sentRaw', 'sent']]
      .map(([field, label]) => (did(field) ? `${did(field)} ${label}` : null)),
  ].filter(Boolean);
  return `
    <p class="coin-airdrop-totals">${rows.length} wallet${rows.length === 1 ? '' : 's'}${totals.length ? ` · ${totals.join(' · ')}` : ''}${airdrop.loading ? ' · reading…' : ''}</p>
    <div class="coin-airdrop" role="table" aria-label="Airdrop recipients">
      <div class="coin-airdrop-row is-head" role="row"><span role="columnheader">Wallet</span><span role="columnheader">Received</span><span role="columnheader">Holds now</span><span role="columnheader">What happened</span></div>
      ${ranked.map(({ row, holding, activity }) => `
        <div class="coin-airdrop-row is-${holding.tone}" role="row">
          <span role="cell">${walletChipHtml(row.wallet)}</span>
          <span role="cell">${escapeHtml(amount(row.receivedRaw))}</span>
          <span role="cell">${escapeHtml(amount(row.nowRaw))}</span>
          <span role="cell">${escapeHtml(activity.length ? activity.join(' · ') : holding.label)}</span>
        </div>`).join('')}
    </div>`;
}

// The on-chain coin the page shows, or null while it shows a coin being created.
function chainCoinOnPage() {
  const coin = state.coins.key ? coinByKey(state.coins.key) : null;
  return coin?.kind === 'onchain' ? coin : null;
}

function chainCoinDetail(coin) {
  return coin && state.coins.detail && state.coins.detail.mint === coin.mint ? state.coins.detail : null;
}

// A saved draft whose reserved address has since launched is that coin now: show the coin.
function launchedCoinForWorkspaceDraft() {
  if (state.activeView !== 'launch' || chainCoinOnPage() || liveLaunchInProgress()) return null;
  if (proofTokenMint(currentLaunchProof())) return null;
  const reserved = String(state.selectedVanityPublicKey || '').trim();
  if (!reserved) return null;
  const coin = (state.coins.list || []).find((item) => item.kind === 'onchain' && item.launchedHere && item.mint === reserved);
  if (!coin) return null;
  // Only the draft that made this coin is that coin. A new coin that picked its address is not.
  const token = currentLaunchConfig().token || {};
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  return same(token.symbol, coin.symbol) && same(token.name, coin.name) ? coin : null;
}

// A new coin holding an address another launch has minted drops it for a fresh random one.
function dropUsedVanitySelection() {
  if (chainCoinOnPage() || liveLaunchInProgress() || state.fullRunRunning || state.realExecutionRunning) return false;
  if (proofTokenMint(currentLaunchProof())) return false;
  if (!vanityAddressUsedReason(state.selectedVanityPublicKey) || launchedCoinForWorkspaceDraft()) return false;
  state.selectedVanityPublicKey = null;
  invalidateClassicOutputs();
  return true;
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
    rememberCoinPage(mint, { detail: response.coin });
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
  if (state.activeView === 'launch' && (chainCoinOnPage() || launchedCoinForWorkspaceDraft())) {
    renderLaunchWorkspace();
    renderCoinContext();
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
      attrs: `type="button" data-action="open-coin" data-coin-key="${escapeHtml(item.key)}"${tokenCardEligible(item.mint) ? ` data-token-card="${escapeHtml(item.mint)}"` : ''}`,
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
  if (!pools.length) return '<p class="coins-empty">No pools found for this coin.</p>';
  const drains = pools.filter((pool) => pool.drainsSolPool);
  return `
    ${drains.length ? `<p class="coin-drain-warning" role="note"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> This coin is cheaper in its ${drains.map((pool) => escapeHtml(pool.quoteSymbol || 'pair')).join(', ')} pool${drains.length === 1 ? '' : 's'} than in its SOL pool. Bots buy it there and sell it into the SOL pool, taking SOL buyers' money, until the gap closes. Buy support only holds below that price.</p>` : ''}
    <div class="coin-markets" role="table" aria-label="Markets">
      <div class="coin-market-row is-head" role="row"><span role="columnheader">Pool</span><span role="columnheader">Price in SOL</span><span role="columnheader">vs SOL pool</span><span role="columnheader">Quote reserve</span><span role="columnheader">Coin side</span><span role="columnheader">Fee</span></div>
      ${pools.map((pool) => `
        <div class="coin-market-row ${pool.isMainSolPool ? 'is-main' : ''} ${pool.drainsSolPool ? 'is-drain' : ''}" role="row">
          <span role="cell"><strong>${pool.isSolPool ? 'SOL' : tokenSymbolHtml(pool.quoteMint, pool.quoteSymbol)}</strong><small>${escapeHtml([pool.venue === 'meteora-damm-v2' ? 'Meteora' : 'Raydium', pool.isMainSolPool ? 'main SOL pool' : shortAddress(pool.poolId)].join(' · '))}</small></span>
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

// The one thing left to do for a coin launched here, or '' when nothing is.
function coinNextStepAction(creation, coin) {
  if (!creation) return '';
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
    } else {
      const reason = !creation.walletManaged ? 'Launch key not in Trebuchet' : 'Launch plan not saved';
      action = `<button class="primary-button compact" type="button" disabled aria-disabled="true" data-blocked-reason="${reason}" title="${reason}"><span>${escapeHtml(CREATION_STEP_ACTIONS[next.id] || 'Open the coin')}</span></button>`;
    }
  }
  return action ? `<div class="coin-actions">${action}</div>` : '';
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
  state.coins = { ...state.coins, key: null };
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

const CHAIN_FACT_LABELS = { wallet: 'Launch', mint: 'Token', liquidity: 'Liquidity', finish: 'Launch wallet' };

// The rail for an on-chain coin: the same four rows as creating one, each from the chain
// and the launch record (see coinCreationSteps on the server).
function onchainCoinFacts(coin) {
  const detail = chainCoinDetail(coin);
  const creation = detail?.creation || null;
  const step = (id) => creation?.steps?.find((item) => item.id === id) || null;
  const account = detail?.account && !detail.account.error ? detail.account : null;
  if (!detail) {
    const value = state.coins.detailError ? 'Not read' : 'Reading the chain';
    const fact = { state: state.coins.detailError ? 'unrecorded' : 'running', value };
    return [{ id: 'wallet', ...fact }, { id: 'mint', ...fact }, { id: 'liquidity', ...fact }, { id: 'finish', ...fact }];
  }
  const worst = (...steps) => {
    const states = steps.filter(Boolean).map((item) => item.state);
    return ['mismatch', 'todo', 'unrecorded', 'recorded'].find((item) => states.includes(item)) || 'done';
  };
  const poolCount = (detail.markets?.pools || []).length;
  const pools = `${poolCount} pool${poolCount === 1 ? '' : 's'}`;
  const wallet = creation?.walletPublicKey
    ? { state: 'done', value: `From ${shortAddress(creation.walletPublicKey)}` }
    : { state: 'done', value: coin.practice ? 'Test coin' : 'Added by address' };
  const token = account
    ? { state: step('token')?.state || 'done', value: `${formatTokenAmount(account.supply, account.decimals)} · mint authority ${account.mintAuthority ? 'kept' : 'revoked'}` }
    : { state: 'unrecorded', value: 'Not a readable mint' };
  const locks = step('locks')?.detail?.match(/(\d+)\/(\d+)/);
  const liquidity = creation
    ? { state: worst(step('pools'), step('locks'), step('reveal')), value: `${pools} open${locks ? ` · ${locks[1]}/${locks[2]} locked` : ''}` }
    : { state: 'done', value: detail.markets ? pools : 'Not read' };
  const swept = step('return');
  const finish = !creation
    ? { state: 'done', value: 'Not launched here' }
    : swept?.state === 'done'
      ? { state: 'done', value: 'Empty' }
      : swept?.state === 'recorded'
        ? { state: 'recorded', value: 'Recorded empty' }
        : swept?.state === 'unrecorded'
          ? { state: 'unrecorded', value: 'Not read' }
          : { state: swept?.state || 'todo', value: 'Holds funds', action: 'Sweep the launch wallet' };
  return [{ id: 'wallet', ...wallet }, { id: 'mint', ...token }, { id: 'liquidity', ...liquidity }, { id: 'finish', ...finish }];
}

function chainCoinSection(eyebrow, title, body, trailing = '') {
  return `<section class="coin-section"><div class="section-heading"><div><span class="eyebrow">${escapeHtml(eyebrow)}</span><h2>${escapeHtml(title)}</h2></div>${trailing}</div>${body}</section>`;
}

// The open row of an on-chain coin's page: what the chain and the launch record show for it.
function renderChainCoinPane(coin, workspace) {
  const pane = $('#coinChainPane');
  const supportPanel = $('#poolSupportPanel');
  if (!pane) return;
  if (!coin) {
    pane.hidden = true;
    pane.innerHTML = '';
    if (supportPanel) supportPanel.hidden = true;
    return;
  }
  const detail = chainCoinDetail(coin);
  const account = detail?.account && !detail.account.error ? detail.account : null;
  const creation = detail?.creation || null;
  const facts = (rows) => `<dl class="pool-support-facts">${rows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
  const parts = [];
  if (state.coins.detailLoading && !detail) parts.push('<p class="pool-support-status"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Reading the coin from the chain…</p>');
  if (state.coins.detailError) parts.push(`<p class="pool-support-error">${escapeHtml(state.coins.detailError)}</p>`);
  // Each row lists its own launch steps only when one is wrong or not done, and the next
  // step's action on the row it belongs to.
  const ROW_STEPS = { mint: ['token'], liquidity: ['pools', 'locks', 'reveal'], finish: ['return'] };
  const rowSteps = (creation?.steps || []).filter((step) => (ROW_STEPS[workspace] || []).includes(step.id) && !['done', 'recorded'].includes(step.state) && step.detail);
  if (rowSteps.length) {
    parts.push(`<ul class="coin-creation">${rowSteps.map((step) => {
      const meta = COIN_FACT_MARKS[step.state] || COIN_FACT_MARKS.todo;
      return `<li class="is-${escapeHtml(step.state)}" title="${escapeHtml(meta.label)}"><i class="fa-solid ${meta.icon}" aria-hidden="true"></i><span><strong>${escapeHtml(step.label)}</strong><small><span class="visually-hidden">${escapeHtml(meta.label)}: </span>${escapeHtml(step.detail)}</small></span></li>`;
    }).join('')}</ul>`);
  }
  const nextStep = (creation?.steps || []).find((step) => ['todo', 'mismatch', 'unrecorded'].includes(step.state));
  if (nextStep && (ROW_STEPS[workspace] || []).includes(nextStep.id)) parts.push(coinNextStepAction(creation, coin));
  const journal = creation?.journal || null;
  if (workspace === 'wallet') {
    if (journal?.createdAt) parts.push(chainCoinSection('Launch', 'Launched', facts([['Date', escapeHtml(formatDate(journal.createdAt))]])));
    parts.push(chainCoinSection('Activity', 'What has happened', coinActivityHtml(detail?.events || [])));
    if (coin.status === 'Added') parts.push(`<div class="coin-page-footer"><button class="text-button" type="button" data-action="remove-coin" data-mint="${escapeHtml(coin.mint)}">Remove from coins</button></div>`);
  } else if (workspace === 'mint') {
    if (account) {
      parts.push(chainCoinSection('On-chain', 'Token', facts([
        ['Supply', escapeHtml(formatTokenAmount(account.supply, account.decimals))],
        ['Mint authority', account.mintAuthority ? walletChipHtml(account.mintAuthority) : 'Revoked'],
        ['Freeze authority', account.freezeAuthority ? walletChipHtml(account.freezeAuthority) : 'Revoked'],
        ['Metadata', account.metadata ? (account.metadata.updateAuthority ? `Editable by ${walletChipHtml(account.metadata.updateAuthority)}` : 'Immutable') : 'Metaplex / unknown'],
      ]), coin.practice ? '' : `<span class="coin-links"><a class="pill-button link-button" href="https://solscan.io/token/${escapeHtml(coin.mint)}" target="_blank" rel="noopener">Solscan</a><a class="pill-button link-button" href="https://raydium.io/swap/?inputMint=sol&outputMint=${escapeHtml(coin.mint)}" target="_blank" rel="noopener">Raydium</a></span>`));
    }
    const airdrop = state.coins.airdrop?.mint === coin.mint ? state.coins.airdrop : null;
    if (airdrop?.recipients?.length || airdrop?.error) {
      parts.push(chainCoinSection('Airdrop', 'Who received it', coinAirdropHtml(airdrop), '<button class="pill-button" type="button" data-action="refresh-coin-airdrop">Refresh</button>'));
    }
  } else if (workspace === 'liquidity') {
    if (detail?.markets) parts.push(chainCoinSection('Markets', 'Pools', coinMarketsHtml(detail.markets), '<button class="pill-button" type="button" data-action="refresh-coin">Refresh</button>'));
    parts.push(coinMarketEvidenceHtml(coin.mint));
    parts.push(chainCoinSection('Positions', 'Your positions', coinPositionsHtml(), '<button class="pill-button" type="button" data-action="refresh-coin-positions">Refresh</button>'));
  } else if (workspace === 'finish') {
    const returnWallet = journal?.transfer?.destinationWallet || journal?.launchConfig?.poolTopology?.sweepDestination || null;
    const rows = [];
    if (creation?.walletPublicKey) rows.push(['Launch wallet', walletChipHtml(creation.walletPublicKey)]);
    if (returnWallet) rows.push(['Return wallet', walletChipHtml(returnWallet)]);
    parts.push(rows.length ? chainCoinSection('Wallets', 'Launch and return', facts(rows)) : '<p class="coins-empty">Not launched with Trebuchet.</p>');
  }
  pane.hidden = false;
  pane.innerHTML = parts.join('');
  if (supportPanel) {
    supportPanel.hidden = workspace !== 'liquidity';
    // A test coin has no real pool: buy support is simulated against a sample pool.
    const intro = supportPanel.querySelector('.pool-support-intro');
    if (intro) intro.textContent = coin.practice ? 'Test: nothing is sent.' : '';
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
  const eyebrow = $('#viewEyebrow');
  const title = $('#viewTitle');
  // Written once: redrawing it on every change would replace the button
  // under a click that is still in progress (a blur fires "change").
  if (eyebrow && !eyebrow.querySelector('[data-action="coins-back"]')) {
    eyebrow.innerHTML = `<button class="text-button coin-back-inline" type="button" data-action="coins-back"><i class="fa-solid fa-arrow-left"></i> Coins</button>`;
  }
  const chainCoin = chainCoinOnPage();
  if (chainCoin) {
    const detail = chainCoinDetail(chainCoin);
    const account = detail?.account && !detail.account.error ? detail.account : null;
    if (title) {
      title.innerHTML = coinCardHtml({
        name: account?.metadata?.name || detail?.info?.name || chainCoin.name,
        symbol: account?.metadata?.symbol || detail?.info?.symbol || chainCoin.symbol,
        address: chainCoin.mint,
        image: detail?.image || chainCoin.image || null,
      }, { variant: 'title', tag: 'span', status: coinStatus(chainCoin), trailing: tokenPriceChipHtml(chainCoin.mint) });
      hydrateCoinCards();
      hydrateTokenPriceChips();
    }
    return;
  }
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
