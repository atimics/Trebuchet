// ===========================================================================
// STEP 4: Create token
// ===========================================================================

bind('createTokenBtn', 'click', async () => {
  const btn = document.getElementById('createTokenBtn');
  await withRunState(async () => {
    setLoading(btn, true);
    markLaunchActiveForRpcHealth(true);
    try {
      log('Creating token...');
      const formData = new FormData();
      formData.append('tempWalletSecretKey', JSON.stringify(tempWallet.secretKey));
      formData.append('name', document.getElementById('tokenName').value.trim());
      formData.append('symbol', document.getElementById('tokenSymbol').value.trim());
      formData.append('description', document.getElementById('tokenDescription').value.trim());
      // Strip thousand-separator commas before sending. Keep this as a
      // string so large but valid SPL supplies do not lose integer precision
      // in JavaScript before the server converts to BigInt.
      const totalSupplyRaw = getIntegerInputString(document.getElementById('tokenSupply'));
      formData.append('totalSupply', totalSupplyRaw);
      // Quote mints from every configured pool. The server uses these to
      // search for a launched-token keypair that sorts smaller than all
      // of them, so the launched token is mintA in every pool. Filter out
      // pools whose mint hasn't resolved yet (e.g. user is mid-typing) —
      // the server will validate and either succeed with whatever's
      // present or fail loud.
      const quoteMints = pools
        .map((p) => p.resolvedMint)
        .filter((m) => typeof m === 'string' && m.length > 0);
      formData.append('quoteMints', JSON.stringify(quoteMints));
      // Vanity CA: if we pre-ground a keypair, send it. Otherwise
      // fall back to prefix/suffix for server-side grinding.
      if (selectedVanityCA !== null && vanityCAKeypairs[selectedVanityCA]) {
        formData.append('vanityCAKeypair', JSON.stringify(vanityCAKeypairs[selectedVanityCA].secretKey));
      } else {
        const vanityTarget = document.getElementById('vanityCATarget')?.value.trim();
        if (vanityTarget) {
          const vanityMode = document.getElementById('vanityCAMode')?.value || 'suffix';
          if (vanityMode === 'prefix') {
            formData.append('vanityPrefix', vanityTarget);
          } else {
            formData.append('vanitySuffix', vanityTarget);
          }
        }
      }
      const logoFile = document.getElementById('tokenLogo').files[0];
      if (logoFile) formData.append('logo', logoFile);

      const resp = await fetch('/api/create-token', { method: 'POST', body: formData });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);

      createdTokenInfo = {
        mint: data.tokenMint,
        decimals: data.decimals || 9,
        totalSupply: totalSupplyRaw,
        name: data.name || document.getElementById('tokenName').value.trim(),
        symbol: data.symbol || document.getElementById('tokenSymbol').value.trim(),
      };

      document.getElementById('tokenMintAddress').textContent = data.tokenMint;
      document.getElementById('tokenSolscanLink').href =
        `https://solscan.io/token/${data.tokenMint}`;
      document.getElementById('tokenCreatedInfo').classList.remove('hidden');
      // Hide the Create button after success — clicking it again would mint
      // a second token and overwrite createdTokenInfo, abandoning the first.
      document.getElementById('createTokenBtn').classList.add('hidden');
      log(`Token created: ${data.tokenMint}`, 'success');
    } catch (e) {
      log(`Token creation failed: ${e.message}`, 'danger');
      markLaunchActiveForRpcHealth(false);
    } finally {
      setLoading(btn, false);
    }
  });
});

bind('continueToLpBtn', 'click', () => {
  setStepSummary(4, `${createdTokenInfo.symbol} — ${createdTokenInfo.mint.slice(0, 8)}…`);
  renderLpSummary();
  activateStep(5);
});

// ===========================================================================
// STEP 5: Create LP
// ===========================================================================

function renderLpSummary() {
  const summary = document.getElementById('lpSummary');
  const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
  // Guard against zero / NaN total supply — the form field should never
  // accept that, but if something upstream produced a degenerate value
  // we surface a clear error instead of rendering "Infinity" or "NaN"
  // and proceeding into a broken launch.
  const totalSupply = Number(createdTokenInfo.totalSupply);
  if (!isFinite(totalSupply) || totalSupply <= 0) {
    summary.innerHTML =
      '<p class="has-text-danger"><strong>Invalid token supply.</strong> ' +
      'Please go back to Step 4, fix the total supply, and recreate the token.</p>';
    return;
  }
  const launchedTokenUsd = targetMc / totalSupply;

  // Escape every interpolation that includes user-provided or indexer-
  // sourced text. Token symbols, names, and quote symbols can contain
  // anything (the symbol field is free-form user input; resolvedSymbol
  // comes from on-chain metadata or third-party indexers and is not
  // sanitized at the source).
  const symSafe = escapeHtml(createdTokenInfo.symbol || '');

  let html = `
    <p>Ready to create <strong>${pools.length}</strong> pool${pools.length === 1 ? '' : 's'}
    for <strong>${symSafe}</strong> at <strong>$${launchedTokenUsd.toFixed(8)}</strong>
    per token (${targetMc.toLocaleString()} USD market cap).</p>
    <ul>
  `;
  for (const p of pools) {
    const quoteSafe = escapeHtml(p.resolvedSymbol || p.quoteToken || '');
    const sliceCount = p.distribution.length;
    const externalCount = p.distribution.filter((s) => s.useExternalRecipient && s.recipient).length;
    html += `<li><strong>${quoteSafe}</strong> pool — ${p.supplyPercent}% of supply, `;
    html += `${sliceCount} slice${sliceCount === 1 ? '' : 's'}`;
    if (externalCount > 0) html += ` (${externalCount} to external wallet${externalCount === 1 ? '' : 's'})`;
    html += `</li>`;
  }
  html += `</ul>`;
  html += `<p>Lock liquidity (Burn &amp; Earn): <strong>${document.getElementById('lockPositions').checked ? 'Yes' : 'No'}</strong></p>`;
  summary.innerHTML = html;
}

