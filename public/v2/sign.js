// Proves control of a return wallet by signing a Trebuchet challenge in the
// browser, where the wallet extension lives. The local server verifies the
// signature; the desktop app then offers the verified wallet.
(() => {
  const walletsEl = document.getElementById('wallets');
  const statusEl = document.getElementById('status');

  function setStatus(text, kind = '') {
    statusEl.textContent = text;
    statusEl.className = kind;
  }

  function detectWallets() {
    const found = [];
    const add = (name, provider) => {
      if (provider && typeof provider.connect === 'function' && typeof provider.signMessage === 'function'
          && !found.some((item) => item.provider === provider)) {
        found.push({ name, provider });
      }
    };
    add('Phantom', window.phantom?.solana);
    add('Solflare', window.solflare);
    add('Backpack', window.backpack?.solana || window.backpack);
    add('Browser wallet', window.solana);
    return found;
  }

  async function api(path, body, token) {
    const response = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { 'x-trebuchet-session': token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  function toBase64(bytes) {
    let binary = '';
    new Uint8Array(bytes).forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  }

  async function verifyWith({ name, provider }) {
    walletsEl.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    try {
      setStatus(`Connecting ${name}…`);
      const connected = await provider.connect();
      const address = String(provider.publicKey || connected?.publicKey || '');
      if (!address) throw new Error(`${name} did not return a wallet address.`);

      const { token } = await api('/api/session');
      const challenge = await api('/api/v2/destinations/challenge', { address }, token);
      setStatus(`Sign the message in ${name}…`);
      const signed = await provider.signMessage(new TextEncoder().encode(challenge.message), 'utf8');
      const signature = toBase64(signed?.signature || signed);
      await api('/api/v2/destinations/verify', { nonce: challenge.nonce, signature }, token);
      setStatus(`Verified ${address}. You can close this tab and return to Trebuchet.`, 'ok');
    } catch (error) {
      setStatus(error?.message || 'Signing failed.', 'error');
      walletsEl.querySelectorAll('button').forEach((button) => { button.disabled = false; });
    }
  }

  function render() {
    const wallets = detectWallets();
    walletsEl.replaceChildren(...wallets.map((wallet) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `Sign with ${wallet.name}`;
      button.addEventListener('click', () => verifyWith(wallet));
      return button;
    }));
    if (!wallets.length) setStatus('No Solana wallet found in this browser. Install or unlock one, then reload.', 'error');
    else setStatus('');
  }

  // Extensions can inject after load.
  render();
  window.addEventListener('load', () => setTimeout(render, 300));
})();
