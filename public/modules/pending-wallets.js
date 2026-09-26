// ===========================================================================
// Pending-wallet recovery panel
// ---------------------------------------------------------------------------
// The server caches the secret key of any temporary wallet it generates and
// only removes it once the final transfer step has confirmed the wallet is
// on-chain empty. So if the app crashed or was closed mid-launch on a
// previous session, those entries show up here and the user can copy the
// secret key out for manual recovery.
//
// Important: the panel only ever shows entries that existed *at startup*.
// Wallets generated during the current session are not surfaced here —
// the user can already see them in Step 1, and showing them in a "recover
// previous session" panel during the active flow is misleading and
// alarming. After a refresh or restart, anything still in the cache then
// becomes visible — which is exactly when the panel actually matters.
//
// `pendingWalletStartupKeys` is the snapshot taken on first load. Once
// it's set, refreshes filter the server's response down to only entries
// whose publicKey was in the snapshot.
// ===========================================================================

let pendingWalletStartupKeys = null;

async function loadPendingWallets() {
  const panel = document.getElementById('pendingWalletsPanel');
  const list = document.getElementById('pendingWalletsList');
  if (!panel || !list) return;

  try {
    // Fetch the journals too: any wallet that has a matching launch journal
    // is now shown — with its recovery phrase — inside that journal's card
    // (see buildLaunchJournalRow). So this panel only needs to surface
    // "orphan" wallets with no journal, which avoids showing the same
    // wallet in two places. Using the current journal set (not the startup
    // snapshot) means a wallet re-appears here if its journal is later
    // dismissed without discarding the wallet.
    const [resp, journalResp] = await Promise.all([
      fetch('/api/pending-wallets').then((r) => r.json()),
      fetch('/api/launch-journals').then((r) => r.json()).catch(() => ({ journals: [] })),
    ]);
    let wallets = (resp && resp.wallets) || [];
    const journalWalletKeys = new Set(
      ((journalResp && journalResp.journals) || [])
        .map((j) => j.walletPublicKey)
        .filter(Boolean),
    );

    // First call: capture the set of pubkeys present at startup. Anything
    // generated during this session is added to the server-side cache but
    // won't be in this set, so it'll be filtered out below.
    if (pendingWalletStartupKeys === null) {
      pendingWalletStartupKeys = new Set(wallets.map((w) => w.publicKey));
    }

    // Filter: only show entries that were in the startup snapshot, are
    // still present in the cache, AND have no matching journal (those are
    // handled by the journal card).
    wallets = wallets.filter(
      (w) => pendingWalletStartupKeys.has(w.publicKey) && !journalWalletKeys.has(w.publicKey),
    );

    if (wallets.length === 0) {
      panel.classList.add('hidden');
      list.innerHTML = '';
      return;
    }

    list.innerHTML = '';
    for (const w of wallets) {
      list.appendChild(buildPendingWalletRow(w));
    }
    panel.classList.remove('hidden');
  } catch (e) {
    console.warn('Failed to load pending wallets:', e);
    // Don't show the panel if we couldn't fetch — better silent than
    // misleading.
    panel.classList.add('hidden');
  }
}