bind('createLpBtn', 'click', async () => {
  const btn = document.getElementById('createLpBtn');
  await withRunState(async () => {
    setLoading(btn, true);
    markLaunchActiveForRpcHealth(true);
    try {
      document.getElementById('lpProgress').classList.remove('hidden');
      document.getElementById('lpProgressTree').innerHTML = '';
      // Hide any stale failure banner from a prior attempt. This matters
      // for the pre-flight-retry case: if the previous attempt failed in
      // pre-flight and the user fixed their allocation, the failure
      // notification needs to go away when they re-click Create Pools so
      // they don't see "Validation failed..." next to a now-running launch.
      document.getElementById('lpFailInfo').classList.add('hidden');

      const allocations = buildAllocationsForApi();
      const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
      const lockPositions = document.getElementById('lockPositions').checked;

      log(`Starting pool creation for ${pools.length} pool(s)...`);
      addProgressIntro();
      buildPhaseProgressTree(pools, lockPositions);

      const resp = await fetch('/api/create-lp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tempWalletSecretKey: tempWallet.secretKey,
          tokenMint: createdTokenInfo.mint,
          tokenDecimals: createdTokenInfo.decimals,
          tokenTotalSupply: createdTokenInfo.totalSupply,
          targetMarketCapUsd: targetMc,
          allocations,
          lockPositions,
        }),
      });
      // The /api/create-lp endpoint returns JSON for both success (200)
      // and structured failure (500 with body). A non-JSON 5xx response
      // means something upstream of the route handler died (express
      // crashed, proxy returned an error page, etc) and the user
      // shouldn't see the cryptic "Unexpected token < in JSON" they'd
      // get from a blind resp.json().
      let data;
      try {
        data = await resp.json();
      } catch (parseErr) {
        if (!resp.ok) {
          throw new Error(
            `Server returned HTTP ${resp.status} with non-JSON body. ` +
            `This usually means the server crashed or a proxy intervened. ` +
            `Check the server console for details.`,
          );
        }
        throw new Error(`Unexpected response: ${parseErr.message}`);
      }

      if (data.success) {
        lpResult = data;
        data.results.forEach((r, i) => markPoolDone(i, r));
        markAllBootstrapsDone();
        log(`All ${data.results.length} pool(s) created and bootstrapped`, 'success');
        document.getElementById('lpDoneInfo').classList.remove('hidden');
        document.getElementById('lpDoneSummary').innerHTML = buildLpDoneSummary(data.results);
        renderLaunchReportPreview('step5');
        // Hide the Create Pools button — re-clicking would attempt to create
        // duplicate pools for the same token, which is wasteful and confusing.
        document.getElementById('createLpBtn').classList.add('hidden');
      } else {
        // Phase-aware partial-failure rendering. The orchestrator returns
        // failedPhase = 'pre_flight', 'main_positions', 'bootstrap', 'locks',
        // or 'transfers' so we can mark the right rows as failed without
        // misrepresenting what completed.
        //
        // Under the deferred-lock model:
        //   - 'main_positions': pool may have been created, slice opens failed
        //   - 'bootstrap': mains opened in every pool, some bootstraps failed
        //   - 'locks': all opens succeeded across all pools, some locks failed
        //   - 'transfers': all opens + locks succeeded, some Fee Key transfers
        //     failed (non-blocking — leftover NFTs sweep back to user)
        lpResult = { results: data.partialResults || [] };
        const failedPhase = data.failedPhase || 'main_positions';

        if (failedPhase === 'pre_flight') {
          // Validation failed BEFORE any pool was created — nothing is on
          // chain yet. Mark only the offending allocation as failed; the
          // others stay as "pending" since they were never attempted.
          // The lpFailInfo notification surfaces the reason (typically a
          // Token-2022 mint with extensions Raydium doesn't support).
          if (data.failedAllocationIndex != null) {
            markPoolFailed(data.failedAllocationIndex, data.error);
          }
        } else if (failedPhase === 'main_positions') {
          // Pools whose main positions completed successfully; the failed
          // pool's main row gets the failure marker. No bootstraps ran yet.
          (data.partialResults || []).forEach((r) => {
            markPoolDone(r.allocationIndex, r);
          });
          if (data.failedAllocationIndex != null) {
            markPoolFailed(data.failedAllocationIndex, data.error);
          }
        } else if (failedPhase === 'bootstrap') {
          // All main positions completed; bootstrapping failed partway.
          // Mark every pool's main rows as done, then mark each bootstrap
          // row done if its result entry has a populated bootstrap field,
          // and mark every failed pool's bootstrap as failed.
          (data.partialResults || []).forEach((r) => {
            markPoolDone(r.allocationIndex, r);
            if (r.bootstrap) markBootstrapDoneForPool(r.allocationIndex, r.bootstrap);
          });
          // bootstrapFailures is an array of { allocationIndex, quoteSymbol, error }
          // for each bootstrap that failed. Falls back to failedAllocationIndex
          // for backward compatibility with older error shapes that didn't carry
          // the array.
          const failures = data.bootstrapFailures
            || (data.failedAllocationIndex != null
              ? [{ allocationIndex: data.failedAllocationIndex, error: data.error }]
              : []);
          for (const f of failures) {
            markBootstrapFailedForPool(f.allocationIndex, f.error);
          }
        } else if (failedPhase === 'locks' || failedPhase === 'transfers') {
          // All pools, mains, and bootstraps are open on-chain. The failure
          // is in the post-open lock or transfer phase. Mark every pool's
          // main and bootstrap rows as done (they did open successfully),
          // but leave the per-position lock/transfer markers in their
          // current state — the partialResults entries carry per-position
          // `locked` and `transferredTo` flags that the progress tree could
          // be enhanced to read from later. For now the user sees a clear
          // recovery message via lpFailInfo below.
          (data.partialResults || []).forEach((r) => {
            markPoolDone(r.allocationIndex, r);
            if (r.bootstrap) markBootstrapDoneForPool(r.allocationIndex, r.bootstrap);
          });
        }

        log(`Pool creation failed (phase: ${failedPhase}): ${data.error}`, 'danger');
        document.getElementById('lpFailInfo').classList.remove('hidden');

        // Friendlier error summary. The raw on-chain error message is often
        // an opaque JSON blob ("InstructionError: [2, {Custom: 2022}]"); if
        // we recognize a known pattern, translate it into something a human
        // can act on. Otherwise pass through the original.
        const rawErr = String(data.error || 'unknown error');
        let friendly = rawErr;
        if (failedPhase === 'pre_flight') {
          // Pre-flight errors are already human-readable (we wrote them).
          // Pass through verbatim — they typically explain exactly which
          // unsupported Token-2022 extensions were detected.
          friendly = rawErr;
        } else if (/Custom["':]\s*2022/.test(rawErr)) {
          friendly =
            'Anchor constraint violation (code 2022, ConstraintMintTokenProgram) — ' +
            'this means a Token-2022 mint was passed where the SPL Token program was ' +
            'expected. This commonly happens with pump.fun tokens and other Token-2022 ' +
            'mints. The latest build should detect these automatically; if you\'re ' +
            'still seeing this, the quote token may have an unusual extension that\'s ' +
            'not yet supported.';
        } else if (/insufficient.*lamports|0x1.*lamports/i.test(rawErr)) {
          friendly =
            'The ephemeral wallet ran out of SOL partway through. Cost variance ' +
            'on this launch exceeded the safety buffer.';
        }
        document.getElementById('lpFailSummary').textContent = friendly;

        // Render structured error with category badge + "What happened?"
        const lpFailContainer = document.getElementById('lpFailInfo').querySelector('.notification');
        if (lpFailContainer) {
          // Clear any previous structured error block
          const prevBanner = lpFailContainer.querySelector('.error-banner');
          if (prevBanner) prevBanner.remove();
          renderStructuredError(lpFailContainer, friendly, categorizeError(friendly));
        }

        // Show counts so the user knows what state things are in. These are
        // useful for understanding what they're recovering vs what they've
        // permanently put on-chain.
        const successCount = (data.partialResults || []).length;
        const totalCount = pools.length;
        const failedAlloc = data.failedAllocation;
        const failedSymbol = failedAlloc?.quoteSymbol
          || failedAlloc?.quoteToken
          || `allocation ${data.failedAllocationIndex}`;

        if (failedPhase === 'pre_flight') {
          // Nothing was attempted on chain. Tell the user this is a clean
          // abort — no SOL spent, no on-chain artifacts to clean up. The
          // "Skip to Transfer Assets" path is still available (they may
          // want to abandon and try over) but the primary recovery is
          // just to fix the allocation and re-click Create Pools.
          document.getElementById('lpFailHeading').textContent =
            'Validation failed before pool creation started.';
          document.getElementById('lpFailSucceededCount').innerHTML =
            `Nothing has been created on-chain yet — the failure is in ` +
            `the pre-launch validation of <strong>${escapeHtml(failedSymbol)}</strong>. ` +
            `Fix or remove this allocation and click Create Pools again; no SOL was spent.`;
          document.getElementById('lpFailReassurance').innerHTML =
            `<strong>No on-chain side effects.</strong> The ephemeral wallet still holds ` +
            `everything it did before you clicked Create Pools (SOL, any auto-swapped ` +
            `quote tokens). You can either fix the failing allocation above and retry, ` +
            `or sweep everything back to your destination wallet.`;
          document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
            'Or sweep wallet to destination';
        } else {
          // Mid-launch failure — at least one pool was created and the
          // on-chain state can't be rolled back. Distinguish by phase:
          //   - 'bootstrap':  pools created, missing bootstraps. Recoverable
          //                   in place via Retry bootstraps.
          //   - 'locks':      all opens done across every pool, some locks
          //                   failed. Resume retries just the unlocked.
          //   - 'transfers':  all locks done, some Fee Key transfers failed.
          //                   Non-blocking — leftover NFTs sweep back to user.
          //   - 'main_positions' (default fallback): a slice open failed.
          //                   Not recoverable in place; must sweep and start
          //                   over (mid-Phase-1 partial recovery is a wider
          //                   refactor not done yet).
          let heading;
          if (failedPhase === 'bootstrap') {
            heading = 'Some pools couldn\'t be bootstrapped.';
          } else if (failedPhase === 'locks') {
            heading = 'Some positions couldn\'t be locked.';
          } else if (failedPhase === 'transfers') {
            heading = 'Some Fee Key transfers couldn\'t be delivered.';
          } else {
            heading = 'Pool creation failed partway through.';
          }
          document.getElementById('lpFailHeading').textContent = heading;
          document.getElementById('lpFailSucceededCount').innerHTML =
            `<strong>${successCount} of ${totalCount}</strong> pool${successCount === 1 ? '' : 's'} ` +
            `created successfully before the failure on <strong>${escapeHtml(failedSymbol)}</strong>. ` +
            `The created pools are permanent on-chain; their LP NFTs are in your ephemeral wallet.`;
          if (failedPhase === 'bootstrap') {
            // Bootstrap-only failures: pools and main positions are all
            // good, just the bootstrap leg is missing on some. Retrying
            // is safe and the typical fix.
            document.getElementById('lpFailReassurance').innerHTML =
              `<strong>Main positions are in place for every pool.</strong> Only the bootstrap ` +
              `leg failed for the pools listed above — these pools won't be tradable at the ` +
              `intended price until their bootstraps land. Click <strong>Retry bootstraps</strong> ` +
              `to try again (most bootstrap failures are transient RPC issues). If retrying ` +
              `keeps failing, sweep the wallet to your destination and manually add bootstrap ` +
              `liquidity in the Raydium UI later.`;
          } else if (failedPhase === 'locks') {
            // Lock-phase failures: every pool's main and bootstrap positions
            // are open on-chain (and the bootstraps make the pools tradable).
            // The positions just haven't been locked yet, which means the
            // ephemeral wallet can still close them — assets are recoverable
            // either by completing the locks or by sweeping the wallet back
            // (which would also close the open positions).
            document.getElementById('lpFailReassurance').innerHTML =
              `<strong>Every pool is open and tradable.</strong> The missing step is the lock — ` +
              `until locks finish, the LP'd tokens are still recoverable by the launch wallet. ` +
              `Click <strong>Resume launch</strong> to try the remaining locks again (most lock ` +
              `failures are transient RPC issues). If locks keep failing and you'd rather walk ` +
              `away, sweep the wallet to your destination — the open positions get closed and ` +
              `their LP tokens come back with the sweep.`;
          } else if (failedPhase === 'transfers') {
            // Transfer-phase failures are non-blocking conceptually: every
            // pool is locked successfully, only the courtesy of delivering
            // Fee Key NFTs to recipient addresses didn't complete. The
            // un-transferred NFTs are in the launch wallet and will sweep
            // to the user's destination wallet.
            document.getElementById('lpFailReassurance').innerHTML =
              `<strong>The launch itself succeeded.</strong> Every pool is created, tradable, and ` +
              `locked. The only thing that didn't finish was the delivery of Fee Key NFTs to ` +
              `recipient addresses you specified. Those NFTs are in your launch wallet and will ` +
              `come along with the final sweep to your destination wallet, so nothing is lost. ` +
              `You can manually send them to the intended recipients afterward, or click ` +
              `<strong>Resume launch</strong> to try the deliveries again.`;
          } else {
            // Main-positions failure: at least one pool was created but
            // its main positions couldn't be opened (or the next pool
            // couldn't be created). The resume endpoint can pick up
            // from where the failure happened — completed pools are
            // skipped, only the missing work is retried.
            document.getElementById('lpFailReassurance').innerHTML =
              `<strong>Your assets are safe</strong> — they're still in the ephemeral wallet ` +
              `(SOL, any auto-swapped quote tokens, and the LP NFTs from pools that did succeed). ` +
              `Click <strong>Resume launch</strong> to retry just the missing pools — already-` +
              `created pools will be skipped. If retrying keeps failing, you can sweep the wallet ` +
              `back to your destination as a last resort; the pools that succeeded above are ` +
              `permanent on-chain.`;
          }
          // Continue/sweep button label. For 'bootstrap' and 'locks',
          // the user has unfinished work that retry can fix in place,
          // so the sweep alternative reads as a secondary "give up"
          // option ("Or sweep to destination instead"). For 'transfers'
          // and the default main_positions case, the alternative IS
          // the primary recovery path (sweep collects everything),
          // so it reads as "Skip to Transfer Assets".
          document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
            (failedPhase === 'bootstrap' || failedPhase === 'locks')
              ? 'Or sweep to destination instead'
              : 'Skip to Transfer Assets';
        }

        // Resume button visibility: meaningful for any post-pre-flight
        // failure (main_positions, bootstrap, locks, transfers). The
        // button calls a unified /api/resume-launch endpoint that
        // inspects per-position state in priorResults and skips any
        // operation already done. Pre-flight failures don't need the
        // button — the user fixes the config and re-clicks Create Pools.
        const retryBtn = document.getElementById('retryBootstrapsBtn');
        const retryLabel = retryBtn.querySelector('span:last-child');
        if (failedPhase !== 'pre_flight') {
          retryBtn.classList.remove('hidden');
          // Phase-specific label. Bootstrap gets its own verb ("Retry
          // bootstraps") because that's the established muscle memory
          // for that case; everything else uses the generic "Resume launch"
          // since the resume endpoint will figure out what to do.
          if (retryLabel) {
            retryLabel.textContent = failedPhase === 'bootstrap'
              ? 'Retry bootstraps'
              : 'Resume launch';
          }
          // Stash the data the retry endpoint needs. We pull it back out
          // in the click handler instead of closing over it — the click
          // handler is registered once at module load and shouldn't
          // capture stale state from a specific failure.
          retryBtn.dataset.lockPositions = String(lockPositions);
        } else {
          retryBtn.classList.add('hidden');
        }

        // For mid-launch failures, hide the Create Pools button — pools
        // that were created already are immutable, and re-clicking would
        // attempt to create duplicate pools for the same token (wasteful
        // and confusing). Recovery is via "Skip to Transfer Assets".
        //
        // For pre-flight failures, KEEP the button visible — nothing was
        // attempted on chain. The user just needs to fix their allocation
        // (remove the incompatible quote, swap to a different mint, or
        // fix RPC settings) and click Create Pools again. Hiding the
        // button here would force them into "Skip to Transfer Assets",
        // wasting the SOL they already spent on token creation.
        if (failedPhase !== 'pre_flight') {
          document.getElementById('createLpBtn').classList.add('hidden');
        }
      }
    } catch (e) {
      log(`LP creation failed: ${e.message}`, 'danger');
      markLaunchActiveForRpcHealth(false);
    } finally {
      setLoading(btn, false);
    }
  });
});

