// Recent-launches panel
//
// Shows automatically-saved launch files so the user can resume where
// they left off — wallet, token, and pool state are all restored.

let _launchesLoaded = false;

async function loadRecentLaunches() {
  const panel = document.getElementById('recentLaunchesPanel');
  const list = document.getElementById('recentLaunchesList');
  if (!panel || !list) return;

  try {
    const resp = await fetch('/api/recent-launches');
    const data = await resp.json();
    if (!data.success || !Array.isArray(data.launches)) return;

    const launches = data.launches;
    if (launches.length === 0) {
      panel.classList.add('hidden');
      return;
    }

    list.innerHTML = '';
    for (const launch of launches) {
      list.appendChild(buildLaunchRow(launch));
    }
    panel.classList.remove('hidden');
    _launchesLoaded = true;
  } catch (e) {
    console.warn('Failed to load recent launches:', e);
  }
}

const STAGE_LABELS = {
  wallet_generated: 'Wallet generated',
  token_created: 'Token created',
  token_progress: 'Creating token…',
  lp_create_started: 'LP started',
  lp_resume_started: 'LP resumed',
  lp_locks: 'LP locking…',
  lp_transfers: 'LP transfers…',
};
const STAGE_ICONS = {
  wallet_generated: 'fa-wallet',
  token_created: 'fa-coins',
  token_progress: 'fa-spinner fa-pulse',
  lp_create_started: 'fa-water',
  lp_resume_started: 'fa-water',
  lp_locks: 'fa-lock',
  lp_transfers: 'fa-exchange-alt',
};

