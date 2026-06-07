// ===========================================================================
// session.js — centralized launch session state
// ===========================================================================
//
// Every piece of launch state lives here.  Modules read/write session.*
// directly.  Save snapshots everything; Load restores everything and
// calls renderAll() to push state into the DOM.
//
// This replaces the scattered module-level let variables (tempWallet,
// createdTokenInfo, pools, lpResult, etc.) that made save/load fragile.

// ── Core state (all serializable) ──────────────────────────────────

const session = {
  // Step 1: Wallet
  wallet: null,          // { publicKey, secretKey, secretKeyB58, mnemonic, qrCode }

  // Step 2: Token config + vanity
  tokenConfig: {         // what the user typed in step 2
    name: '',
    symbol: '',
    description: '',
    totalSupply: '',
  },
  vanity: {
    mode: 'suffix',      // 'prefix' | 'suffix' | 'both'
    prefix: '',
    suffix: '',
    caKeypair: null,     // pre-ground CA secret key array (or null)
  },

  // Step 4: Created token info
  token: null,           // { mint, decimals, name, symbol, totalSupply, metadataUri, isSafe }

  // Step 2/5: Pool configuration
  pools: [],             // internal pool config objects
  targetMarketCapUsd: '',

  // Step 3: Funding
  fundingRqmt: { solLamports: 0, byQuote: {}, autoSwapPlan: [] },

  // Step 5: LP results
  lp: null,              // { results: [{ allocationIndex, poolId, ... }], failedPhase }

  // Step 6: Transfer
  transfer: null,        // { destinationWallet, txIds }

  // Progress
  currentStep: 1,
  stepSummaries: {},     // { 1: "ABC...xyz", 4: "RATi - RATxxx...", 5: "1 pool" }

  // Activity log
  activityEntries: [],

  // Journal linkage
  journalId: null,
  walletPublicKey: null,
  stage: null,           // raw journal stage
};

// ── Backward-compatible globals (existing code reads these directly) ──

// These are set by reference so existing modules that mutate them
// continue to work.  They ARE the session fields.
// tempWallet synced via syncGlobalsToSession()
// createdTokenInfo synced via syncGlobalsToSession()
// pools already declared in preamble.js; we share the reference below
// lpResult synced via syncGlobalsToSession()
// fundingRequirement already declared in preamble.js; reset below

// Keep tempWallet & createdTokenInfo synced with session
function syncGlobalsToSession() {
  if (session.wallet) tempWallet = session.wallet;
  else tempWallet = null;
  if (session.token) createdTokenInfo = session.token;
  else createdTokenInfo = null;
  if (session.lp) lpResult = session.lp;
  else lpResult = null;
}

// Share the pools array reference so existing code mutates session.pools directly.
pools.length = 0;
fundingRequirement.solLamports = 0;
fundingRequirement.byQuote = {};
fundingRequirement.autoSwapPlan.length = 0;

// ── Save / Load ────────────────────────────────────────────────────

/** Snapshot the current session to a plain object (no references). */
session.saveSnapshot = function() {
  return {
    wallet: session.wallet ? { ...session.wallet } : null,
    tokenConfig: { ...session.tokenConfig },
    vanity: {
      mode: session.vanity.mode,
      prefix: session.vanity.prefix,
      suffix: session.vanity.suffix,
      caKeypair: session.vanity.caKeypair ? session.vanity.caKeypair.slice() : null,
    },
    token: session.token ? { ...session.token } : null,
    pools: session.pools.map(function(p) { return { ...p }; }),
    targetMarketCapUsd: session.targetMarketCapUsd,
    fundingRqmt: {
      solLamports: session.fundingRqmt.solLamports,
      byQuote: { ...session.fundingRqmt.byQuote },
      autoSwapPlan: session.fundingRqmt.autoSwapPlan.slice(),
    },
    lp: session.lp ? { results: session.lp.results.slice(), failedPhase: session.lp.failedPhase } : null,
    transfer: session.transfer ? { ...session.transfer } : null,
    currentStep: session.currentStep,
    stepSummaries: { ...session.stepSummaries },
    activityEntries: session.activityEntries.slice(),
    journalId: session.journalId,
    walletPublicKey: session.walletPublicKey,
    stage: session.stage,
  };
};