// Build the entire progress tree as four phase blocks, matching the
// orchestrator's execution order:
//
//   Phase 1 — Create pools and open main positions
//   Phase 2 — Open bootstrap positions
//   Phase 3 — Lock positions (only when lockPositions=true)
//   Phase 4 — Transfer Fee Keys to recipients (only when at least one
//             slice has an external recipient AND lockPositions=true,
//             since Fee Keys only exist for locked positions)
//
// Within each phase, rows are listed pool-by-pool (Pool 1 things, then
// Pool 2 things, etc.). This is the structure that matches what the
// orchestrator actually does and produces a coherent narrative when the
// user reads top-to-bottom after a launch completes.
//
// Rows are uniquely identified by data-pool-idx + data-stage attributes
// rather than per-pool container IDs, so marker functions can query each
// row independently regardless of which phase block it lives in.
function buildPhaseProgressTree(pools, lockPositions) {
  const tree = document.getElementById('lpProgressTree');

  // Ladder context — same for every pool in the simple-UI flow (ladder
  // is currently a global toggle, not per-pool). Read from simpleConfig
  // rather than threading it through from the caller; the tree is built
  // at click time when the config is current. In customize mode the
  // ladder is always off (no per-pool ladder UI yet).
  const ladderEnabled =
    simpleConfig.mode === 'default' && simpleConfig.ladderEnabled;
  const ladderBandCount = ladderEnabled
    ? Number(simpleConfig.ladderBandCount) || LADDER_DEFAULT_BANDS
    : 0;

  // --- Phase 1: pool creates + main opens + ladder opens
  const phase1 = document.createElement('div');
  phase1.className = 'progress-pool';
  phase1.id = 'pp-phase1';
  let phase1Rows = '';
  pools.forEach((p, i) => {
    const label = `Pool ${i + 1} (${p.resolvedSymbol || p.quoteToken})`;
    const sliceCount = p.distribution.length;
    phase1Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="pool"><span class="icon">◯</span>${label} — Create pool</div>`;
    for (let s = 0; s < sliceCount; s++) {
      phase1Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="slice-${s}"><span class="icon">◯</span>${label} — Open slice ${s + 1} of ${sliceCount}</div>`;
    }
    // Ladder bands per pool, ordered low-to-high (band 1 = closest to launch)
    for (let b = 0; b < ladderBandCount; b++) {
      phase1Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="ladder-${b}"><span class="icon">◯</span>${label} — Open ladder band ${b + 1} of ${ladderBandCount}</div>`;
    }
  });
  phase1.innerHTML = `
    <p class="has-text-weight-bold">Phase 1 — Open main positions</p>
    <p class="is-size-7 has-text-grey mb-1">Pools are created and main positions opened (single-sided in your token). Positions are recoverable by the launch wallet until Phase 3 locks them.</p>
    ${phase1Rows}
  `;
  tree.appendChild(phase1);

  // --- Phase 2: bootstrap opens
  const phase2 = document.createElement('div');
  phase2.className = 'progress-pool';
  phase2.id = 'pp-phase2';
  let phase2Rows = '';
  pools.forEach((p, i) => {
    const label = `Pool ${i + 1} (${p.resolvedSymbol || p.quoteToken})`;
    phase2Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="bs-open"><span class="icon">◯</span>${label} — Open bootstrap</div>`;
  });
  phase2.innerHTML = `
    <p class="has-text-weight-bold mt-3">Phase 2 — Open bootstrap positions</p>
    <p class="is-size-7 has-text-grey mb-1">Each pool becomes tradable as its bootstrap lands. Runs after every pool's main positions are in place so all pools cross the tradability line together.</p>
    ${phase2Rows}
  `;
  tree.appendChild(phase2);

  // --- Phase 3: locks (mains, then ladder bands, then bootstrap — per pool)
  // Skipped entirely when lockPositions=false — there will be no locked
  // positions and so no Phase 3 work; rendering the rows would mislead
  // the user into thinking Phase 3 runs when the orchestrator actually
  // bypasses it.
  if (lockPositions) {
    const phase3 = document.createElement('div');
    phase3.className = 'progress-pool';
    phase3.id = 'pp-phase3';
    let phase3Rows = '';
    pools.forEach((p, i) => {
      const label = `Pool ${i + 1} (${p.resolvedSymbol || p.quoteToken})`;
      const sliceCount = p.distribution.length;
      for (let s = 0; s < sliceCount; s++) {
        phase3Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="lock-${s}"><span class="icon">◯</span>${label} — Lock slice ${s + 1}</div>`;
      }
      for (let b = 0; b < ladderBandCount; b++) {
        phase3Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="ladder-lock-${b}"><span class="icon">◯</span>${label} — Lock ladder band ${b + 1}</div>`;
      }
      phase3Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="bs-lock"><span class="icon">◯</span>${label} — Lock bootstrap</div>`;
    });
    phase3.innerHTML = `
      <p class="has-text-weight-bold mt-3">Phase 3 — Lock positions</p>
      <p class="is-size-7 has-text-grey mb-1">Locks burn the position NFTs and mint Fee Key NFTs. After this, the LP'd tokens are committed for life and only fees can be claimed. Failures are retryable in place.</p>
      ${phase3Rows}
    `;
    tree.appendChild(phase3);

    // --- Phase 4: transfers — only render if at least one slice has a recipient
    const anyRecipient = pools.some((p) =>
      p.distribution.some((d) => d.useExternalRecipient && d.recipient),
    );
    if (anyRecipient) {
      const phase4 = document.createElement('div');
      phase4.className = 'progress-pool';
      phase4.id = 'pp-phase4';
      let phase4Rows = '';
      pools.forEach((p, i) => {
        const label = `Pool ${i + 1} (${p.resolvedSymbol || p.quoteToken})`;
        const sliceCount = p.distribution.length;
        for (let s = 0; s < sliceCount; s++) {
          if (p.distribution[s].useExternalRecipient && p.distribution[s].recipient) {
            phase4Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="xfer-${s}"><span class="icon">◯</span>${label} — Transfer slice ${s + 1} Fee Key to recipient</div>`;
          }
        }
      });
      phase4.innerHTML = `
        <p class="has-text-weight-bold mt-3">Phase 4 — Transfer Fee Keys to recipients</p>
        <p class="is-size-7 has-text-grey mb-1">Sends the Fee Key NFTs for slices with external recipients to those recipient addresses. Transfer failures are non-blocking — any undelivered Fee Keys sweep back to your destination wallet at the end.</p>
        ${phase4Rows}
      `;
      tree.appendChild(phase4);
    }
  }
}

