// public/api.js
//
// API session layer for the Trebuchet frontend. Installs a fetch wrapper
// that attaches the x-trebuchet-session header to same-origin /api/*
// requests. Extracted from app.js so the fetch interception can be tested
// independently of the full UI.
//
// Must be loaded before app.js in index.html.

(function () {
  const originalFetch = window.fetch.bind(window);
  let apiSessionTokenPromise = null;

  function isLocalApiRequest(input) {
    const raw = typeof input === 'string' ? input : input?.url;
    if (!raw) return false;
    const url = new URL(raw, window.location.href);
    return (
      url.origin === window.location.origin &&
      url.pathname.startsWith('/api/') &&
      url.pathname !== '/api/session'
    );
  }

  async function getApiSessionToken() {
    if (!apiSessionTokenPromise) {
      apiSessionTokenPromise = originalFetch('/api/session', {
        credentials: 'same-origin',
      })
        .then((r) => {
          if (!r.ok) throw new Error('API session failed: HTTP ' + r.status);
          return r.json();
        })
        .then((data) => {
          if (!data?.token) throw new Error('API session response missing token');
          return data.token;
        });
    }
    return apiSessionTokenPromise;
  }

  window.fetch = async function (input, init) {
    init = init || {};
    if (!isLocalApiRequest(input)) return originalFetch(input, init);

    const headers = new Headers(
      init.headers || (input instanceof Request ? input.headers : undefined),
    );
    headers.set('x-trebuchet-session', await getApiSessionToken());
    return originalFetch(input, { ...init, headers: headers });
  };
})();