// Construct one row in the recovery panel. Truncated public key, age,
// "Copy secret key" button, "Discard" button.
function buildPendingWalletRow(wallet) {
  const wrap = document.createElement('div');
  wrap.className = 'box p-3 mb-2 is-size-7';

  const pubShort = `${wallet.publicKey.slice(0, 6)}…${wallet.publicKey.slice(-6)}`;
  const ageStr = formatAge(wallet.createdAt);

  // Locked-PIN branch: the file is fine, but the in-memory PIN key has not
  // been unlocked yet. Keep this visually softer than real decryption failure.
  if (wallet.secretPinLocked) {
    wrap.innerHTML = `
      <div class="mb-2">
        <strong>Public key:</strong>
        <span class="is-family-monospace">${pubShort}</span>
        &nbsp;<span class="has-text-grey">(${ageStr})</span>
      </div>
      <div class="notification is-info is-light is-size-7 py-2 px-3 mb-2">
        <strong>Recovery PIN locked.</strong> Unlock it to reveal this wallet's recovery phrase or secret key.
      </div>
      <div class="field is-grouped">
        <div class="control">
          <button class="button is-small is-info" data-action="unlock-pin">
            <span class="icon is-small"><i class="fas fa-unlock"></i></span>
            <span>Unlock PIN</span>
          </button>
        </div>
        <div class="control">
          <button class="button is-small" data-action="copy-pubkey">
            <span class="icon is-small"><i class="fas fa-copy"></i></span>
            <span>Copy public key</span>
          </button>
        </div>
        <div class="control">
          <button class="button is-small is-danger is-light" data-action="dismiss">
            <span class="icon is-small"><i class="fas fa-trash"></i></span>
            <span>Discard</span>
          </button>
        </div>
      </div>
    `;
    wireRowButtons(wrap, wallet, pubShort);
    return wrap;
  }

  // Decryption-failed branch: the file is on disk but we can't read the
  // secret material. Most common cause is the OS keychain has rotated
  // (e.g. file was copied from another machine, user account changed).
  // We can't help recover it from the app — surface the situation, let
  // the user discard.
  if (wallet.decryptionFailed) {
    wrap.innerHTML = `
      <div class="mb-2">
        <strong>Public key:</strong>
        <span class="is-family-monospace">${pubShort}</span>
        &nbsp;<span class="has-text-grey">(${ageStr})</span>
      </div>
      <div class="notification is-danger is-light is-size-7 py-2 px-3 mb-2">
        <strong>Cannot decrypt this entry.</strong> The OS keychain key has
        likely changed since this wallet was generated (file was copied to a
        different user account or machine, or the keychain was reset). The
        secret material in this entry is unrecoverable from inside the app.
        If you have a backup of the recovery phrase elsewhere, use that.
      </div>
      <div class="field is-grouped">
        <div class="control">
          <button class="button is-small" data-action="copy-pubkey">
            <span class="icon is-small"><i class="fas fa-copy"></i></span>
            <span>Copy public key</span>
          </button>
        </div>
        <div class="control">
          <button class="button is-small is-danger is-light" data-action="dismiss">
            <span class="icon is-small"><i class="fas fa-trash"></i></span>
            <span>Discard</span>
          </button>
        </div>
      </div>
    `;
    wireRowButtons(wrap, wallet, pubShort);
    return wrap;
  }

  // Prefer the recovery phrase if this wallet was generated with one.
  // Older cached entries from before mnemonic support fall back to the
  // base58 secret key.
  const hasMnemonic = !!wallet.hasMnemonic;
  const copyLabel = hasMnemonic ? 'Copy recovery phrase' : 'Copy secret key';
  const copyIcon = hasMnemonic ? 'fa-list-ol' : 'fa-key';

  wrap.innerHTML = `
    <div class="mb-2">
      <strong>Public key:</strong>
      <span class="is-family-monospace">${pubShort}</span>
      &nbsp;<span class="has-text-grey">(${ageStr})</span>
    </div>
    <div class="field is-grouped">
      <div class="control">
        <button class="button is-small is-info" data-action="copy-secret">
          <span class="icon is-small"><i class="fas ${copyIcon}"></i></span>
          <span>${copyLabel}</span>
        </button>
      </div>
      <div class="control">
        <button class="button is-small" data-action="copy-pubkey">
          <span class="icon is-small"><i class="fas fa-copy"></i></span>
          <span>Copy public key</span>
        </button>
      </div>
      <div class="control">
        <button class="button is-small is-danger is-light" data-action="dismiss">
          <span class="icon is-small"><i class="fas fa-trash"></i></span>
          <span>Discard</span>
        </button>
      </div>
    </div>
  `;
  wireRowButtons(wrap, wallet, pubShort, { hasMnemonic });
  return wrap;
}