// One-time note added to the progress tree at the start of LP creation, to
// prevent the user from worrying that nothing is happening. Per-step progress
// tracking would require server-side streaming (SSE/WS) — for now the user
// just sees pending → done at the end. Server console shows the live progress.
function addProgressIntro() {
  const tree = document.getElementById('lpProgressTree');
  const note = document.createElement('div');
  note.className = 'notification is-info is-light is-size-7 py-2 px-3 mb-3';
  note.innerHTML =
    '<i class="fas fa-info-circle"></i>&nbsp;Creating pools and positions can take several minutes. ' +
    'Each step submits a transaction and waits for confirmation. ' +
    'Live progress is logged to the server console. ' +
    'The checkmarks below will populate when the operation completes.';
  tree.appendChild(note);
}

// Mark progress rows for a pool based on what actually completed.
//
// Under the phase-organized tree, each pool's rows are distributed
// across the four phase blocks (pp-phase1..pp-phase4). We find each
// row by its data-pool-idx + data-stage attribute combination, and
// inspect the corresponding piece of state on poolResult to decide
// whether to mark the row done.
//
// Per-position state we look at:
//   - poolResult.poolId               → "Create pool" row
//   - mainPositions[i].nftMint        → "Open slice i" row
//   - mainPositions[i].locked         → "Lock slice i" row
//   - mainPositions[i].transferredTo  → "Transfer slice i to recipient" row
//
// Bootstrap rows for this pool live in pp-phase2 (bs-open) and
// pp-phase3 (bs-lock); markBootstrapDoneForPool handles those.
//
// For full-success results (every state field populated), every row
// for the pool ends up green — matching what the user expects.
// For partial-failure results, rows whose underlying operation didn't
// finish stay in their pending/failed state. The user sees an honest
// picture of what's done vs. what isn't.
function markPoolDone(idx, poolResult) {
  // Pool creation row.
  if (poolResult && poolResult.poolId) {
    const poolRow = document.querySelector(
      `#lpProgressTree [data-pool-idx="${idx}"][data-stage="pool"]`,
    );
    if (poolRow) markRowDone(poolRow);
  }

  // Per-slice rows.
  const mp = Array.isArray(poolResult && poolResult.mainPositions)
    ? poolResult.mainPositions
    : [];
  for (let i = 0; i < mp.length; i++) {
    const pos = mp[i];
    if (pos && pos.nftMint) {
      const openRow = document.querySelector(
        `#lpProgressTree [data-pool-idx="${idx}"][data-stage="slice-${i}"]`,
      );
      if (openRow) markRowDone(openRow);
    }
    if (pos && pos.locked) {
      const lockRow = document.querySelector(
        `#lpProgressTree [data-pool-idx="${idx}"][data-stage="lock-${i}"]`,
      );
      if (lockRow) markRowDone(lockRow);
    }
    if (pos && pos.transferredTo) {
      const xferRow = document.querySelector(
        `#lpProgressTree [data-pool-idx="${idx}"][data-stage="xfer-${i}"]`,
      );
      if (xferRow) markRowDone(xferRow);
    }
  }

  // Per-ladder-band rows. Ladder bands have open and lock rows; no
  // transfer rows because ladder Fee Keys always sweep with the launch
  // wallet, never to external recipients.
  const lp = Array.isArray(poolResult && poolResult.ladderPositions)
    ? poolResult.ladderPositions
    : [];
  for (let b = 0; b < lp.length; b++) {
    const pos = lp[b];
    if (pos && pos.nftMint) {
      const openRow = document.querySelector(
        `#lpProgressTree [data-pool-idx="${idx}"][data-stage="ladder-${b}"]`,
      );
      if (openRow) markRowDone(openRow);
    }
    if (pos && pos.locked) {
      const lockRow = document.querySelector(
        `#lpProgressTree [data-pool-idx="${idx}"][data-stage="ladder-lock-${b}"]`,
      );
      if (lockRow) markRowDone(lockRow);
    }
  }
}

