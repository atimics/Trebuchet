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
    wireRowButtons(wrap, wallet, pubShort, /*hasMnemonic=*/false);
    return wrap;
  }

  // Prefer the recovery phrase if this wallet was generated with one.
  // Older cached entries from before mnemonic support fall back to the
  // base58 secret key.
  const hasMnemonic = !!wallet.mnemonic;
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
        <button class="button is-small is-success" data-action="use-wallet">
          <span class="icon is-small"><i class="fas fa-play"></i></span>
          <span>Use this wallet</span>
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
  wireRowButtons(wrap, wallet, pubShort, hasMnemonic);
  return wrap;
}

// Wire the per-row buttons. Extracted so both the normal and the
// decryption-failed render paths share the same handler logic.
function wireRowButtons(wrap, wallet, pubShort, hasMnemonic) {
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
      const text = hasMnemonic ? wallet.mnemonic : wallet.secretKeyB58;
      if (!text) {
        log(`No secret available for ${pubShort}`, 'warning');
        return;
      }
      const what = hasMnemonic ? 'Recovery phrase' : 'Secret key';
      await copyToClipboard(text, `${what} for ${pubShort}`);
    });
  }

  wrap.querySelector('[data-action="copy-pubkey"]').addEventListener('click', async () => {
    await copyToClipboard(wallet.publicKey, `Public key ${pubShort}`);
  });

  // "Use this wallet" — loads it into the active session and checks
  // for an existing launch to resume (token mint, LP results, etc.).
  const useBtn = wrap.querySelector('[data-action="use-wallet"]');
  if (useBtn) {
    useBtn.addEventListener('click', async () => {
      try {
        const resp = await fetch('/api/pending-wallets/use', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ publicKey: wallet.publicKey }),
        });
        const data = await resp.json();
        if (!data.success) throw new Error(data.error);

        // Load the wallet into the session
        tempWallet = {
          publicKey: data.wallet.publicKey,
          secretKey: data.wallet.secretKey,
          qrCode: data.wallet.qrCode,
        };
        document.getElementById('walletInfo').classList.remove('hidden');
        document.getElementById('walletAddress').value = data.wallet.publicKey;
        if (typeof setQrCode === 'function') {
          setQrCode('qrCode', data.wallet.qrCode, data.wallet.publicKey);
        } else {
          document.getElementById('qrCode').src = data.wallet.qrCode || '';
        }

        // Reset stale state
        createdTokenInfo = null;
        lpResult = null;
        fundingRequirement = { solLamports: 0, byQuote: {}, autoSwapPlan: [] };
        document.getElementById('privateKeyContainer').classList.add('hidden');
        document.getElementById('tokenCreatedInfo').classList.add('hidden');
        document.getElementById('createTokenBtn').classList.remove('hidden');
        document.getElementById('createLpBtn').classList.remove('hidden');
        document.getElementById('transferAssetsBtn').classList.remove('hidden');
        document.body.classList.add('has-log');
        log(`Loaded wallet ${data.wallet.publicKey.slice(0, 8)}…`, 'success');

        // Check for launch to resume
        try {
          const stateResp = await fetch(
            `/api/launch-state?walletPublicKey=${encodeURIComponent(data.wallet.publicKey)}`,
          );
          const stateData = await stateResp.json();
          if (stateData.success && stateData.state) {
            const s = stateData.state;
            if (s.token && s.token.mint) {
              createdTokenInfo = {
                mint: s.token.mint,
                decimals: s.token.decimals || 9,
                totalSupply: s.token.totalSupply,
                name: s.token.name || '',
                symbol: s.token.symbol || '',
              };
              document.getElementById('tokenCreatedInfo').classList.remove('hidden');
              document.getElementById('tokenMintAddress').textContent = s.token.mint;
              document.getElementById('tokenSolscanLink').href =
                `https://solscan.io/token/${s.token.mint}`;
              document.getElementById('createTokenBtn').classList.add('hidden');
              log(`Resumed token ${s.token.symbol || s.token.mint.slice(0, 8)}`, 'info');
            }
            if (s.lp && Array.isArray(s.lp.results) && s.lp.results.length > 0) {
              lpResult = { results: s.lp.results };
              document.getElementById('createLpBtn').classList.add('hidden');
              if (typeof setLpDoneVisible === 'function') setLpDoneVisible(true);
              log(`Resumed LP: ${s.lp.results.length} pool(s)`, 'info');
            }
            // Jump to appropriate step
            const stage = s.stage || '';
            if (stage.startsWith('lp_') || (lpResult && lpResult.results && lpResult.results.length > 0)) {
              for (let i = 1; i <= 5; i++) setStepSummary(i, '');
              if (createdTokenInfo) setStepSummary(4, `${createdTokenInfo.symbol} — ${createdTokenInfo.mint.slice(0, 8)}…`);
              if (lpResult) setStepSummary(5, `${lpResult.results.length} pool(s)`);
              activateStep(lpResult ? 6 : 5);
            } else if (stage.startsWith('token_') || createdTokenInfo) {
              for (let i = 1; i <= 4; i++) setStepSummary(i, '');
              if (createdTokenInfo) setStepSummary(4, `${createdTokenInfo.symbol} — ${createdTokenInfo.mint.slice(0, 8)}…`);
              activateStep(5);
            } else {
              activateStep(2);
            }
            if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
            updateCancelButtonState();
          } else {
            activateStep(2);
            if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
            updateCancelButtonState();
          }
        } catch {
          activateStep(2);
        }

        // Close the pending-wallets panel
        const panel = document.getElementById('pendingWalletsPanel');
        if (panel) panel.classList.add('hidden');
      } catch (e) {
        log(`Failed to load wallet: ${e.message}`, 'danger');
      }
    });
  }

  wrap.querySelector('[data-action="dismiss"]').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Discard recovery entry?',
      body:
        `<p>Discard recovery entry for <strong>${escapeHtml(pubShort)}</strong>?</p>` +
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

