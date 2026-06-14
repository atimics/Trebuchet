// ===========================================================================
// Solflare browser wallet
// ===========================================================================

let solflareWallet = null;
let solflareWalletProvider = null;
let walletStandardSolflareProvider = null;
let walletStandardListenersStarted = false;
const walletStandardWallets = [];
const SOLFLARE_PROVIDER_WAIT_MS = 1500;

function collectSolflareProviderCandidates() {
  const candidates = [];
  const add = (provider) => {
    if (!provider || candidates.includes(provider)) return;
    candidates.push(provider);
  };

  add(window.solflare);
  add(window.solana);

  const solanaProviders = window.solana?.providers;
  if (Array.isArray(solanaProviders)) {
    solanaProviders.forEach(add);
  } else if (solanaProviders && typeof solanaProviders === 'object') {
    Object.values(solanaProviders).forEach(add);
  }

  return candidates;
}

function isSolflareProvider(provider) {
  if (!provider || typeof provider.connect !== 'function') return false;
  const name = String(provider.name || provider.walletName || '').toLowerCase();
  return (
    provider === window.solflare ||
    provider.isSolflare === true ||
    name.includes('solflare')
  );
}

function isSolflareStandardWallet(wallet) {
  if (!wallet) return false;
  const name = String(wallet.name || '').toLowerCase();
  const hasSolanaChain = Array.isArray(wallet.chains)
    && wallet.chains.some((chain) => String(chain).startsWith('solana:'));
  return name.includes('solflare') && hasSolanaChain;
}

function standardWalletAccountAddress(wallet) {
  const account = wallet?.accounts?.[0];
  return publicKeyToString(account?.address || account?.publicKey);
}

function standardWalletFeature(wallet, name) {
  const feature = wallet?.features?.[name];
  return feature && typeof feature === 'object' ? feature : null;
}

function createStandardSolflareProvider(wallet) {
  if (walletStandardSolflareProvider?.wallet === wallet) return walletStandardSolflareProvider;

  walletStandardSolflareProvider = {
    isSolflare: true,
    name: wallet.name,
    wallet,
    get publicKey() {
      return standardWalletAccountAddress(wallet);
    },
    get isConnected() {
      return Boolean(standardWalletAccountAddress(wallet));
    },
    async connect() {
      const feature = standardWalletFeature(wallet, 'standard:connect');
      if (!feature || typeof feature.connect !== 'function') {
        throw new Error('Solflare does not expose a Wallet Standard connect method.');
      }
      const result = await feature.connect();
      const account = (result?.accounts || wallet.accounts || [])[0];
      return { publicKey: account?.address || account?.publicKey };
    },
    async disconnect() {
      const feature = standardWalletFeature(wallet, 'standard:disconnect');
      if (feature && typeof feature.disconnect === 'function') {
        await feature.disconnect();
      }
    },
  };

  return walletStandardSolflareProvider;
}

function syncConnectedSolflareProvider(provider, { publicKey = null, logChange = false } = {}) {
  const nextPublicKey = publicKey
    || provider?.publicKey
    || provider?.wallet?.accounts?.[0]?.address
    || provider?.wallet?.accounts?.[0]?.publicKey;
  if (nextPublicKey) {
    setConnectedSolflareWallet(provider, nextPublicKey);
    if (logChange) {
      log(`Solflare account changed: ${shortSolflareAddress(solflareWallet.publicKey)}`, 'info');
    }
  } else {
    clearSolflareWallet();
  }
}

function getWalletStandardSolflareProvider() {
  const wallet = walletStandardWallets.find(isSolflareStandardWallet);
  return wallet ? createStandardSolflareProvider(wallet) : null;
}

function registerWalletStandardWallets(...wallets) {
  for (const wallet of wallets) {
    if (wallet && !walletStandardWallets.includes(wallet)) {
      walletStandardWallets.push(wallet);
    }
  }
}