// Helper: flip a single row from pending/running to done.
function markRowDone(row) {
  row.classList.remove('pending', 'running');
  row.classList.add('done');
  const icon = row.querySelector('.icon');
  if (icon) icon.textContent = '✓';
}

function markPoolFailed(idx, err) {
  // Find the first pending row for this pool. Under the phase-organized
  // tree, that's the first row anywhere in lpProgressTree with the
  // matching data-pool-idx that hasn't transitioned to done yet. The
  // first such row is by definition the operation that failed (the
  // orchestrator's sequential execution means failures stop progress
  // at that point).
  const pending = document.querySelector(
    `#lpProgressTree [data-pool-idx="${idx}"].pending`,
  );
  if (pending) {
    pending.classList.remove('pending');
    pending.classList.add('failed');
    const icon = pending.querySelector('.icon');
    if (icon) icon.textContent = '✗';
    pending.title = err;
  }
}

// Mark all bootstrap rows as done. Called after the orchestrator returns
// full success — phase 2 (bs-open) and phase 3 (bs-lock) are both
// completed by definition, so every bootstrap row transitions to ✓.
//
// Under the phase-organized tree, bootstrap rows live in pp-phase2 (for
// bs-open) and pp-phase3 (for bs-lock). We select by stage attribute so
// the lookup is independent of which phase block hosts the rows.
function markAllBootstrapsDone() {
  document.querySelectorAll(
    '#lpProgressTree [data-stage="bs-open"], #lpProgressTree [data-stage="bs-lock"]',
  ).forEach((row) => markRowDone(row));
}

// Mark a specific pool's bootstrap rows based on actual state. Each pool
// has up to TWO bootstrap rows (bs-open in phase 2, bs-lock in phase 3);
// under the deferred-lock model, the open happens in Phase 2 and the lock
// in Phase 3, so a pool's bootstrap can be open-but-not-locked between
// those phases.
//
// Callers may pass a bootstrap result object via the second arg; if
// omitted, we default to "everything done" (the historical behavior used
// from the success path). Partial-failure callers should pass the actual
// bootstrap result to get accurate per-row marking.
function markBootstrapDoneForPool(allocationIndex, bootstrapResult) {
  const rows = document.querySelectorAll(
    `#lpProgressTree [data-pool-idx="${allocationIndex}"][data-stage^="bs-"]`,
  );
  rows.forEach((row) => {
    const stage = row.dataset.stage;
    if (!bootstrapResult) {
      markRowDone(row);
      return;
    }
    if (stage === 'bs-open' && bootstrapResult.nftMint) {
      markRowDone(row);
    } else if (stage === 'bs-lock' && bootstrapResult.locked) {
      markRowDone(row);
    }
  });
}

// Mark a specific pool's bootstrap rows as failed. Each pool has up to
// TWO bootstrap rows; we mark every pending one as failed because the
// bootstrap step is atomic from the user's perspective. If we only
// marked the first match, the bs-lock row would stay pending even
// though the work is unreachable until the open succeeds.
function markBootstrapFailedForPool(allocationIndex, err) {
  const rows = document.querySelectorAll(
    `#lpProgressTree [data-pool-idx="${allocationIndex}"][data-stage^="bs-"].pending`,
  );
  rows.forEach((row) => {
    row.classList.remove('pending');
    row.classList.add('failed');
    const icon = row.querySelector('.icon');
    if (icon) icon.textContent = '✗';
    row.title = err;
  });
}