/** Restore from a snapshot or journal object. */
session.restoreFromSnapshot = function(snap) {
  if (snap.wallet) session.wallet = { ...snap.wallet };
  if (snap.tokenConfig) session.tokenConfig = { ...snap.tokenConfig };
  if (snap.vanity) {
    session.vanity.mode = snap.vanity.mode || 'suffix';
    session.vanity.prefix = snap.vanity.prefix || '';
    session.vanity.suffix = snap.vanity.suffix || '';
    session.vanity.caKeypair = snap.vanity.caKeypair ? snap.vanity.caKeypair.slice() : null;
  }
  if (snap.token) session.token = { ...snap.token };
  if (snap.pools) {
    pools.length = 0;
    for (var i = 0; i < snap.pools.length; i++) pools.push({ ...snap.pools[i] });
  }
  if (snap.targetMarketCapUsd != null) session.targetMarketCapUsd = snap.targetMarketCapUsd;
  if (snap.fundingRqmt) {
    session.fundingRqmt.solLamports = snap.fundingRqmt.solLamports || 0;
    session.fundingRqmt.byQuote = snap.fundingRqmt.byQuote || {};
    session.fundingRqmt.autoSwapPlan = snap.fundingRqmt.autoSwapPlan || [];
  }
  if (snap.lp) session.lp = { results: snap.lp.results.slice(), failedPhase: snap.lp.failedPhase };
  if (snap.transfer) session.transfer = { ...snap.transfer };
  if (snap.currentStep) session.currentStep = snap.currentStep;
  if (snap.stepSummaries) session.stepSummaries = { ...snap.stepSummaries };
  if (snap.activityEntries) session.activityEntries = snap.activityEntries.slice();
  session.journalId = snap.journalId || null;
  session.walletPublicKey = snap.walletPublicKey || null;
  session.stage = snap.stage || null;
  syncGlobalsToSession();
};

// ── Journal adapter ─────────────────────────────────────────────────

/** Build a session snapshot from a launch journal (server-side format). */
session.fromJournal = function(journal) {
  var snap = {};

  // Wallet: comes from pendingWallets, not the journal itself.
  // Set externally via session.wallet = ... before calling this.

  // Token config from journal
  if (journal.token) {
    snap.tokenConfig = {
      name: journal.token.name || '',
      symbol: journal.token.symbol || '',
      description: journal.token.description || '',
      totalSupply: journal.token.totalSupply || '',
    };
    // If token has a mint, it was created
    if (journal.token.mint) {
      snap.token = {
        mint: journal.token.mint,
        decimals: journal.token.decimals || 9,
        name: journal.token.name || '',
        symbol: journal.token.symbol || '',
        totalSupply: journal.token.totalSupply || '',
        metadataUri: journal.token.metadataUri || '',
        isSafe: journal.token.isSafe || false,
      };
    }
  }

  // Vanity config
  snap.vanity = {
    mode: journal.vanityPrefix ? 'prefix' : (journal.vanitySuffix ? 'suffix' : 'suffix'),
    prefix: journal.vanityPrefix || '',
    suffix: journal.vanitySuffix || '',
    caKeypair: journal.vanityCAKeypair || null,
  };
  if (journal.vanityPrefix && journal.vanitySuffix) snap.vanity.mode = 'both';

  // Pools from poolPlan
  if (journal.poolPlan && Array.isArray(journal.poolPlan.allocations)) {
    snap.pools = journal.poolPlan.allocations.map(function(a) {
      return {
        quoteToken: a.quoteToken,
        supplyPercent: a.supplyPercent,
        ammConfigIndex: a.ammConfigIndex,
        quoteUsdOverride: a.quoteUsdOverride,
        quoteDecimalsOverride: a.quoteDecimalsOverride,
        quoteSymbolOverride: a.quoteSymbolOverride,
        slices: a.distribution || [],
        bootstrapConfig: a.bootstrap || { mode: 'minimal' },
        ladderConfig: a.ladder || { mode: 'off', bands: [] },
        support: a.support || 0,
        _fromJournal: true,
      };
    });
    if (journal.poolPlan.targetMarketCapUsd) {
      snap.targetMarketCapUsd = journal.poolPlan.targetMarketCapUsd;
    }
  }

  // LP results
  if (journal.lp && Array.isArray(journal.lp.results)) {
    snap.lp = { results: journal.lp.results.slice(), failedPhase: journal.lp.failedPhase || null };
  }

  // Transfer
  if (journal.transfer) {
    snap.transfer = { destinationWallet: journal.transfer.destinationWallet || '' };
  }

  // Stage → step mapping
  snap.stage = journal.stage;
  snap.walletPublicKey = journal.walletPublicKey;
  snap.journalId = journal.id;
  if (journal.stage === 'wallet_generated') snap.currentStep = 2;
  else if (journal.stage === 'token_create_started') snap.currentStep = 4;
  else if (journal.stage === 'token_created') snap.currentStep = 5;
  else if (journal.stage && journal.stage.startsWith('lp_')) snap.currentStep = 5;
  else if (journal.lp && journal.lp.results && journal.lp.results.length) snap.currentStep = 6;

  session.restoreFromSnapshot(snap);
};

/** Build a server-ready save payload from the current session. */
session.toSavePayload = function() {
  return session.saveSnapshot();
};