function startWalletStandardDiscovery() {
  if (walletStandardListenersStarted || typeof window === 'undefined') return;
  walletStandardListenersStarted = true;

  const api = Object.freeze({ register: (...wallets) => registerWalletStandardWallets(...wallets) });
  window.addEventListener('wallet-standard:register-wallet', (event) => {
    if (typeof event.detail === 'function') {
      event.detail(api);
    }
  });

  try {
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  } catch (e) {
    console.warn(`Wallet Standard discovery failed: ${e.message}`);
  }
}

function getSolflareProvider() {
  startWalletStandardDiscovery();
  return collectSolflareProviderCandidates().find(isSolflareProvider)
    || getWalletStandardSolflareProvider()
    || null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSolflareProvider(timeoutMs = SOLFLARE_PROVIDER_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let provider = getSolflareProvider();
  while (!provider && Date.now() < deadline) {
    await wait(100);
    provider = getSolflareProvider();
  }
  return provider;
}

function publicKeyToString(publicKey) {
  if (!publicKey) return '';
  if (typeof publicKey === 'string') return publicKey;
  if (typeof publicKey.toBase58 === 'function') return publicKey.toBase58();
  if (typeof publicKey.toString === 'function') return publicKey.toString();
  return '';
}

function shortSolflareAddress(address) {
  return address ? `${address.slice(0, 6)}...${address.slice(-6)}` : '';
}

function setSolflareStatus(message, type = 'light') {
  const status = document.getElementById('solflareStatus');
  if (!status) return;
  status.className = `tag is-${type}`;
  status.textContent = message;
}

function syncSolflareButtons() {
  const connected = Boolean(solflareWallet?.publicKey);
  const staticSpa = window.TREBUCHET_STATIC_SPA === true;
  document.getElementById('connectSolflareBtn')?.classList.toggle('hidden', connected);
  document.getElementById('disconnectSolflareBtn')?.classList.toggle('hidden', !connected);
  document.getElementById('useSolflareDestinationBtn')?.classList.toggle('hidden', !connected);
  document.getElementById('useSolflareLaunchBtn')?.classList.toggle('hidden', !(connected && staticSpa));
}

function setConnectedSolflareWallet(provider, publicKey) {
  const address = publicKeyToString(publicKey);
  if (!address) throw new Error('Solflare did not return a public key.');

  solflareWalletProvider = provider;
  solflareWallet = {
    publicKey: address,
    connectedAt: new Date().toISOString(),
  };
  window.connectedSolflareWallet = solflareWallet;
  setSolflareStatus(shortSolflareAddress(address), 'success');
  syncSolflareButtons();
  return solflareWallet;
}

function clearSolflareWallet(message = 'Not connected') {
  const wasLaunchSigner = tempWallet?.signerMode === SIGNER_MODE_BROWSER_WALLET
    && tempWallet?.signerProvider === 'solflare';
  solflareWallet = null;
  solflareWalletProvider = null;
  window.connectedSolflareWallet = null;
  if (wasLaunchSigner) {
    tempWallet = null;
    setStepSummary(1, '');
    updateCancelButtonState();
  }
  setSolflareStatus(message, 'light');
  syncSolflareButtons();
}

function fillDestinationFromSolflare({ silent = false } = {}) {
  const destination = document.getElementById('destinationWallet');
  if (!destination || !solflareWallet?.publicKey) return false;

  destination.value = solflareWallet.publicKey;
  destination.dispatchEvent(new Event('input', { bubbles: true }));
  if (!silent) {
    log(`Destination wallet set to Solflare: ${shortSolflareAddress(solflareWallet.publicKey)}`, 'success');
  }
  return true;
}

function useSolflareAsLaunchWallet() {
  if (!window.TREBUCHET_STATIC_SPA) {
    log('Browser-wallet launch mode is only enabled in the static SPA build for now.', 'warning');
    return false;
  }
  if (!solflareWallet?.publicKey || !getSolflareSigner()) {
    log('Connect Solflare before using it for launch signing.', 'warning');
    return false;
  }

  if (balancePollHandle) {
    clearInterval(balancePollHandle);
    balancePollHandle = null;
  }

  tempWallet = {
    publicKey: solflareWallet.publicKey,
    signerMode: SIGNER_MODE_BROWSER_WALLET,
    signerProvider: 'solflare',
  };
  fundingWallet = solflareWallet.publicKey;
  fundingDetectionExhausted = true;
  lastSolBalance = 0;
  createdTokenInfo = null;
  lpResult = null;
  lastAirdropResult = null;
  fundingRequirement = { solLamports: 0, byQuote: {}, autoSwapPlan: [] };

  document.getElementById('walletInfo')?.classList.remove('hidden');
  document.querySelector('#walletInfo .qr-code')?.classList.add('hidden');
  const walletAddress = document.getElementById('walletAddress');
  if (walletAddress) walletAddress.value = solflareWallet.publicKey;
  document.getElementById('showPrivateKeyBtn')?.classList.add('hidden');
  document.getElementById('privateKeyContainer')?.classList.add('hidden');
  document.getElementById('tokenCreatedInfo')?.classList.add('hidden');
  document.getElementById('createTokenBtn')?.classList.remove('hidden');
  document.getElementById('createLpBtn')?.classList.remove('hidden');
  document.getElementById('transferAssetsBtn')?.classList.remove('hidden');
  setLpDoneVisible(false);
  document.getElementById('lpFailInfo')?.classList.add('hidden');
  document.getElementById('lpProgress')?.classList.add('hidden');
  const progressTree = document.getElementById('lpProgressTree');
  if (progressTree) progressTree.innerHTML = '';
  document.getElementById('transferResult')?.classList.add('hidden');
  document.getElementById('fundingWalletInfo')?.classList.add('hidden');
  const destination = document.getElementById('destinationWallet');
  if (destination) destination.value = solflareWallet.publicKey;

  for (let i = 2; i <= 6; i++) setStepSummary(i, '');
  document.body.classList.add('has-log');

  if (pools.length === 0) {
    rebuildPoolsFromSimple();
  }
  applySimpleConfigMode();

  setStepSummary(1, `${solflareWallet.publicKey.slice(0, 8)}…${solflareWallet.publicKey.slice(-6)}`);
  activateStep(2);
  updateContinueToFundingState();
  updateCancelButtonState();
  log(`Solflare selected for launch signing: ${shortSolflareAddress(solflareWallet.publicKey)}`, 'success');
  return true;
}

async function connectSolflareWallet() {
  setSolflareStatus('Looking...', 'light');
  const provider = await waitForSolflareProvider();
  if (!provider) {
    setSolflareStatus('Solflare not found', 'warning');
    log('Solflare was not detected. Unlock the extension, allow this site, then try again.', 'warning');
    return;
  }

  const btn = document.getElementById('connectSolflareBtn');
  await withRunState(async () => {
    setLoading(btn, true);
    try {
      wireSolflareProviderEvents(provider);
      const result = await provider.connect();
      const wallet = setConnectedSolflareWallet(provider, provider.publicKey || result?.publicKey);
      log(`Solflare connected: ${shortSolflareAddress(wallet.publicKey)}`, 'success');
    } catch (e) {
      const message = e?.message || 'Connection rejected';
      setSolflareStatus('Connection failed', 'danger');
      log(`Solflare connection failed: ${message}`, 'warning');
    } finally {
      setLoading(btn, false);
    }
  });
}

async function disconnectSolflareWallet() {
  const provider = solflareWalletProvider || getSolflareProvider();
  const btn = document.getElementById('disconnectSolflareBtn');
  await withRunState(async () => {
    setLoading(btn, true);
    try {
      if (provider && typeof provider.disconnect === 'function') {
        await provider.disconnect();
      }
      clearSolflareWallet();
      log('Solflare disconnected.');
    } catch (e) {
      log(`Solflare disconnect failed: ${e.message}`, 'warning');
    } finally {
      setLoading(btn, false);
    }
  });
}

function getSolflareSigner() {
  if (!solflareWallet?.publicKey || !solflareWalletProvider) return null;
  const standardWallet = solflareWalletProvider.wallet;
  if (standardWallet) {
    const account = standardWallet.accounts?.[0] || null;
    const signTransaction = standardWalletFeature(standardWallet, 'solana:signTransaction');
    const signAndSendTransaction = standardWalletFeature(standardWallet, 'solana:signAndSendTransaction');
    const signMessage = standardWalletFeature(standardWallet, 'solana:signMessage');
    return {
      publicKey: account?.publicKey || account?.address || solflareWallet.publicKey,
      address: solflareWallet.publicKey,
      signTransaction: signTransaction && typeof signTransaction.signTransaction === 'function'
        ? signTransaction.signTransaction.bind(signTransaction)
        : null,
      signAllTransactions: null,
      signAndSendTransaction: signAndSendTransaction
        && typeof signAndSendTransaction.signAndSendTransaction === 'function'
        ? signAndSendTransaction.signAndSendTransaction.bind(signAndSendTransaction)
        : null,
      signMessage: signMessage && typeof signMessage.signMessage === 'function'
        ? signMessage.signMessage.bind(signMessage)
        : null,
    };
  }

  return {
    publicKey: solflareWalletProvider.publicKey,
    address: solflareWallet.publicKey,
    signTransaction: typeof solflareWalletProvider.signTransaction === 'function'
      ? solflareWalletProvider.signTransaction.bind(solflareWalletProvider)
      : null,
    signAllTransactions: typeof solflareWalletProvider.signAllTransactions === 'function'
      ? solflareWalletProvider.signAllTransactions.bind(solflareWalletProvider)
      : null,
    signAndSendTransaction: typeof solflareWalletProvider.signAndSendTransaction === 'function'
      ? solflareWalletProvider.signAndSendTransaction.bind(solflareWalletProvider)
      : null,
    signMessage: typeof solflareWalletProvider.signMessage === 'function'
      ? solflareWalletProvider.signMessage.bind(solflareWalletProvider)
      : null,
  };
}

function wireSolflareProviderEvents(provider = getSolflareProvider()) {
  if (!provider || provider._trebuchetSolflareWired) return;

  provider._trebuchetSolflareWired = true;
  if (provider.wallet) {
    const events = standardWalletFeature(provider.wallet, 'standard:events');
    if (events && typeof events.on === 'function') {
      const unsubscribe = events.on('change', () => {
        syncConnectedSolflareProvider(provider, { logChange: true });
      });
      if (typeof unsubscribe === 'function') {
        provider._trebuchetSolflareUnsubscribe = unsubscribe;
      }
    }
    return;
  }

  if (typeof provider.on !== 'function') return;

  provider.on('connect', (publicKey) => {
    try {
      syncConnectedSolflareProvider(provider, { publicKey: provider.publicKey || publicKey });
    } catch {
      clearSolflareWallet();
    }
  });
  provider.on('disconnect', () => clearSolflareWallet());
  provider.on('accountChanged', (publicKey) => {
    if (publicKey) {
      setConnectedSolflareWallet(provider, publicKey);
      log(`Solflare account changed: ${shortSolflareAddress(solflareWallet.publicKey)}`, 'info');
    } else {
      clearSolflareWallet();
    }
  });
}

bind('connectSolflareBtn', 'click', connectSolflareWallet);
bind('disconnectSolflareBtn', 'click', disconnectSolflareWallet);
bind('useSolflareDestinationBtn', 'click', () => {
  if (!fillDestinationFromSolflare()) {
    log('Connect Solflare before using it as the destination wallet.', 'warning');
  }
});
bind('useSolflareLaunchBtn', 'click', useSolflareAsLaunchWallet);

window.getConnectedSolflareWallet = () => solflareWallet;
window.getSolflareSigner = getSolflareSigner;
window.applySolflareDestinationWallet = fillDestinationFromSolflare;
window.useSolflareAsLaunchWallet = useSolflareAsLaunchWallet;

window.addEventListener?.('solana#initialized', () => {
  wireSolflareProviderEvents();
});
wireSolflareProviderEvents();
const initialSolflareProvider = getSolflareProvider();
if (initialSolflareProvider?.isConnected && initialSolflareProvider.publicKey) {
  setConnectedSolflareWallet(initialSolflareProvider, initialSolflareProvider.publicKey);
} else {
  clearSolflareWallet();
}