function buildLpDoneSummary(results) {
  // Build the success summary shown after all pools land. Note we escape
  // quoteSymbol — for known quotes (SOL/USDC/etc) it's hard-coded safe,
  // but for user-supplied custom mints the symbol may have been read from
  // on-chain metadata or an indexer, which could contain anything. Better
  // to be paranoid than to allow a malicious token symbol to inject
  // markup into our success banner.
  //
  // Defensive on every field: mainPositions should always be populated
  // on the success path (orchestrator guarantees it), but if the result
  // shape ever changes or a partial result somehow lands here, we
  // shouldn't throw inside an HTML-building function and leave the
  // summary blank. A missing field renders as "0 main slices" — visibly
  // odd but doesn't break the page.
  let s = '';
  for (const r of results) {
    const sym = escapeHtml(r.quoteSymbol || '');
    const idShort = escapeHtml(r.poolId?.slice(0, 8) || '');
    const slices = Array.isArray(r.mainPositions) ? r.mainPositions : [];
    const ladder = Array.isArray(r.ladderPositions) ? r.ladderPositions : [];
    s += `<strong>${sym}</strong> pool: ${idShort}…, `;
    s += `${slices.length} main slice${slices.length === 1 ? '' : 's'}`;
    if (ladder.length > 0) {
      s += `, ${ladder.length} ladder band${ladder.length === 1 ? '' : 's'}`;
    }
    const ext = slices.filter((p) => p.transferredTo).length;
    if (ext > 0) s += ` (${ext} sent to external wallets)`;
    s += '<br>';
  }
  return s;
}

bind('continueToTransferBtn', 'click', () => {
  setStepSummary(5, `${lpResult.results.length} pool${lpResult.results.length === 1 ? '' : 's'} created`);
  prefillDestinationFromFunder();
  activateStep(6);
});

bind('continueToTransferAfterFailBtn', 'click', () => {
  setStepSummary(5, `partial — proceed to refund`);
  prefillDestinationFromFunder();
  activateStep(6);
});

bind('retryBootstrapsBtn', 'click', async () => {
  const btn = document.getElementById('retryBootstrapsBtn');
  const lockPositions = btn.dataset.lockPositions === 'true';
  const priorResults = lpResult?.results || [];

  if (!createdTokenInfo) {
    log('Token info missing — cannot resume launch.', 'danger');
    return;
  }

  await withRunState(async () => {
    setLoading(btn, true);
    markLaunchActiveForRpcHealth(true);
    try {
      log(`Resuming launch (${priorResults.length} pool${priorResults.length === 1 ? '' : 's'} carried over)…`);
      // Hide the fail banner while the resume runs so the user sees a
      // clean "in progress" state rather than the stale failure copy.
      document.getElementById('lpFailInfo').classList.add('hidden');

      // Reset any failed rows back to pending so progress is reflected.
      // We don't know exactly which rows will run this attempt (depends
      // on what got done last time), so we reset everything that's
      // currently marked failed.
      document.querySelectorAll('#lpProgressTree .progress-step.failed')
        .forEach((row) => {
          row.classList.remove('failed');
          row.classList.add('pending');
          const icon = row.querySelector('.icon');
          if (icon) icon.textContent = '◯';
          row.title = '';
        });

      const allocations = buildAllocationsForApi();
      const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
      const resp = await fetch('/api/resume-launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tempWalletSecretKey: tempWallet.secretKey,
          tokenMint: createdTokenInfo.mint,
          tokenDecimals: createdTokenInfo.decimals,
          tokenTotalSupply: createdTokenInfo.totalSupply,
          targetMarketCapUsd: targetMc,
          allocations,
          lockPositions,
          priorResults,
        }),
      });
      let data;
      try {
        data = await resp.json();
      } catch (parseErr) {
        if (!resp.ok) {
          throw new Error(
            `Server returned HTTP ${resp.status} with non-JSON body. ` +
            `Check the server console for details.`,
          );
        }
        throw new Error(`Unexpected response: ${parseErr.message}`);
      }

      if (data.success) {
        // Full success — every pool now has main positions + bootstrap.
        // Replace lpResult with the canonical full result so downstream
        // flows (transfer) see the up-to-date state.
        lpResult = data;
        data.results.forEach((r) => {
          markPoolDone(r.allocationIndex, r);
          markBootstrapDoneForPool(r.allocationIndex, r.bootstrap);
        });
        log(`All ${data.results.length} pool(s) created and bootstrapped`, 'success');
        document.getElementById('lpDoneInfo').classList.remove('hidden');
        document.getElementById('lpDoneSummary').innerHTML = buildLpDoneSummary(data.results);
        renderLaunchReportPreview('step5');
        markLaunchActiveForRpcHealth(false);
        return;
      }

      // Partial: at least one allocation still couldn't be completed.
      // The data has the same shape as a fresh create-lp failure:
      // partialResults, failedAllocationIndex, failedPhase, bootstrapFailures.
      // Update our lpResult so the next retry sees the latest state.
      lpResult = { results: data.partialResults || [] };
      const newPhase = data.failedPhase || 'main_positions';
      log(
        `Resume: ${(data.partialResults || []).length} pool(s) done, ` +
        `still failing (phase: ${newPhase}): ${data.error}`,
        'warning',
      );

      // Repaint progress tree to reflect new state. Mark every entry in
      // partialResults as done (both main and bootstrap rows depending
      // on what's populated), and mark the still-failing ones.
      (data.partialResults || []).forEach((r) => {
        markPoolDone(r.allocationIndex, r);
        if (r.bootstrap) markBootstrapDoneForPool(r.allocationIndex, r.bootstrap);
      });
      if (newPhase === 'bootstrap') {
        const failures = data.bootstrapFailures
          || (data.failedAllocationIndex != null
            ? [{ allocationIndex: data.failedAllocationIndex, error: data.error }]
            : []);
        for (const f of failures) {
          markBootstrapFailedForPool(f.allocationIndex, f.error);
        }
      } else if (newPhase === 'locks' || newPhase === 'transfers') {
        // Lock/transfer phase failures don't map to a single failing
        // allocation row — the failures are per-position and don't
        // belong on the pool-level progress markers. We've already
        // marked pools and bootstraps as done above; the per-position
        // detail lives in data.lockFailures / data.transferFailures
        // and gets surfaced via the lpFailInfo banner below.
      } else if (data.failedAllocationIndex != null) {
        markPoolFailed(data.failedAllocationIndex, data.error);
      }

      // Re-show the fail banner with updated counts so the user can
      // either retry again or give up via sweep. Heading + reassurance
      // copy mirrors the initial-failure branches so the UX stays
      // consistent whether the user is on attempt 1 or attempt N.
      document.getElementById('lpFailInfo').classList.remove('hidden');
      let resumeHeading;
      if (newPhase === 'bootstrap') {
        resumeHeading = 'Bootstraps still failing.';
      } else if (newPhase === 'locks') {
        resumeHeading = 'Some position locks still failing.';
      } else if (newPhase === 'transfers') {
        resumeHeading = 'Some Fee Key transfers still failing.';
      } else {
        resumeHeading = 'Pool creation still failing.';
      }
      document.getElementById('lpFailHeading').textContent = resumeHeading;
      document.getElementById('lpFailSummary').textContent = data.error;

      // Render structured error with category badge + "What happened?"
      const lpFailCtr = document.getElementById('lpFailInfo').querySelector('.notification');
      if (lpFailCtr) {
        const prevB = lpFailCtr.querySelector('.error-banner');
        if (prevB) prevB.remove();
        renderStructuredError(lpFailCtr, data.error, categorizeError(data.error));
      }

      const successCount = (data.partialResults || []).length;
      const totalCount = allocations.length;
      document.getElementById('lpFailSucceededCount').innerHTML =
        `<strong>${successCount}</strong> of ${totalCount} pool${totalCount === 1 ? '' : 's'} ` +
        `completed; the rest are still failing. Click <strong>${newPhase === 'bootstrap' ? 'Retry bootstraps' : 'Resume launch'}</strong> ` +
        `to try again, or sweep the wallet to start over.`;
      // Resume button stays visible for another attempt. Update its
      // label too — a retry can shift phases (e.g. main-positions
      // failure resolves but uncovers a bootstrap-only failure), and
      // the button label should reflect that. For locks/transfers we
      // keep the generic "Resume launch" label since those don't have
      // a dedicated retry verb.
      const retryLabel = btn.querySelector('span:last-child');
      if (retryLabel) {
        retryLabel.textContent = newPhase === 'bootstrap'
          ? 'Retry bootstraps'
          : 'Resume launch';
      }
      // Phase-specific reassurance copy (mirrors the initial-failure
      // path's branches so retry messaging stays consistent).
      if (newPhase === 'bootstrap') {
        document.getElementById('lpFailReassurance').innerHTML =
          `<strong>Main positions are in place for every pool.</strong> Only the bootstrap ` +
          `leg failed for the pools listed above — these pools won't be tradable at the ` +
          `intended price until their bootstraps land. Click <strong>Retry bootstraps</strong> ` +
          `to try again (most bootstrap failures are transient RPC issues). If retrying ` +
          `keeps failing, sweep the wallet to your destination and manually add bootstrap ` +
          `liquidity in the Raydium UI later.`;
        document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
          'Or sweep to destination instead';
      } else if (newPhase === 'locks') {
        document.getElementById('lpFailReassurance').innerHTML =
          `<strong>Every pool is open and tradable.</strong> The missing step is the lock — ` +
          `until locks finish, the LP'd tokens are still recoverable by the launch wallet. ` +
          `Click <strong>Resume launch</strong> to try the remaining locks again. If locks ` +
          `keep failing and you'd rather walk away, sweep the wallet to your destination — ` +
          `the open positions get closed and their LP tokens come back with the sweep.`;
        document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
          'Or sweep to destination instead';
      } else if (newPhase === 'transfers') {
        document.getElementById('lpFailReassurance').innerHTML =
          `<strong>The launch itself succeeded.</strong> Every pool is created, tradable, and ` +
          `locked. The only thing that didn't finish was the delivery of Fee Key NFTs to ` +
          `recipient addresses. Those NFTs are in your launch wallet and will sweep to your ` +
          `destination wallet, so nothing is lost. You can manually send them to the intended ` +
          `recipients afterward, or click <strong>Resume launch</strong> to try the deliveries ` +
          `again.`;
        document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
          'Skip to Transfer Assets';
      } else {
        document.getElementById('lpFailReassurance').innerHTML =
          `<strong>Your assets are safe</strong> — they're still in the ephemeral wallet ` +
          `(SOL, any auto-swapped quote tokens, and the LP NFTs from pools that did succeed). ` +
          `Click <strong>Resume launch</strong> to retry just the missing pools — already-` +
          `created pools will be skipped. If retrying keeps failing, you can sweep the wallet ` +
          `back to your destination as a last resort; the pools that succeeded above are ` +
          `permanent on-chain.`;
        document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
          'Skip to Transfer Assets';
      }
    } catch (e) {
      log(`Resume failed: ${e.message}`, 'danger');
      markLaunchActiveForRpcHealth(false);
      // Show the fail banner again so the user can see what to do next.
      document.getElementById('lpFailInfo').classList.remove('hidden');
    } finally {
      setLoading(btn, false);
    }
  });
});

