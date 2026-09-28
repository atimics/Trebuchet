function solflarePublicKeyText(publicKey) {
  if (!publicKey) return '';
  if (typeof publicKey === 'string') return publicKey;
  if (typeof publicKey.toBase58 === 'function') return publicKey.toBase58();
  if (typeof publicKey.toString === 'function') return publicKey.toString();
  return '';
}

function collectSolflareProviderCandidates() {
  const candidates = [];
  const add = (provider) => {
    if (!provider || candidates.includes(provider)) return;
    candidates.push(provider);
  };

  add(window.solflare);
  add(window.solana);

  const providers = window.solana?.providers;
  if (Array.isArray(providers)) {
    providers.forEach(add);
  } else if (providers && typeof providers === 'object') {
    Object.values(providers).forEach(add);
  }

  return candidates;
}

function isSolflareProvider(provider) {
  if (!provider || typeof provider.connect !== 'function') return false;
  const name = String(provider.name || provider.walletName || '').toLowerCase();
  return provider === window.solflare || provider.isSolflare === true || name.includes('solflare');
}

function isSolflareStandardWallet(wallet) {
  const name = String(wallet?.name || '').toLowerCase();
  const chains = Array.isArray(wallet?.chains) ? wallet.chains : [];
  return name.includes('solflare') && chains.some((chain) => String(chain).startsWith('solana:'));
}

function solflareStandardFeature(wallet, name) {
  const feature = wallet?.features?.[name];
  return feature && typeof feature === 'object' ? feature : null;
}

function solflareStandardWalletAddress(wallet) {
  const account = wallet?.accounts?.[0];
  return solflarePublicKeyText(account?.address || account?.publicKey);
}

function createSolflareStandardProvider(wallet) {
  if (solflareStandardProvider?.wallet === wallet) return solflareStandardProvider;
  solflareStandardProvider = {
    isSolflare: true,
    name: wallet?.name || 'Solflare',
    wallet,
    get publicKey() {
      return solflareStandardWalletAddress(wallet);
    },
    get isConnected() {
      return Boolean(solflareStandardWalletAddress(wallet));
    },
    async connect() {
      const feature = solflareStandardFeature(wallet, 'standard:connect');
      if (!feature || typeof feature.connect !== 'function') {
        throw new Error('Solflare does not expose a Wallet Standard connect method.');
      }
      const result = await feature.connect();
      const account = (result?.accounts || wallet.accounts || [])[0];
      return { publicKey: account?.address || account?.publicKey };
    },
    async disconnect() {
      const feature = solflareStandardFeature(wallet, 'standard:disconnect');
      if (feature && typeof feature.disconnect === 'function') await feature.disconnect();
    },
  };
  return solflareStandardProvider;
}

function registerSolflareStandardWallets(...wallets) {
  wallets.forEach((wallet) => {
    if (wallet && !solflareWalletStandardWallets.includes(wallet)) {
      solflareWalletStandardWallets.push(wallet);
    }
  });
}

function startSolflareWalletStandardDiscovery() {
  if (solflareWalletStandardListenersStarted || typeof window === 'undefined') return;
  solflareWalletStandardListenersStarted = true;

  const api = Object.freeze({ register: (...wallets) => registerSolflareStandardWallets(...wallets) });
  window.addEventListener('wallet-standard:register-wallet', (event) => {
    if (typeof event.detail === 'function') event.detail(api);
  });

  try {
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  } catch {
    // Wallet Standard discovery is opportunistic; injected providers still work.
  }
}

function getSolflareProvider() {
  startSolflareWalletStandardDiscovery();
  return collectSolflareProviderCandidates().find(isSolflareProvider)
    || solflareWalletStandardWallets.filter(isSolflareStandardWallet).map(createSolflareStandardProvider).find(Boolean)
    || null;
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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

function setConnectedSolflareWallet(provider, publicKey) {
  const address = solflarePublicKeyText(publicKey || provider?.publicKey);
  if (!address) throw new Error('Solflare did not return a public key.');
  solflareWalletProvider = provider;
  state.solflare = {
    publicKey: address,
    status: shortAddress(address),
    connecting: false,
    disconnecting: false,
    error: null,
    connectedAt: new Date().toISOString(),
  };
  window.connectedSolflareWallet = { publicKey: address, connectedAt: state.solflare.connectedAt };
  return state.solflare;
}

function clearSolflareWallet(message = 'Not connected') {
  solflareWalletProvider = null;
  state.solflare = {
    publicKey: null,
    status: message,
    connecting: false,
    disconnecting: false,
    error: null,
    connectedAt: null,
  };
  window.connectedSolflareWallet = null;
}

function syncConnectedSolflareProvider(provider, { publicKey = null, quiet = false } = {}) {
  const nextPublicKey = publicKey
    || provider?.publicKey
    || provider?.wallet?.accounts?.[0]?.address
    || provider?.wallet?.accounts?.[0]?.publicKey;
  if (nextPublicKey) {
    const wallet = setConnectedSolflareWallet(provider, nextPublicKey);
    if (!quiet) notify(`Solflare connected: ${shortAddress(wallet.publicKey)}`);
  } else {
    clearSolflareWallet();
    if (!quiet) notify('Solflare disconnected');
  }
  renderAll();
}

function wireSolflareProviderEvents(provider = getSolflareProvider()) {
  if (!provider || provider._trebuchetV2SolflareWired) return;
  provider._trebuchetV2SolflareWired = true;

  if (provider.wallet) {
    const events = solflareStandardFeature(provider.wallet, 'standard:events');
    if (events && typeof events.on === 'function') {
      events.on('change', () => syncConnectedSolflareProvider(provider, { quiet: true }));
    }
    return;
  }

  if (typeof provider.on !== 'function') return;
  provider.on('connect', (publicKey) => syncConnectedSolflareProvider(provider, {
    publicKey: provider.publicKey || publicKey,
    quiet: true,
  }));
  provider.on('disconnect', () => {
    clearSolflareWallet();
    renderAll();
  });
  provider.on('accountChanged', (publicKey) => syncConnectedSolflareProvider(provider, {
    publicKey,
    quiet: true,
  }));
}

function initializeSolflareWallet() {
  const provider = getSolflareProvider();
  wireSolflareProviderEvents(provider);
  if (provider?.isConnected && provider.publicKey) {
    setConnectedSolflareWallet(provider, provider.publicKey);
  }
}
