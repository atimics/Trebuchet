function returnWalletStatus() {
  const address = String($('#sweepDestination')?.value || '').trim();
  const funder = state.destinations.funder || state.fundingWallet?.funder || null;
  if (!address) return { kind: 'funder', address: funder };
  if (state.destinations.signed.includes(address)) return { kind: 'signed', address };
  if (funder && address === funder) return { kind: 'funder', address };
  return { kind: 'unverified', address };
}

async function refreshDestinations({ force = false } = {}) {
  if (state.apiStatus !== 'connected' || !state.apiClient?.listDestinations) return null;
  const launchWallet = selectedLaunchWalletPublicKey() || '';
  const fresh = state.destinations.launchWallet === launchWallet
    && Date.now() - state.destinations.checkedAt < 15000;
  if (fresh && !force) return state.destinations;
  try {
    const result = await state.apiClient.listDestinations(launchWallet);
    const funders = (Array.isArray(result?.funders) ? result.funders : [])
      .map((entry) => ({ address: String(entry?.address || ''), sol: Number(entry?.sol || 0) }))
      .filter((entry) => entry.address && entry.sol > 0);
    const fundersChanged = JSON.stringify(funders) !== JSON.stringify(state.destinations.funders || []);
    state.destinations = {
      ...state.destinations,
      funders,
      funder: result?.funder || null,
      signed: (result?.signed || []).map((entry) => entry.address),
      launchWallet,
      checkedAt: Date.now(),
    };
    // The funder list feeds the airdrop plan and supply split.
    if (fundersChanged) {
      renderAll();
      return state.destinations;
    }
  } catch (_error) {
    state.destinations = { ...state.destinations, launchWallet, checkedAt: Date.now() };
  }
  renderReturnWalletCard();
  renderReportPanel();
  return state.destinations;
}

function setReturnWallet(address) {
  const input = $('#sweepDestination');
  if (!input) return;
  input.value = String(address || '');
  state.executionReadiness = null;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  renderAll();
}

// Opens the signing page in the browser (where wallet extensions live) and
// watches for the newly signed wallet.
function openWalletSigning() {
  if (state.apiStatus !== 'connected') {
    notify('Wallet signing needs the Trebuchet desktop app');
    return;
  }
  window.open(`${window.location.origin}/v2/sign.html`, '_blank', 'noopener');
  const before = new Set(state.destinations.signed);
  const deadline = Date.now() + 5 * 60 * 1000;
  state.destinations.waiting = true;
  renderReturnWalletCard();
  notify('Sign with your wallet in the browser window that just opened');
  const poll = async () => {
    await refreshDestinations({ force: true });
    const added = state.destinations.signed.find((address) => !before.has(address));
    if (added) {
      state.destinations.waiting = false;
      setReturnWallet(added);
      notify(`Return wallet verified: ${shortAddress(added)}`);
      return;
    }
    if (Date.now() < deadline && state.destinations.waiting) {
      window.setTimeout(poll, 3000);
    } else {
      state.destinations.waiting = false;
      renderReturnWalletCard();
    }
  };
  window.setTimeout(poll, 3000);
}