// Wire the per-row buttons. Extracted so both the normal and the
// decryption-failed render paths share the same handler logic.
function wireRowButtons(wrap, wallet, pubShort, { hasMnemonic = false } = {}) {
  // Centralised clipboard helper so we don't duplicate the try/catch
  // every time. navigator.clipboard.writeText can throw in non-secure
  // contexts (older Electron, http://), if the page doesn't have focus,
  // or if the user has denied clipboard permission. Without this guard
  // the rejection floats up as an unhandled promise rejection and the
  // user has no idea the copy didn't happen.
  const copyToClipboard = async (text, description) => {
    try {
      await navigator.clipboard.writeText(text);
      log(`${description} copied to clipboard`, 'info');
    } catch (e) {
      log(
        `Couldn't copy ${description} (${e.message}). ` +
        `Open the file at the pendingWallets path and copy the secret manually.`,
        'warning',
      );
    }
  };

  // copy-secret button only exists in the normal render path
  const copySecretBtn = wrap.querySelector('[data-action="copy-secret"]');
  if (copySecretBtn) {
    copySecretBtn.addEventListener('click', async () => {
      try {
        const revealed = await revealPendingWalletSecret(wallet.publicKey);
        const text = hasMnemonic ? revealed.mnemonic : revealed.secretKeyB58;
        if (!text) {
          log(`No secret available for ${pubShort}`, 'warning');
          return;
        }
        const what = hasMnemonic ? 'Recovery phrase' : 'Secret key';
        await copyToClipboard(text, `${what} for ${pubShort}`);
      } catch (e) {
        log(`Couldn't reveal recovery secret for ${pubShort}: ${e.message}`, 'warning');
      }
    });
  }

  wrap.querySelector('[data-action="unlock-pin"]')?.addEventListener('click', async () => {
    if (typeof showSecretPinModal === 'function') {
      await showSecretPinModal('unlock');
      await loadPendingWallets();
      if (typeof loadLaunchJournals === 'function') await loadLaunchJournals();
    }
  });

  wrap.querySelector('[data-action="copy-pubkey"]').addEventListener('click', async () => {
    await copyToClipboard(wallet.publicKey, `Public key ${pubShort}`);
  });

  wrap.querySelector('[data-action="dismiss"]').addEventListener('click', async () => {
    // Check the live balance before letting the user discard the only
    // stored copy of this wallet's key. Dismissing a wallet that still
    // holds funds is irreversible money loss (unless the user saved the
    // phrase elsewhere), so a generic "are you sure" isn't enough — say
    // exactly what's in it. Best effort: if the balance lookup fails
    // (offline, RPC down) fall back to the generic warning rather than
    // blocking the dismissal.
    let balanceLine = '';
    try {
      const resp = await fetch('/api/check-balance-detailed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: wallet.publicKey }),
      });
      const data = await resp.json();
      if (data.success && data.balance) {
        const sol = Number(data.balance.sol || 0);
        const tokenCount = Object.values(data.balance.tokens || {})
          .filter((t) => { try { return BigInt(t.amountRaw) > 0n; } catch (_) { return false; } })
          .length;
        // Mirror the server's dust rule (walletRecovery.js): under
        // 0.001 SOL with no token balances is unsweepable dust, not funds.
        if (sol >= 0.001 || tokenCount > 0) {
          const parts = [];
          if (sol > 0) parts.push(`<strong>${sol.toFixed(6)} SOL</strong>`);
          if (tokenCount > 0) parts.push(`<strong>${tokenCount} token balance${tokenCount === 1 ? '' : 's'}</strong>`);
          balanceLine =
            `<p class="has-text-danger">This wallet still holds ${parts.join(' and ')}. ` +
            `Discarding the recovery entry makes those funds unrecoverable unless ` +
            `you have saved the recovery phrase somewhere else.</p>`;
        } else {
          balanceLine = '<p>On-chain check: this wallet is empty (dust only).</p>';
        }
      }
    } catch (_) { /* offline / RPC error — keep the generic warning */ }

    const ok = await confirmDialog({
      title: 'Discard recovery entry?',
      body:
        `<p>Discard recovery entry for <strong>${escapeHtml(pubShort)}</strong>?</p>` +
        balanceLine +
        `<p>Only do this if you've already moved any funds out of this wallet, ` +
        `or you're sure none were ever sent there. This action cannot be undone.</p>`,
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!ok) return;
    try {
      await fetch('/api/pending-wallets/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: wallet.publicKey }),
      });
      await loadPendingWallets();
    } catch (e) {
      log(`Failed to dismiss recovery entry: ${e.message}`, 'danger');
    }
  });
}

// "3 hours ago" / "5 days ago" / etc. Plain-English age display.
function formatAge(isoString) {
  const then = new Date(isoString).getTime();
  if (!Number.isFinite(then)) return 'unknown age';

  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60)        return 'just now';
  if (seconds < 3600)      return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400)     return `${Math.floor(seconds / 3600)} hr ago`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)} days ago`;
  return new Date(isoString).toLocaleDateString();
}

// Recent launches: saved launch journals the user can load to resume.

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
    '</div>';

  wrap.querySelector('[data-action="load-launch"]').addEventListener('click', async function() {
    try {
      // PIN-gated: a locked Recovery PIN refuses here instead of leaking the key.
      var revealed = await revealPendingWalletSecret(launch.walletPublicKey);
      var wallet = {
        publicKey: revealed.publicKey,
        secretKey: revealed.secretKey,
        secretKeyB58: revealed.secretKeyB58 || null,
        mnemonic: revealed.mnemonic || null,
      };

      var stateResp = await fetch('/api/launch-state?walletPublicKey=' + encodeURIComponent(launch.walletPublicKey));
      var stateData = await stateResp.json();
      if (!stateData.success || !stateData.state) throw new Error('launch state not found');

      // Delegate to the shared resume helper (journals.js) which
      // restores wallet, token, pool plan, and LP state correctly.
      prepareRecoveredSessionFromJournal(stateData.state, wallet);

      document.body.classList.add('has-log');
      log('Loaded ' + (label || pubShort), 'success');
      panel.classList.add('hidden');
    } catch (e) {
      log('Failed to load launch: ' + e.message, 'danger');
    }
  });

  return wrap;
}

// loadRecentLaunches is exposed via window.loadRecentLaunches.
setTimeout(function() { loadRecentLaunches(); }, 100);
window.loadRecentLaunches = loadRecentLaunches;
