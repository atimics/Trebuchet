// Static SPA API shim.
//
// Loaded by dist/spa/index.html instead of api.js. It lets the frontend boot
// without the Express server by handling configuration/read-only endpoints in
// the browser. Server-only launch endpoints deliberately return clear errors.

(function () {
  const realFetch = window.fetch.bind(window);
  const STORAGE_PREFIX = 'trebuchet.spa.';
  const API_TOKEN = 'spa-local';

  const DEFAULT_PREFS = {
    checkForUpdatesOnStartup: false,
    medievalCursor: true,
    coinPreview: true,
    coinPreviewParked: false,
    demoMode: false,
    playIntroVideo: false,
    playSoundEffects: true,
    playBackgroundMusic: false,
    publishLaunchReport: true,
  };

  const DEFAULT_RPC = {
    active: 'https://api.mainnet-beta.solana.com',
    saved: [
      { name: 'Public mainnet', url: 'https://api.mainnet-beta.solana.com' },
    ],
  };

  const FALLBACK_FEE_TIERS = [
    { index: 2, tradeFeeRate: 100, tickSpacing: 1 },
    { index: 1, tradeFeeRate: 500, tickSpacing: 10 },
    { index: 0, tradeFeeRate: 2500, tickSpacing: 60 },
    { index: 3, tradeFeeRate: 10000, tickSpacing: 120 },
  ];

  const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const KNOWN_QUOTES = {
    SOL: {
      address: 'So11111111111111111111111111111111111111112',
      programId: TOKEN_PROGRAM_ID,
      decimals: 9,
      symbol: 'SOL',
      name: 'Solana',
      imageUrl: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
      priceUsd: '200',
      priceSource: 'fallback',
    },
    USDC: {
      address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      programId: TOKEN_PROGRAM_ID,
      decimals: 6,
      symbol: 'USDC',
      name: 'USD Coin',
      imageUrl: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
      priceUsd: '1',
      priceSource: 'fallback',
    },
    USDT: {
      address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      programId: TOKEN_PROGRAM_ID,
      decimals: 6,
      symbol: 'USDT',
      name: 'USDT',
      imageUrl: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg',
      priceUsd: '1',
      priceSource: 'fallback',
    },
  };

  const unsupportedLaunchEndpoints = new Set([
    '/api/generate-wallet',
    '/api/create-token',
    '/api/acquire-quote-tokens',
    '/api/create-lp',
    '/api/resume-launch',
    '/api/transfer-assets',
    '/api/retry-airdrop',
    '/api/run-airdrop',
    '/api/publish-launch-report',
    '/api/preflight-create-lp',
    '/api/check-balance',
    '/api/check-balance-detailed',
    '/api/find-funder',
    '/api/demo/inject-funds',
    '/api/generate-vanity-wallet-stream',
    '/api/cancel-vanity-grind',
  ]);

  function readJson(key, fallback) {
    try {
      const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
      return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
    } catch {
      return { ...fallback };
    }
  }

  function writeJson(key, value) {
    window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    return value;
  }

  function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  async function requestBody(init) {
    if (!init?.body) return {};
    if (typeof init.body === 'string') {
      try { return JSON.parse(init.body); } catch { return {}; }
    }
    if (init.body instanceof FormData) {
      return Object.fromEntries(init.body.entries());
    }
    return {};
  }

  function isApiRequest(input) {
    const raw = typeof input === 'string' ? input : input?.url;
    if (!raw) return null;
    const url = new URL(raw, window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) {
      return null;
    }
    return url;
  }

  function unsupported(pathname) {
    return json({
      success: false,
      error: `${pathname} is not available in the static browser build yet. Connect a browser wallet and use the forthcoming client-side signing flow.`,
      code: 'STATIC_SPA_UNSUPPORTED',
    }, 501);
  }

  async function handleApi(url, init) {
    const pathname = url.pathname;

    if (pathname === '/api/session') {
      return json({ success: true, token: API_TOKEN });
    }
    if (pathname === '/api/user-prefs') {
      if ((init?.method || 'GET').toUpperCase() === 'POST') {
        const patch = await requestBody(init);
        const current = readJson('prefs', DEFAULT_PREFS);
        const next = { ...current };
        for (const [key, value] of Object.entries(patch)) {
          if (Object.prototype.hasOwnProperty.call(DEFAULT_PREFS, key)
              && typeof value === typeof DEFAULT_PREFS[key]) {
            next[key] = value;
          }
        }
        return json({ success: true, prefs: writeJson('prefs', next) });
      }
      return json({ success: true, prefs: readJson('prefs', DEFAULT_PREFS) });
    }
    if (pathname === '/api/demo/status') {
      return json({ success: true, active: false, staticSpa: true });
    }
    if (pathname === '/api/rpc-config') {
      return json({ success: true, config: readJson('rpc', DEFAULT_RPC) });
    }
    if (pathname === '/api/rpc-health') {
      return json({ success: true, health: 'unknown', latencyMs: null, staticSpa: true });
    }
    if (pathname === '/api/rpc-config/add') {
      const body = await requestBody(init);
      const config = readJson('rpc', DEFAULT_RPC);
      if (!body.name || !body.url) {
        return json({ success: false, error: 'Name and URL are required' }, 400);
      }
      try { new URL(body.url); } catch {
        return json({ success: false, error: 'URL is not a valid URL' }, 400);
      }
      const existing = config.saved.find((entry) => entry.url === body.url);
      if (existing) existing.name = body.name;
      else config.saved.push({ name: body.name, url: body.url });
      if (body.setActive) config.active = body.url;
      return json({ success: true, config: writeJson('rpc', config) });
    }
    if (pathname === '/api/rpc-config/select') {
      const body = await requestBody(init);
      const config = readJson('rpc', DEFAULT_RPC);
      if (!config.saved.some((entry) => entry.url === body.url)) {
        return json({ success: false, error: 'RPC URL is not in the saved list. Add it first.' }, 400);
      }
      config.active = body.url;
      return json({ success: true, config: writeJson('rpc', config) });
    }
    if (pathname === '/api/rpc-config/remove') {
      const body = await requestBody(init);
      const config = readJson('rpc', DEFAULT_RPC);
      if (config.saved.length <= 1) {
        return json({ success: false, error: 'Cannot remove the last saved RPC' }, 400);
      }
      config.saved = config.saved.filter((entry) => entry.url !== body.url);
      if (!config.saved.some((entry) => entry.url === config.active)) {
        config.active = config.saved[0].url;
      }
      return json({ success: true, config: writeJson('rpc', config) });
    }
    if (pathname === '/api/rpc-config/test') {
      return json({ success: true, result: { ok: false, error: 'RPC testing is not implemented in the static SPA shim yet.' } });
    }
    if (pathname === '/api/clmm-fee-tiers') {
      return json({ success: true, tiers: FALLBACK_FEE_TIERS, staticSpa: true });
    }
    if (pathname === '/api/quote-token-info') {
      const body = await requestBody(init);
      const key = String(body.quoteToken || '').trim().toUpperCase();
      const known = KNOWN_QUOTES[key];
      if (!known) {
        return json({
          success: false,
          error: 'Static SPA can currently resolve only SOL, USDC, and USDT quote tokens.',
          code: 'STATIC_SPA_UNKNOWN_QUOTE',
        }, 501);
      }
      return json({
        success: true,
        info: {
          ...known,
          compatible: true,
          isToken2022: false,
          extensions: [],
          disallowedNames: [],
          freezeAuthorityDisabled: true,
          mintAuthorityRenounced: true,
          freezeAuthorityBlock: false,
          mintAuthorityWarning: false,
          raydiumTradeable: 'yes',
        },
      });
    }
    if (pathname === '/api/proxy-image') {
      const imageUrl = url.searchParams.get('url');
      return imageUrl ? realFetch(imageUrl) : json({ success: false, error: 'url required' }, 400);
    }
    if (pathname === '/api/server-logs') {
      return json({ success: true, logs: [] });
    }
    if (pathname === '/api/pending-wallets') {
      return json({ success: true, wallets: [] });
    }
    if (pathname === '/api/launch-journals') {
      return json({ success: true, journals: [] });
    }
    if (unsupportedLaunchEndpoints.has(pathname)) {
      return unsupported(pathname);
    }

    return json({ success: false, error: `No static SPA API handler for ${pathname}` }, 404);
  }

  window.TREBUCHET_STATIC_SPA = true;
  window.fetch = async function (input, init = {}) {
    const url = isApiRequest(input);
    if (!url) return realFetch(input, init);
    return handleApi(url, init);
  };
  window.getApiSessionToken = async () => API_TOKEN;
})();