// ── UI rendering ────────────────────────────────────────────────────

/** Push all session state into the DOM. Call after any restore. */
session.renderAll = function() {
  // Step 1: Wallet display
  if (session.wallet) {
    var walletInfo = document.getElementById('walletInfo');
    if (walletInfo) walletInfo.classList.remove('hidden');
    var wa = document.getElementById('walletAddress');
    if (wa) wa.value = session.wallet.publicKey;
    if (typeof setQrCode === 'function') {
      setQrCode('qrCode', session.wallet.qrCode, session.wallet.publicKey);
    }
    document.getElementById('privateKeyContainer')?.classList.add('hidden');
    document.body.classList.add('has-log');
  }

  // Step 2: Token config fields
  if (session.tokenConfig) {
    var tn = document.getElementById('tokenName');
    if (tn && session.tokenConfig.name) tn.value = session.tokenConfig.name;
    var ts = document.getElementById('tokenSymbol');
    if (ts && session.tokenConfig.symbol) ts.value = session.tokenConfig.symbol;
    var td = document.getElementById('tokenDescription');
    if (td && session.tokenConfig.description) td.value = session.tokenConfig.description;
    var tsp = document.getElementById('tokenSupply');
    if (tsp && session.tokenConfig.totalSupply) tsp.value = session.tokenConfig.totalSupply;
  }

  // Vanity config
  if (session.vanity) {
    var vcm = document.getElementById('vanityCAMode');
    if (vcm && session.vanity.mode) vcm.value = session.vanity.mode;
    var vct = document.getElementById('vanityCATarget');
    if (vct) {
      if (session.vanity.mode === 'both') {
        vct.value = session.vanity.prefix || '';
        var vcs = document.getElementById('vanityCASuffixTarget');
        if (vcs) vcs.value = session.vanity.suffix || '';
        var vcsr = document.getElementById('vanityCASuffixRow');
        if (vcsr) vcsr.classList.remove('hidden');
      } else if (session.vanity.mode === 'prefix') {
        vct.value = session.vanity.prefix || '';
      } else {
        vct.value = session.vanity.suffix || '';
      }
    }
    // Restore pre-ground CA
    if (session.vanity.caKeypair) {
      try {
        var raw = session.vanity.caKeypair;
        if (typeof raw === 'string') raw = JSON.parse(raw);
        if (Array.isArray(raw) && raw.length === 64) {
          vanityCAKeypairs = [{
            publicKey: null,
            secretKey: raw,
            rarity: 'saved',
            epochs: 0,
            attempts: 0,
          }];
          selectedVanityCA = 0;
          if (typeof updateVanityCAResult === 'function') updateVanityCAResult();
        }
      } catch (_) {}
    }
  }

  // Step 4: Token created info
  if (session.token && session.token.mint) {
    var tci = document.getElementById('tokenCreatedInfo');
    if (tci) tci.classList.remove('hidden');
    var me = document.getElementById('tokenMintAddress');
    if (me) me.textContent = session.token.mint;
    var sl = document.getElementById('tokenSolscanLink');
    if (sl) sl.href = 'https://solscan.io/token/' + session.token.mint;
  }

  // Market cap
  var mcEl = document.getElementById('targetMarketCap');
  if (mcEl && session.targetMarketCapUsd) mcEl.value = session.targetMarketCapUsd;

  // Step summaries
  if (session.wallet) {
    var pk = session.wallet.publicKey;
    if (typeof setStepSummary === 'function') {
      setStepSummary(1, pk.slice(0, 8) + '\u2026' + pk.slice(-6));
    }
  }
  if (session.token && session.token.mint && typeof setStepSummary === 'function') {
    setStepSummary(4, (session.token.symbol || '?') + ' \u2014 ' + session.token.mint.slice(0, 8) + '\u2026');
  }

  // Buttons
  var hasToken = !!(session.token && session.token.mint);
  var hasLp = !!(session.lp && session.lp.results && session.lp.results.length);
  var ctb = document.getElementById('createTokenBtn');
  var clb = document.getElementById('createLpBtn');
  var tab = document.getElementById('transferAssetsBtn');
  if (ctb) ctb.classList.toggle('hidden', hasToken);
  if (clb) clb.classList.toggle('hidden', !hasToken || hasLp);
  if (tab) tab.classList.toggle('hidden', !hasLp);

  // Activate step
  if (typeof activateStep === 'function') {
    activateStep(session.currentStep || 2);
  }
  if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
  if (typeof updateCancelButtonState === 'function') updateCancelButtonState();

  // Grind button
  if (typeof setGrindButtonState === 'function') setGrindButtonState('grind');
};

// Expose for tests
window.__trebuchet_session = session;
window.__trebuchet_pools = pools;