// Pre-fill the Step 6 destination input with the detected funding wallet,
// IF the user hasn't already typed something there. This is a convenience —
// the user still has to click through the confirmation modal that displays
// the full address before any transfer actually runs.
function prefillDestinationFromFunder() {
  const dest = document.getElementById('destinationWallet');
  if (!dest) return;
  if (!dest.value && fundingWallet) {
    dest.value = fundingWallet;
    log(`Pre-filled destination with detected funder. Verify before transferring.`, 'warning');
  }
}


// Vanity CA grind — pre-grinds the token mint address before token creation
let vanityCAKeypairs = []; // [{ publicKey, secretKey, rarity, epochs, attempts }]
let selectedVanityCA = null; // index into vanityCAKeypairs

// ---- Vanity CA epoch tiers (authoritative from C binary) ----
// Rarity colors: Common=blue, Rare=green, Legendary=orange, Mythic=purple
const VANITY_TIERS = [
  { name: 'Common',    max: 1, color: '#3e8ed0' },
  { name: 'Rare',      max: 2, color: '#48c774' },
  { name: 'Legendary', max: 3, color: '#f4a236' },
  { name: 'Mythic',    max: Infinity, color: '#9b59b6' },
];

// Get the tier index for a given epoch value
function tierForEpoch(epoch) {
  for (let i = 0; i < VANITY_TIERS.length; i++) {
    if (epoch <= VANITY_TIERS[i].max) return i;
  }
  return VANITY_TIERS.length - 1;
}

// Reset the single progress bar for a new grind
function setupGrindBar() {
  const bar = document.getElementById('vanityCAProgressBar');
  const label = document.getElementById('vanityCAProgressText');
  if (bar) {
    bar.style.width = '0%';
    bar.style.background = '#e0d6c2';
  }
  if (label) label.textContent = 'Grinding...';
}

// Update the single progress bar with epoch data
function updateGrindBar(epoch, attempts) {
  const bar = document.getElementById('vanityCAProgressBar');
  const label = document.getElementById('vanityCAProgressText');
  if (!bar || !label) return;

  const tierIdx = tierForEpoch(epoch);
  const tier = VANITY_TIERS[tierIdx];
  const prevMax = tierIdx === 0 ? 0 : VANITY_TIERS[tierIdx - 1].max;
  const tierPct = Math.min(100, ((epoch - prevMax) / (tier.max - prevMax)) * 100);
  const colors = VANITY_TIERS.map(t => t.color);

  // Bar width = current tier progress (0-100% within the tier)
  bar.style.width = tierPct + '%';

  // Background: completed tiers shown as gradient, current tier solid
  if (tierIdx === 0) {
    bar.style.background = colors[0];
  } else {
    // Completed tiers each get a fixed portion of the bar's background
    let gradient = 'linear-gradient(to right';
    const segPct = 20; // each completed tier takes 20% of the current bar
    for (let i = 0; i < tierIdx; i++) {
      const start = i * segPct;
      const end = (i + 1) * segPct;
      gradient += ', ' + colors[i] + ' ' + start + '%, ' + colors[i] + ' ' + end + '%';
    }
    gradient += ', ' + colors[tierIdx] + ' ' + (tierIdx * segPct) + '%, ' + colors[tierIdx] + ' 100%';
    gradient += ')';
    bar.style.background = gradient;
  }

  label.textContent = tier.name + ' · Epoch ' + epoch.toFixed(2) + ' · ' + attempts.toLocaleString() + ' attempts';
}

// ---- Live key display below the grind bar ----
// Shows the most recent tested key when it has prefix/suffix matches.
// Match chars are colored by rarity tier: blue(1) green(2) orange(3) purple(4+)
const MATCH_COLORS = [
  null,          // 0 matches — not shown
  '#3e8ed0',     // 1-char: Common blue
  '#48c774',     // 2-char: Rare green
  '#f4a236',     // 3-char: Legendary orange
  '#9b59b6',     // 4-char: Mythic purple
  '#9b59b6',     // 5+
  '#9b59b6',     // 6+
  '#9b59b6',     // 7+
  '#9b59b6',     // 8+
  '#9b59b6',     // 9+
  '#9b59b6',     // 10+
];

let _keyDisplayTarget = '';
let _lastKeyShown = '';