function buildLaunchRow(launch) {
  var wrap = document.createElement('div');
  wrap.className = 'box p-3 mb-2 is-size-7';

  var dateStr = new Date(launch.createdAt).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  var label = launch.token?.symbol || launch.token?.name || 'Unnamed';
  var pubShort = launch.walletPublicKey.slice(0, 6) + '\u2026' + launch.walletPublicKey.slice(-4);
  var stageLabel = STAGE_LABELS[launch.stage] || launch.stage;
  var stageIcon = STAGE_ICONS[launch.stage] || 'fa-circle';

  var meta = '';
  if (launch.token?.mint) meta += 'Mint: ' + launch.token.mint.slice(0, 8) + '\u2026  ';
  if (launch.lp?.poolCount) meta += launch.lp.poolCount + ' pool(s)  ';
  if (launch.transfer?.destination) meta += 'Transferred';

  wrap.innerHTML =
    '<div class="is-flex is-align-items-center mb-2" style="gap: 0.5rem;">' +
      '<span class="icon has-text-info"><i class="fas ' + stageIcon + '"></i></span>' +
      '<strong>' + escapeHtml(label) + '</strong>' +
      '<span class="has-text-grey">\u2014 ' + dateStr + '</span>' +
    '</div>' +
    '<div class="mb-1 has-text-grey is-size-7">' +
      '<span class="is-family-monospace">' + pubShort + '</span>' +
      ' &middot; ' + stageLabel +
      (meta ? ' &middot; ' + meta : '') +
    '</div>' +
    '<div class="field is-grouped mt-2">' +
      '<div class="control">' +
        '<button class="button is-small is-success" data-action="load-launch" data-id="' + launch.id + '">' +
          '<span class="icon is-small"><i class="fas fa-play"></i></span>' +
          '<span>Load</span>' +
        '</button>' +
      '</div>' +
      '<div class="control">' +
        '<button class="button is-small is-danger is-light" data-action="discard-launch" data-id="' + launch.id + '">' +
          '<span class="icon is-small"><i class="fas fa-trash"></i></span>' +
          '<span>Discard</span>' +
        '</button>' +
      '</div>' +
    '</div>';

  wrap.querySelector('[data-action="load-launch"]').addEventListener('click', async function() {
    try {
      var useResp = await fetch('/api/pending-wallets/use', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: launch.walletPublicKey }),
      });
      var useData = await useResp.json();
      if (!useData.success) throw new Error(useData.error || 'wallet not found');

      tempWallet = {
        publicKey: useData.wallet.publicKey,
        secretKey: useData.wallet.secretKey,
        qrCode: useData.wallet.qrCode,
      };
      document.getElementById('walletInfo').classList.remove('hidden');
      document.getElementById('walletAddress').value = useData.wallet.publicKey;
      if (typeof setQrCode === 'function') {
        setQrCode('qrCode', useData.wallet.qrCode, useData.wallet.publicKey);
      }

      createdTokenInfo = null;
      lpResult = null;
      fundingRequirement = { solLamports: 0, byQuote: {}, autoSwapPlan: [] };
      document.getElementById('privateKeyContainer').classList.add('hidden');
      document.getElementById('tokenCreatedInfo').classList.add('hidden');
      document.getElementById('createTokenBtn').classList.remove('hidden');
      document.getElementById('createLpBtn').classList.remove('hidden');
      document.body.classList.add('has-log');
      log('Loaded ' + (label || pubShort), 'success');

      var stateResp = await fetch('/api/launch-state?walletPublicKey=' + encodeURIComponent(launch.walletPublicKey));
      var stateData = await stateResp.json();
      if (stateData.success && stateData.state) {
        var s = stateData.state;
        if (s.token && s.token.mint) {
          createdTokenInfo = {
            mint: s.token.mint, decimals: s.token.decimals || 9,
            totalSupply: s.token.totalSupply, name: s.token.name || '', symbol: s.token.symbol || '',
          };
          document.getElementById('tokenCreatedInfo').classList.remove('hidden');
          document.getElementById('tokenMintAddress').textContent = s.token.mint;
          document.getElementById('tokenSolscanLink').href = 'https://solscan.io/token/' + s.token.mint;
          document.getElementById('createTokenBtn').classList.add('hidden');
        }
        if (s.lp && Array.isArray(s.lp.results) && s.lp.results.length > 0) {
          lpResult = { results: s.lp.results };
          document.getElementById('createLpBtn').classList.add('hidden');
          if (typeof setLpDoneVisible === 'function') setLpDoneVisible(true);
        }
        var stage = s.stage || '';
        for (var i = 1; i <= 6; i++) setStepSummary(i, '');
        setStepSummary(1, pubShort);
        if (createdTokenInfo) setStepSummary(4, createdTokenInfo.symbol + ' \u2014 ' + createdTokenInfo.mint.slice(0, 8) + '\u2026');
        if (lpResult) setStepSummary(5, lpResult.results.length + ' pool(s)');
        if (lpResult && lpResult.results && lpResult.results.length) activateStep(6);
        else if (stage.startsWith('lp_')) activateStep(5);
        else if (createdTokenInfo) activateStep(5);
        else activateStep(2);
        if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
        updateCancelButtonState();
      } else {
        activateStep(2);
        updateCancelButtonState();
      }
      panel.classList.add('hidden');
    } catch (e) {
      log('Failed to load launch: ' + e.message, 'danger');
    }
  });

  wrap.querySelector('[data-action="discard-launch"]').addEventListener('click', async function() {
    var ok = await confirmDialog({
      title: 'Discard launch?',
      body: '<p>Discard launch data for <strong>' + escapeHtml(label) + '</strong>?</p>' +
        '<p>This removes the journal entry. Recover funds from the wallet before discarding.</p>',
      confirmLabel: 'Discard', danger: true,
    });
    if (!ok) return;
    try {
      await fetch('/api/pending-wallets/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: launch.walletPublicKey }),
      });
      await loadRecentLaunches();
    } catch (e) {
      log('Failed to discard: ' + e.message, 'danger');
    }
  });

  return wrap;
}

export { loadRecentLaunches };
loadRecentLaunches();