// "Where assets go": the main return wallet (Fee Keys, leftover SOL, and
// unshared held-back tokens), plus the funding wallets that may share the
// held-back tokens, split by the SOL each sent.
function assetDestinationsHtml() {
  const status = returnWalletStatus();
  const others = state.destinations.signed.filter((address) => address !== status.address);
  const title = status.kind === 'signed'
    ? 'A wallet you signed with'
    : status.kind === 'funder'
      ? status.address ? 'The wallet you funded from' : 'The wallet you fund from'
      : 'Not verified';
  const badge = status.kind === 'unverified' ? '<span class="risk-badge danger">Not verified</span>' : '';
  const address = status.address ? `<code>${escapeHtml(status.address)}</code>` : '';
  const warning = status.kind === 'unverified'
    ? '<p class="return-wallet-warning">This address was typed, not proven. Assets will not be sent to it. Sign with it, or use the funding wallet.</p>'
    : '';

  const share = heldSharePlan();
  const locked = heldShareLocked();
  const funders = state.destinations.funders || [];
  const selected = new Set(state.heldShare.selected || []);
  const heldLabel = share.heldPercent > 0
    ? `${Number(share.heldPercent.toFixed(2))}% held back`
    : 'No tokens held back';
  const shareRows = funders.map((entry, index) => {
    const inCsv = share.csvWallets.has(entry.address);
    const checked = selected.has(entry.address) && !inCsv;
    const row = share.rows.find((item) => item.wallet === entry.address);
    const detail = [
      `sent ${fmtSol(entry.sol)}`,
      index === 0 ? 'first funder' : null,
      inCsv ? 'already in the airdrop list' : null,
    ].filter(Boolean).join(' · ');
    const shareText = row
      ? `${compactAmount(row.tokens)} tokens · ${Number(((entry.sol / share.totalSol) * 100).toFixed(1))}%`
      : checked ? 'Hold back tokens to share' : '';
    return `
      <li class="${checked ? 'is-selected' : ''}">
        <label>
          <input type="checkbox" data-action="toggle-held-share" data-address="${escapeHtml(entry.address)}" ${checked ? 'checked' : ''} ${locked || inCsv ? 'disabled' : ''}>
          <span><code>${escapeHtml(entry.address)}</code><small>${escapeHtml(detail)}</small></span>
          <strong>${escapeHtml(shareText)}</strong>
        </label>
      </li>`;
  }).join('');
  const shareBody = funders.length
    ? `<ul class="asset-share-list">${shareRows}</ul>
       <p class="return-wallet-note">${share.heldPercent > 0
         ? 'Ticked wallets split the held-back tokens by the SOL each sent. Anyone can send SOL to the launch wallet, so only tick wallets you recognize and check the full address.'
         : 'Hold back part of the supply (More options, Supply and pools) to share it with funding wallets.'}${locked ? ' Locked: the token is created.' : ''}</p>`
    : `<p class="return-wallet-note">Funding wallets show here once SOL arrives. Tick any of them to share the ${escapeHtml(heldLabel)}, split by the SOL each sent.</p>`;

  return `
    <div class="return-wallet-head"><span>Where assets go</span>${badge}</div>
    <div class="asset-destination">
      <small class="eyebrow">Return wallet</small>
      <strong>${escapeHtml(title)}</strong>
      ${address}
      ${warning}
      <p class="return-wallet-note">Gets the Fee Keys (they collect the pools' trading fees), leftover SOL and any held-back tokens.</p>
      <div class="operator-toolbar compact">
        <button class="pill-button" type="button" data-action="sign-return-wallet" ${state.destinations.waiting ? 'disabled' : ''}>
          ${state.destinations.waiting ? 'Waiting for signature…' : 'Sign with another wallet'}
        </button>
        ${status.kind !== 'funder' || String($('#sweepDestination')?.value || '').trim()
          ? '<button class="pill-button" type="button" data-action="use-funding-wallet-sweep">Use funding wallet</button>'
          : ''}
        ${others.map((other) => `<button class="pill-button" type="button" data-action="use-signed-wallet" data-address="${escapeHtml(other)}">Use ${escapeHtml(shortAddress(other))}</button>`).join('')}
      </div>
    </div>
    ${share.heldPercent > 0 || share.active ? `<div class="asset-destination asset-share">
      <small class="eyebrow">Share the ${escapeHtml(heldLabel)}</small>
      <strong>${share.active ? `Split across ${share.rows.length} funding wallet${share.rows.length === 1 ? '' : 's'}` : 'Funding wallets'}</strong>
      ${shareBody}
    </div>` : ''}`;
}

// ---------------------------------------------------------------------------
// Coins
// ---------------------------------------------------------------------------
//
// A coin exists from the moment it is started: a draft (saved plan), then
// an address, then on-chain state. Creating the token is one action on it,
// not the app's destination. On-chain facts are read fresh from the chain;
// the app's records are claims to check against it.