function countMatchChars(key, target) {
  // Count how many distinct chars of target appear anywhere in key.
  if (!target || !key) return 0;
  const keySet = new Set(key);
  let n = 0;
  for (const ch of target) {
    if (keySet.has(ch)) n++;
  }
  return n;
}

function updateKeyDisplay(key, target) {
  if (!key || key === _lastKeyShown) return;
  const matchCount = countMatchChars(key, target);
  if (matchCount === 0) return;
  _lastKeyShown = key;

  const el = document.getElementById('vanityCAKeyDisplay');
  if (!el || el.offsetParent === null) return;

  const targetSet = new Set(target);
  const color = MATCH_COLORS[Math.min(matchCount, MATCH_COLORS.length - 1)];
  let html = '<span class="is-family-monospace is-size-7" style="line-height:1.3;">';
  for (let i = 0; i < key.length; i++) {
    const isMatch = targetSet.has(key[i]);
    if (isMatch) {
      html += '<span class="vanity-char-match" style="color:' + color + ';display:inline-block;animation:vanityCharPop 0.3s ease-out;">' + key[i] + '</span>';
    } else {
      html += '<span style="color:#666">' + key[i] + '</span>';
    }
  }
  html += '</span>';
  el.innerHTML = html;
}

function setupKeyDisplay(target) {
  _keyDisplayTarget = target;
  _lastKeyShown = '';

  let container = document.getElementById('vanityCAKeyDisplay');
  if (!container) {
    container = document.createElement('div');
    container.id = 'vanityCAKeyDisplay';
    container.style.cssText = 'text-align:center;padding:6px 4px 2px;overflow:hidden;';
    const progressEl = document.getElementById('vanityCAProgress');
    if (progressEl) {
      const textEl = document.getElementById('vanityCAProgressText');
      if (textEl) textEl.parentNode.insertBefore(container, textEl);
      else progressEl.appendChild(container);
    }
  }
  container.innerHTML = '<span class="is-family-monospace is-size-7" style="color:#555;">waiting for matches…</span>';
}

function removeKeyDisplay() {
  const container = document.getElementById('vanityCAKeyDisplay');
  if (container) container.remove();
}

bind('grindCABtn', 'click', async () => {
  const btn = document.getElementById('grindCABtn');
  const target = document.getElementById('vanityCATarget').value.trim();
  if (!target) {
    log('Enter a vanity target first.', 'warn');
    return;
  }

  await withRunState(async () => {
    setLoading(btn, true);
    try {
      const mode = document.getElementById('vanityCAMode').value;
      const isSuffix = mode === 'suffix';

      // Show single active progress bar
      const progressEl = document.getElementById('vanityCAProgress');
      const listContainer = document.getElementById('vanityCAListContainer');
      if (progressEl) progressEl.classList.remove('hidden');
      if (listContainer) listContainer.classList.add('hidden');

      // Ensure original bar is visible, remove any old epoch bars
      const barContainer = progressEl?.querySelector('.vanity-progress-bar');
      if (barContainer) barContainer.style.display = '';
      const oldEpochBars = document.getElementById('vanityCAEpochBars');
      if (oldEpochBars) oldEpochBars.remove();
      setupGrindBar();
      setupKeyDisplay(target);

      const params = new URLSearchParams();
      if (isSuffix) params.set('suffix', target);
      else params.set('prefix', target);
      // Pass the session token as a query param — EventSource can't set
      // custom headers, so the SSE endpoint validates it inline.
      try {
        const sessionToken = await window.getApiSessionToken();
        if (sessionToken) params.set('token', sessionToken);
      } catch (_) { /* proceed without token; server will reject if required */ }
      const es = new EventSource('/api/generate-vanity-wallet-stream?' + params.toString());

      es.onerror = () => { es.close(); };

      await new Promise((resolve, reject) => {
        es.addEventListener('message', (e) => {
          let data;
          try { data = JSON.parse(e.data); } catch { return; }
          if (data.type === 'start') {
            // Metadata received
          } else if (data.type === 'progress') {
            updateGrindBar(data.epoch, data.attempts);
            if (data.key) updateKeyDisplay(data.key, _keyDisplayTarget);
          } else if (data.type === 'done') {
            es.close();
            removeKeyDisplay();
            const entry = {
              publicKey: data.wallet.publicKey,
              secretKey: data.wallet.secretKey,
              rarity: data.wallet.rarity,
              epochs: data.wallet.epochs,
              attempts: data.wallet.attempts,
              seed: data.wallet.seed,
            };
            vanityCAKeypairs.push(entry);
            if (progressEl) progressEl.classList.add('hidden');
            if (listContainer) listContainer.classList.remove('hidden');
            renderVanityCAList();
            log('Vanity CA: ' + data.wallet.publicKey + ' (' + data.wallet.rarity + ', ' + data.wallet.attempts.toLocaleString() + ' attempts)', 'success');
            resolve();
          } else if (data.type === 'error') {
            es.close();
            reject(new Error(data.error));
          }
        });
        es.addEventListener('error', () => {
          es.close();
          reject(new Error('SSE connection failed'));
        });
      });
    } catch (e) {
      log('Vanity CA grind failed: ' + e.message, 'danger');
      removeKeyDisplay();
      document.getElementById('vanityCAProgress')?.classList.add('hidden');
      // Clean up any extra elements
      const epochBars = document.getElementById('vanityCAEpochBars');
      if (epochBars) epochBars.remove();
    } finally {
      setLoading(btn, false);
    }
  });
});

// Render the list of collected vanity CAs
function renderVanityCAList() {
  const listEl = document.getElementById('vanityCAList');
  const emptyEl = document.getElementById('vanityCAListEmpty');
  if (!listEl) return;

  if (vanityCAKeypairs.length === 0) {
    listEl.innerHTML = '';
    if (emptyEl) emptyEl.classList.remove('hidden');
    return;
  }

  if (emptyEl) emptyEl.classList.add('hidden');

  const tierColors = { Common: 'is-info', Rare: 'is-success', Legendary: 'is-warning', Mythic: 'is-danger' };
  let html = '';
  vanityCAKeypairs.forEach((ca, i) => {
    const color = tierColors[ca.rarity] || 'is-light';
    const selected = i === selectedVanityCA;
    html += `<div class="vanity-ca-row ${selected ? 'vanity-ca-selected' : ''}" data-index="${i}" style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;border-bottom:1px solid var(--rule, #ddd);">
      <span class="is-family-monospace is-size-7" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${ca.publicKey}</span>
      <span class="tag ${color} is-size-7">${ca.rarity} (${ca.epochs.toFixed(1)}&times;)</span>
      <span class="is-size-7 has-text-grey">${ca.attempts.toLocaleString()} tries</span>
      ${selected ? '<span class="tag is-success is-size-7">Selected</span>' : ''}
    </div>`;
  });
  listEl.innerHTML = html;

  // Bind click handlers for selection
  listEl.querySelectorAll('.vanity-ca-row').forEach(row => {
    row.addEventListener('click', () => {
      const idx = parseInt(row.dataset.index, 10);
      selectedVanityCA = idx;
      renderVanityCAList();
      const targetEl = document.getElementById('vanityCATarget');
      if (targetEl) targetEl.value = '';
      log(`Selected CA: ${vanityCAKeypairs[idx].publicKey}`, 'info');
    });
  });
}

// Clear collected CAs (called on wallet regenerate / full reset)
function clearVanityCAs() {
  vanityCAKeypairs = [];
  selectedVanityCA = null;
  renderVanityCAList();
}
