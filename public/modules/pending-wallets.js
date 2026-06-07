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
    // 8-second timeout so the loading spinner never hangs forever.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    const resp = await fetch('/api/recent-launches', { signal: ac.signal });
    clearTimeout(timer);
    const data = await resp.json();
    if (!data.success || !Array.isArray(data.launches)) return;

    // Clear the loading placeholder now that we have a response.
    const loadingEl = document.getElementById('recentLaunchesLoading');
    if (loadingEl) loadingEl.remove();

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
    // Remove the loading placeholder so the panel doesn't appear stuck.
    const loadingEl = document.getElementById('recentLaunchesLoading');
    if (loadingEl) loadingEl.remove();
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

      var wallet = {
        publicKey: useData.wallet.publicKey,
        secretKey: useData.wallet.secretKey,
        secretKeyB58: useData.wallet.secretKeyB58,
        mnemonic: useData.wallet.mnemonic,
      };

      var stateResp = await fetch('/api/launch-state?walletPublicKey=' + encodeURIComponent(launch.walletPublicKey));
      var stateData = await stateResp.json();
      if (!stateData.success || !stateData.state) throw new Error('launch state not found');

      // Delegate to the shared resume helper (journals.js) which
      // restores wallet, token, pool plan, and LP state correctly.
      prepareRecoveredSessionFromJournal(stateData.state, wallet);

      if (typeof setQrCode === 'function' && useData.wallet.qrCode) {
        setQrCode('qrCode', useData.wallet.qrCode, useData.wallet.publicKey);
      }

      document.body.classList.add('has-log');
      log('Loaded ' + (label || pubShort), 'success');
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

// loadRecentLaunches is exposed via window.loadRecentLaunches.
setTimeout(function() { loadRecentLaunches(); }, 100);
window.loadRecentLaunches = loadRecentLaunches;
