// Lean launch view for Trebuchet v2: a cheaper launch on Meteora DAMM v2.
//
// One pool holds the whole supply, locked for good. No SOL goes in; buyers supply
// it. The local API (dammV2Routes.js) owns every rule; this file renders its state
// and sends the operator's choices. Nothing here holds or sees a key.
(function installTrebuchetLean(global) {
  const RANGES = [
    { value: 100, label: 'x100 (tight: deeper near the start)' },
    { value: 1000, label: 'x1,000 (recommended)' },
    { value: 10000, label: 'x10,000 (wide: thinner, runs further)' },
  ];
  const FEES = [25, 50, 100, 200];
  const LOGO_MAX_BYTES = 100 * 1024;
  const DEFAULTS = {
    name: '', symbol: '', supply: '1000000000', description: '', startingMarketCapUsd: 250000,
    rangeMultiple: 1000, feeBps: 25, walletPublicKey: '', vanityPublicKey: '', destination: '', logoDataUrl: null, logoName: '',
  };
  const STEPS = [
    { id: 'token', label: 'Create the token', detail: 'Token-2022, authorities renounced, metadata fixed' },
    { id: 'pool', label: 'Create the locked pool', detail: 'Whole supply, one position, locked for good' },
    { id: 'keyTransfer', label: 'Send the Fee Key', detail: 'To the destination wallet, if you set one' },
  ];

  const ui = {
    client: null,
    launches: [],
    selectedId: null,
    detail: null,
    form: { ...DEFAULTS },
    dirty: false,
    wallets: [],
    vanity: [],
    pin: null,
    balance: null,
    estimate: null,
    lead: null,
    estimateError: null,
    approved: false,
    fees: null,
    busy: null,
    error: null,
    notice: null,
    pollTimer: null,
    estimateTimer: null,
    loaded: false,
  };

  // ---------------------------------------------------------------- helpers

  const root = () => document.getElementById('leanRoot');

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function api() {
    if (!ui.client) ui.client = global.TrebuchetV2Api.createV2ApiClient();
    return ui.client;
  }

  const request = (path, init) => api().request(path, init);
  const sol = (value, digits = 4) => (Number.isFinite(value) ? `${value.toFixed(digits)} SOL` : '-');
  const usd = (value) => (Number.isFinite(value) ? `$${Math.round(value).toLocaleString('en-US')}` : '-');
  const num = (value, digits = 0) => (Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: digits }) : '-');
  const short = (address) => (address ? `${address.slice(0, 4)}...${address.slice(-4)}` : '-');

  function addr(address) {
    if (!address) return '<span class="nft-muted">-</span>';
    return `<span class="nft-addr" title="${esc(address)}">${esc(short(address))}</span>`;
  }

  function link(kind, address) {
    return `<a class="nft-link" href="https://solscan.io/${kind}/${esc(address)}" target="_blank" rel="noopener noreferrer">${esc(short(address))}</a>`;
  }

  function tag(kind, text) {
    const shapes = { draft: '○', model: '◇', run: '◐', ok: '●', warn: '▲', bad: '✕' };
    return `<span class="nft-tag nft-tag-${kind}">${shapes[kind] || ''} ${esc(text)}</span>`;
  }

  async function guard(label, fn) {
    ui.busy = label;
    ui.error = null;
    ui.notice = null;
    render();
    try {
      await fn();
    } catch (error) {
      ui.error = error?.message || String(error);
    } finally {
      ui.busy = null;
      render();
    }
  }

  // ---------------------------------------------------------------- form <-> config

  function configFromForm(form = ui.form) {
    return {
      token: { name: form.name, symbol: form.symbol, supply: String(form.supply).replace(/,/g, ''), description: form.description },
      startingMarketCapUsd: Number(String(form.startingMarketCapUsd).replace(/,/g, '')),
      rangeMultiple: Number(form.rangeMultiple),
      feeBps: Number(form.feeBps),
      destination: form.destination.trim(),
      vanity: { selectedPublicKey: form.vanityPublicKey || null },
    };
  }

  function formFromDetail(detail) {
    const c = detail.config;
    return {
      name: c.token.name,
      symbol: c.token.symbol,
      supply: c.token.supply,
      description: c.token.description,
      startingMarketCapUsd: c.pool.startingMarketCapUsd,
      rangeMultiple: c.pool.rangeMultiple,
      feeBps: c.pool.feeBps,
      walletPublicKey: detail.walletPublicKey || '',
      vanityPublicKey: c.vanity?.selectedPublicKey || '',
      destination: c.destination || '',
      logoDataUrl: null,
      logoName: detail.hasLogo ? 'saved logo' : '',
    };
  }

  const usableWallets = () => ui.wallets.filter((w) => w.hasSecretKey === true && w.decryptionFailed !== true);
  const readableVanity = () => ui.vanity.filter((c) => !c.decryptionFailed);
  const locked = () => ui.detail && ui.detail.status !== 'draft';
  const formReady = () => Boolean(ui.form.name.trim() && ui.form.symbol.trim());
  const canRun = () => formReady() && Boolean(ui.form.walletPublicKey);

  // ---------------------------------------------------------------- data

  async function loadList() {
    const data = await request('/api/v2/damm/launches');
    ui.launches = data.launches || [];
    if (ui.selectedId && !ui.launches.some((l) => l.id === ui.selectedId)) ui.selectedId = null;
    // Open on the launch that needs you: one that is running, then one that failed, then the latest
    // finished one. A draft never opens by itself; the form starts blank.
    if (!ui.selectedId && !ui.dirty) {
      const pick = ui.launches.find((l) => l.status === 'running')
        || ui.launches.find((l) => l.status === 'failed')
        || ui.launches.find((l) => l.status === 'completed');
      if (pick) ui.selectedId = pick.id;
    }
  }

  async function loadDetail() {
    if (!ui.selectedId) {
      ui.detail = null;
      return;
    }
    const data = await request(`/api/v2/damm/launches/${encodeURIComponent(ui.selectedId)}`);
    ui.detail = data.launch;
    if (!ui.dirty) ui.form = formFromDetail(ui.detail);
    ui.estimate = ui.detail.estimate;
    schedulePoll();
  }

  async function loadWallets() {
    try {
      const data = await request('/api/v2/wallets');
      ui.wallets = data.wallets || [];
      const usable = usableWallets();
      if (!ui.form.walletPublicKey || !usable.some((w) => w.publicKey === ui.form.walletPublicKey)) {
        if (!ui.detail?.walletPublicKey) ui.form.walletPublicKey = usable[0]?.publicKey || '';
      }
    } catch {
      ui.wallets = [];
    }
  }

  async function loadVanity() {
    try {
      ui.vanity = (await request('/api/vanity-ca-candidates')).candidates || [];
    } catch {
      ui.vanity = [];
    }
  }

  async function loadPin() {
    try {
      ui.pin = (await request('/api/secret-pin/status')).status || null;
    } catch {
      ui.pin = null;
    }
  }

  async function loadBalance() {
    ui.balance = null;
    if (!ui.form.walletPublicKey) return;
    try {
      const data = await request('/api/check-balance', { method: 'POST', body: { publicKey: ui.form.walletPublicKey } });
      ui.balance = Number(data.balance);
    } catch {
      ui.balance = null;
    }
  }

  async function loadEstimate() {
    ui.estimateError = null;
    if (!ui.form.name.trim() || !ui.form.symbol.trim()) {
      ui.estimate = null;
      return;
    }
    try {
      const data = await request('/api/v2/damm/estimate', { method: 'POST', body: { config: configFromForm() } });
      ui.estimate = data.estimate;
    } catch (error) {
      ui.estimate = null;
      ui.estimateError = error?.message || String(error);
    }
  }

  function scheduleEstimate() {
    clearTimeout(ui.estimateTimer);
    ui.estimateTimer = setTimeout(async () => {
      await loadEstimate();
      render();
    }, 400);
  }

  // A placeholder token, only so the header can say what the venue saves.
  async function loadLead() {
    try {
      const data = await request('/api/v2/damm/estimate', { method: 'POST', body: { config: { token: { name: 'Token', symbol: 'TOK' } } } });
      ui.lead = data.estimate;
    } catch {
      ui.lead = null;
    }
  }

  async function loadFees() {
    ui.fees = null;
    if (ui.detail?.status !== 'completed' || !ui.detail.steps?.pool?.complete) return;
    try {
      ui.fees = await request(`/api/v2/damm/launches/${encodeURIComponent(ui.selectedId)}/fees`);
    } catch {
      ui.fees = null;
    }
  }

  function schedulePoll() {
    clearTimeout(ui.pollTimer);
    if (!(ui.detail?.status === 'running' || ui.detail?.job?.running)) return;
    ui.pollTimer = setTimeout(async () => {
      try {
        const data = await request(`/api/v2/damm/launches/${encodeURIComponent(ui.selectedId)}/job`);
        if (ui.detail) {
          ui.detail.status = data.status;
          ui.detail.steps = data.steps;
          ui.detail.error = data.error;
          ui.detail.events = data.events;
          ui.detail.job = data.job;
        }
        if (data.job?.running) {
          schedulePoll();
        } else {
          await loadList();
          await loadDetail();
          await loadFees();
        }
      } catch {
        schedulePoll();
      }
      render();
    }, 1500);
  }

  async function refreshAll() {
    // Independent reads run together; the balance needs the selected wallet.
    await Promise.all([loadList().then(loadDetail), loadWallets(), loadVanity(), loadPin(), loadLead()]);
    await Promise.all([loadBalance(), !ui.detail && formReady() ? loadEstimate() : null, loadFees()]);
  }

  // ---------------------------------------------------------------- logo

  function readDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.readAsDataURL(file);
    });
  }

  function dataUrlBytes(dataUrl) {
    return Math.floor(((dataUrl.split(',')[1] || '').length * 3) / 4);
  }

  // Shrink a still image under the upload cap. An animated GIF is not re-encoded
  // here (that would flatten it), so it has to be small already.
  async function logoFromFile(file) {
    const original = await readDataUrl(file);
    if (dataUrlBytes(original) <= LOGO_MAX_BYTES) return original;
    if (file.type === 'image/gif') throw new Error('An animated GIF has to be under 100 KB. Make it smaller and pick it again.');
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('That image could not be read.'));
      img.src = original;
    });
    for (const side of [512, 384, 256, 192]) {
      const scale = Math.min(1, side / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.9, 0.8, 0.7, 0.55]) {
        const out = canvas.toDataURL('image/jpeg', quality);
        if (dataUrlBytes(out) <= LOGO_MAX_BYTES) return out;
      }
    }
    throw new Error('That logo could not be shrunk under 100 KB.');
  }

  // ---------------------------------------------------------------- render

  function render() {
    const el = root();
    if (!el) return;
    const focus = captureFocus(el);
    el.innerHTML = ui.loaded ? `
      <div class="nft-shell lean-shell">
        ${renderHeader()}
        ${ui.error ? `<div class="nft-banner nft-banner-bad"><span>${esc(ui.error)}</span><button class="nft-link" type="button" data-lean-action="dismiss">Dismiss</button></div>` : ''}
        ${ui.notice ? `<div class="nft-banner nft-banner-ok"><span>${esc(ui.notice)}</span><button class="nft-link" type="button" data-lean-action="dismiss">Dismiss</button></div>` : ''}
        ${ui.busy ? `<div class="nft-banner nft-banner-ok"><span>${esc(ui.busy)}...</span></div>` : ''}
        ${locked() ? renderRun() : renderDraft()}
      </div>` : '<div class="nft-empty">Loading...</div>';
    restoreFocus(el, focus);
  }

  function captureFocus(el) {
    const active = document.activeElement;
    if (!active || !el.contains(active) || !active.dataset.leanField) return null;
    return { field: active.dataset.leanField, start: active.selectionStart, end: active.selectionEnd };
  }

  function restoreFocus(el, focus) {
    if (!focus) return;
    const next = el.querySelector(`[data-lean-field="${focus.field}"]`);
    if (!next) return;
    next.focus({ preventScroll: true });
    try { if (focus.start != null) next.setSelectionRange(focus.start, focus.end); } catch { /* not a text field */ }
  }

  function renderHeader() {
    const cmp = (ui.estimate || ui.lead)?.comparison;
    return `
      <div class="nft-head">
        <div class="nft-head-title"><button class="nft-link" type="button" data-view="coins">&larr; All coins</button><strong>Lean launch on Meteora</strong>${ui.detail ? tag(statusKind(ui.detail.status), ui.detail.status) : tag('model', 'New')}</div>
        <div class="nft-head-actions">
          <select data-lean-action="select" aria-label="Lean launches">
            <option value="">New lean launch</option>
            ${ui.launches.map((l) => `<option value="${esc(l.id)}" ${l.id === ui.selectedId ? 'selected' : ''}>${esc(l.symbol)} - ${esc(l.name)} (${esc(l.status)})</option>`).join('')}
          </select>
        </div>
      </div>
      <p class="nft-muted lean-lead">${cmp ? `Venue <strong>${sol(cmp.dammVenueSol)}</strong> · Raydium ${sol(cmp.raydiumVenueSol)} · ${cmp.savedPct}% less` : ''}</p>`;
  }

  function statusKind(status) {
    return { draft: 'model', running: 'run', completed: 'ok', failed: 'bad' }[status] || 'draft';
  }

  // ---- draft

  const fieldInput = (label, name, value, attrs = '') => `
    <label class="lean-field"><span class="nft-label">${esc(label)}</span>
      <input data-lean-field="${name}" value="${esc(value)}" ${attrs} autocomplete="off"></label>`;

  function renderDraft() {
    const f = ui.form;
    return `
      <div class="lean-grid">
        <div class="nft-main">
          <section class="nft-panel">
            <div class="nft-panel-head"><h3>Token</h3></div>
            <div class="nft-panel-body lean-form">
              ${fieldInput('Name', 'name', f.name, 'maxlength="32"')}
              ${fieldInput('Symbol', 'symbol', f.symbol, 'maxlength="10"')}
              ${fieldInput('Total supply', 'supply', f.supply, 'inputmode="numeric"')}
              <label class="lean-field lean-wide"><span class="nft-label">Description</span>
                <textarea data-lean-field="description" rows="2" maxlength="1000">${esc(f.description)}</textarea></label>
              <div class="lean-field lean-wide">
                <span class="nft-label">Logo</span>
                <div class="nft-row-controls">
                  <input type="file" data-lean-file="logo" accept="image/png,image/jpeg,image/gif" aria-label="Token logo">
                  ${f.logoName ? `<span class="nft-muted nft-small">${esc(f.logoName)}</span><button class="nft-link" type="button" data-lean-action="clear-logo">Remove</button>` : '<span class="nft-muted nft-small">PNG · JPEG · GIF · 100 KB</span>'}
                </div>
              </div>
            </div>
          </section>

          <section class="nft-panel">
            <div class="nft-panel-head"><h3>Price</h3></div>
            <div class="nft-panel-body lean-form">
              ${fieldInput('Starting market cap (USD)', 'startingMarketCapUsd', num(Number(f.startingMarketCapUsd)), 'inputmode="numeric"')}
              <label class="lean-field"><span class="nft-label">Price range</span>
                <select data-lean-field="rangeMultiple">${RANGES.map((r) => `<option value="${r.value}" ${Number(f.rangeMultiple) === r.value ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></label>
              <label class="lean-field"><span class="nft-label">Trading fee</span>
                <select data-lean-field="feeBps">${FEES.map((bps) => `<option value="${bps}" ${Number(f.feeBps) === bps ? 'selected' : ''}>${(bps / 100).toFixed(2)}%</option>`).join('')}</select></label>
              <div class="lean-wide">${renderDepth()}</div>
            </div>
          </section>

          <section class="nft-panel">
            <div class="nft-panel-head"><h3>Wallet and addresses</h3></div>
            <div class="nft-panel-body lean-form">
              <label class="lean-field"><span class="nft-label">Launch wallet</span>${walletSelect()}</label>
              <label class="lean-field"><span class="nft-label">Contract address</span>
                <select data-lean-field="vanityPublicKey">
                  <option value="">Random address</option>
                  ${readableVanity().map((c) => `<option value="${esc(c.publicKey)}" ${c.publicKey === f.vanityPublicKey ? 'selected' : ''}>${esc(short(c.publicKey))}${c.suffix ? ` - ends ${esc(c.suffix)}` : c.prefix ? ` - starts ${esc(c.prefix)}` : ''}</option>`).join('')}
                </select></label>
              ${fieldInput('Fee Key destination (optional)', 'destination', f.destination, 'placeholder="Leave empty to keep it in the launch wallet"')}
            </div>
          </section>
        </div>
        <div class="nft-main">${renderReview()}</div>
      </div>`;
  }

  function walletSelect() {
    const usable = usableWallets();
    if (!usable.length) {
      const stuck = ui.wallets.length ? 'None of your wallets can sign right now (PIN locked, or the key is unreadable).' : 'No Trebuchet wallet yet.';
      return `<span class="nft-muted">${stuck} <button class="nft-link" type="button" data-view="wallet">Open Wallet</button></span>`;
    }
    return `<select data-lean-field="walletPublicKey" ${ui.detail?.walletPublicKey ? 'disabled' : ''}>
      ${usable.map((w) => `<option value="${esc(w.publicKey)}" ${w.publicKey === ui.form.walletPublicKey ? 'selected' : ''}>${esc(w.label || 'Wallet')} ${esc(short(w.publicKey))}</option>`).join('')}
    </select>`;
  }

  function renderDepth() {
    const e = ui.estimate;
    if (!e) return `<p class="nft-muted nft-small">${ui.estimateError ? esc(ui.estimateError) : ''}</p>`;
    const p = e.pricing;
    return `
      <div class="lean-depth">
        <table class="nft-table nft-kv">
          <thead><tr><th>Starts at</th><th>Ends at</th></tr></thead>
          <tbody><tr><td>${usd(Number(ui.form.startingMarketCapUsd))} market cap (${num(p.startMarketCapSol, 1)} SOL)</td><td>${usd(p.endMarketCapUsd)} market cap</td></tr></tbody>
        </table>
        <table class="nft-table">
          <thead><tr><th>To push the price to</th><th>Buying costs</th><th>Supply sold</th></tr></thead>
          <tbody>${p.depth.map((row) => `<tr><td>x${row.multiple} (${usd(row.marketCapUsd)})</td><td>${num(row.solToReach, 1)} SOL</td><td>${num(row.percentOfSupplySold, 1)}%</td></tr>`).join('')}</tbody>
        </table>
        <table class="nft-table">
          <thead><tr><th>A fresh buy of</th><th>Gets</th><th>Pays above the start</th></tr></thead>
          <tbody>${p.buys.map((b) => `<tr><td>${num(b.solIn)} SOL</td><td>${num(b.percentOfSupply, 2)}% of supply</td><td>${((b.averagePriceMultiple - 1) * 100).toFixed(1)}%</td></tr>`).join('')}</tbody>
        </table>
        <p class="nft-muted nft-small">SOL $${num(e.solUsd, 2)}${e.solUsdIsFallback ? ' (estimate)' : ''}</p>
      </div>`;
  }

  function renderReview() {
    const e = ui.estimate;
    const needed = e?.cost.total;
    const shortfall = Number.isFinite(ui.balance) && needed ? Math.max(0, needed - ui.balance) : null;
    const pinLocked = ui.pin?.configured && ui.pin?.locked;
    const saved = Boolean(ui.detail);
    return `
      <section class="nft-panel">
        <div class="nft-panel-head"><h3>Review</h3>${e ? tag('model', 'Estimate') : tag('draft', 'Not yet')}</div>
        <div class="nft-panel-body">
          ${e ? `
            <table class="nft-table nft-kv"><tbody>
              ${e.cost.lines.map((line) => `<tr><td>${esc(line.label)}${line.venue ? '' : ' <span class="nft-muted nft-small">(same on any venue)</span>'}</td><td>${sol(line.sol, 4)}</td></tr>`).join('')}
              <tr><td>Buffer 20%</td><td>${sol(e.cost.buffer, 4)}</td></tr>
              <tr class="nft-total"><td>Most this can spend</td><td>${sol(e.cost.total, 4)}</td></tr>
              <tr><td>SOL put into the pool</td><td>${sol(0)}</td></tr>
            </tbody></table>
            <ul class="lean-facts">${e.facts.map((fact) => `<li>${esc(fact)}</li>`).join('')}</ul>` : ''}
          ${pinLocked ? '<div class="nft-banner nft-banner-bad"><span>Your Recovery PIN is locked. Unlock it before launching.</span><button class="nft-link" type="button" data-action="unlock-secret-pin">Unlock PIN</button></div>' : ''}
          ${ui.form.walletPublicKey ? `<p class="nft-muted nft-small">Launch wallet ${addr(ui.form.walletPublicKey)} holds ${Number.isFinite(ui.balance) ? sol(ui.balance) : 'an unknown balance'}.
            <button class="nft-link" type="button" data-lean-action="balance">Refresh</button></p>` : ''}
          ${shortfall ? `<p class="nft-warn">Send at least <strong>${sol(shortfall)}</strong> to <code>${esc(ui.form.walletPublicKey)}</code> first.</p>` : ''}
          ${e ? `<label class="nft-inline"><input class="nft-check" type="checkbox" data-lean-field="approved" ${ui.approved ? 'checked' : ''}> I approve spending up to ${sol(e.cost.total)} from this wallet, with SOL at $${num(e.solUsd, 2)}. Nothing else is spent.</label>` : ''}
          <div class="nft-actions">
            <button class="secondary-button" type="button" data-lean-action="save" ${formReady() ? '' : 'disabled'}>${saved ? 'Save changes' : 'Save draft'}</button>
            <button class="primary-button" type="button" data-lean-action="run" ${saved && e && ui.approved && !ui.dirty && !pinLocked && canRun() && !shortfall ? '' : 'disabled'}>Launch</button>
          </div>
          ${saved && ui.dirty ? '<p class="nft-muted nft-small">Save your changes before launching.</p>' : ''}
          ${saved && !ui.form.walletPublicKey ? '<p class="nft-muted nft-small">Choose a launch wallet to launch.</p>' : ''}
          ${saved ? '<div class="nft-actions"><button class="nft-link" type="button" data-lean-action="remove">Delete this draft</button></div>' : ''}
        </div>
      </section>`;
  }

  // ---- run, result

  function stepState(id, d) {
    const step = d.steps?.[id];
    if (step?.complete) return 'ok';
    if (d.status === 'failed') {
      const done = STEPS.findIndex((s) => !d.steps?.[s.id]?.complete);
      return STEPS[done]?.id === id ? 'bad' : 'draft';
    }
    if (d.status === 'running') {
      const next = STEPS.findIndex((s) => !d.steps?.[s.id]?.complete && !(s.id === 'keyTransfer' && !d.config?.destination));
      return STEPS[next]?.id === id ? 'run' : 'draft';
    }
    return 'draft';
  }

  const MARKS = { ok: 'fa-check', run: 'fa-spinner fa-spin', bad: 'fa-triangle-exclamation', draft: 'fa-circle' };

  function renderRun() {
    const d = ui.detail;
    const pool = d.steps?.pool;
    const token = d.steps?.token;
    return `
      <div class="lean-grid">
        <div class="nft-main">
          <section class="nft-panel">
            <div class="nft-panel-head"><h3>${esc(d.config.token.name)} ${esc(d.config.token.symbol)}</h3>${tag(statusKind(d.status), d.status)}</div>
            <div class="nft-panel-body">
              <div class="nft-fact-list">
                ${STEPS.filter((s) => s.id !== 'keyTransfer' || d.config.destination).map((s) => {
                  const state = stepState(s.id, d);
                  return `<div class="nft-fact is-${state}"><i class="fa-solid ${MARKS[state]}" aria-hidden="true"></i><span><strong>${esc(s.label)}</strong><small>${esc(s.detail)}</small></span></div>`;
                }).join('')}
              </div>
              ${d.status === 'running' ? '<p class="nft-muted">Keep Trebuchet open until this finishes.</p>' : ''}
              ${d.status === 'failed' ? `
                <div class="nft-banner nft-banner-bad"><span>${esc(d.error || 'The launch stopped.')}</span></div>
                <p class="nft-muted nft-small">Finished steps are kept. Running it again will not create a second pool.</p>
                <div class="nft-actions"><button class="primary-button" type="button" data-lean-action="run">Run again</button></div>` : ''}
            </div>
          </section>
          ${renderEvents(d)}
        </div>
        <div class="nft-main">
          ${token?.complete ? renderResult(d, token, pool) : ''}
          ${d.status === 'completed' ? renderFees(d) : ''}
        </div>
      </div>`;
  }

  function renderEvents(d) {
    const events = (d.events || []).slice(-8).reverse();
    if (!events.length) return '';
    return `
      <section class="nft-panel">
        <div class="nft-panel-head"><h3>Activity</h3></div>
        <div class="nft-panel-body"><ul class="lean-facts">${events.map((e) => `<li><code>${esc(e.stage || '')}</code>${e.txId ? ` ${link('tx', e.txId)}` : ''}</li>`).join('')}</ul></div>
      </section>`;
  }

  function renderResult(d, token, pool) {
    return `
      <section class="nft-panel">
        <div class="nft-panel-head"><h3>On-chain</h3>${pool?.verification?.passed ? tag('ok', 'Verified') : tag('model', 'Waiting')}</div>
        <div class="nft-panel-body">
          <table class="nft-table nft-kv"><tbody>
            <tr><td>Token</td><td>${link('token', token.mint)}</td></tr>
            ${pool?.complete ? `
              <tr><td>Pool</td><td>${link('account', pool.pool)}</td></tr>
              <tr><td>Position</td><td>${link('account', pool.position)}</td></tr>
              <tr><td>Fee Key (position NFT)</td><td>${link('token', pool.positionNft)}</td></tr>
              <tr><td>Starting market cap</td><td>${num(pool.startMarketCapSol, 1)} SOL (at SOL $${num(pool.solUsd, 2)})</td></tr>
              <tr><td>Locked for good</td><td class="${pool.verification?.permanentlyLocked ? 'nft-ok' : 'nft-bad'}">${pool.verification?.permanentlyLocked ? 'Yes' : 'No'}</td></tr>
              <tr><td>Mint authority</td><td class="${token.mintAuthorityRenounced ? 'nft-ok' : 'nft-bad'}">${token.mintAuthorityRenounced ? 'Renounced' : 'Still set'}</td></tr>
              <tr><td>Freeze authority</td><td class="${token.freezeAuthorityDisabled ? 'nft-ok' : 'nft-bad'}">${token.freezeAuthorityDisabled ? 'Off' : 'On'}</td></tr>
              ${d.steps.keyTransfer?.complete ? `<tr><td>Fee Key sent to</td><td>${addr(d.steps.keyTransfer.to)}</td></tr>` : ''}` : ''}
          </tbody></table>
        </div>
      </section>`;
  }

  function renderFees(d) {
    const f = ui.fees;
    return `
      <section class="nft-panel">
        <div class="nft-panel-head"><h3>Trading fees</h3></div>
        <div class="nft-panel-body">
          <p>Fees are paid in SOL to whoever holds the Fee Key${f?.holder ? `: ${addr(f.holder)}` : ''}.</p>
          <table class="nft-table nft-kv"><tbody>
            <tr><td>Unclaimed</td><td>${f ? sol(f.unclaimedSol, 6) : '-'}</td></tr>
          </tbody></table>
          <p class="nft-muted nft-small">The first claim from a wallet opens a token account for the pool's token (about 0.002 SOL, refundable).</p>
          <div class="nft-actions">
            <button class="secondary-button" type="button" data-lean-action="fees">Refresh</button>
            <button class="primary-button" type="button" data-lean-action="claim" ${f?.holder && f.unclaimedSol > 0 ? '' : 'disabled'}>Claim fees</button>
          </div>
          ${f && !f.holder ? `<p class="nft-muted nft-small">Trebuchet does not manage the wallet that holds this Fee Key. Claim from the wallet that does.</p>` : ''}
        </div>
      </section>`;
  }

  // ---------------------------------------------------------------- actions

  async function saveDraft() {
    const body = { config: configFromForm(), walletPublicKey: ui.form.walletPublicKey || null };
    if (ui.form.logoDataUrl !== null) body.logoDataUrl = ui.form.logoDataUrl || null;
    const data = ui.detail
      ? await request(`/api/v2/damm/launches/${encodeURIComponent(ui.detail.id)}/update`, { method: 'POST', body })
      : await request('/api/v2/damm/launches', { method: 'POST', body: { ...body, logoDataUrl: ui.form.logoDataUrl || null } });
    ui.selectedId = data.launch.id;
    ui.dirty = false;
    ui.form.logoDataUrl = null;
    await loadList();
    await loadDetail();
    ui.notice = 'Saved.';
  }

  async function act(action) {
    switch (action) {
      case 'dismiss':
        ui.error = null;
        ui.notice = null;
        render();
        return;
      case 'clear-logo':
        ui.form.logoDataUrl = '';
        ui.form.logoName = '';
        ui.dirty = true;
        render();
        return;
      case 'balance':
        await guard('Checking balance', loadBalance);
        return;
      case 'save':
        await guard('Saving', saveDraft);
        return;
      case 'remove':
        await guard('Deleting', async () => {
          await request(`/api/v2/damm/launches/${encodeURIComponent(ui.detail.id)}/remove`, { method: 'POST', body: {} });
          ui.selectedId = null;
          ui.detail = null;
          ui.form = { ...DEFAULTS };
          ui.dirty = false;
          ui.approved = false;
          await loadList();
          await loadWallets();
        });
        return;
      case 'run':
        await guard('Starting', async () => {
          if (!ui.estimate) throw new Error('Wait for the estimate first.');
          if (ui.detail.status === 'draft' && !ui.approved) throw new Error('Approve the spend first.');
          await request(`/api/v2/damm/launches/${encodeURIComponent(ui.detail.id)}/run`, {
            method: 'POST',
            body: { maxSpendSol: ui.estimate.cost.total, solUsd: ui.estimate.solUsd },
          });
          ui.approved = false;
          await loadList();
          await loadDetail();
        });
        return;
      case 'fees':
        await guard('Reading fees', loadFees);
        return;
      case 'claim':
        await guard('Claiming', async () => {
          const claimed = await request(`/api/v2/damm/launches/${encodeURIComponent(ui.detail.id)}/claim`, { method: 'POST', body: {} });
          ui.notice = `Claimed ${sol(claimed.receivedSol, 6)}.`;
          await loadFees();
        });
        return;
      default:
    }
  }

  function setField(name, value) {
    if (name === 'approved') {
      ui.approved = value === true;
      render();
      return;
    }
    if (name === 'startingMarketCapUsd') {
      ui.form.startingMarketCapUsd = String(value).replace(/[^0-9]/g, '');
    } else if (name === 'rangeMultiple' || name === 'feeBps') {
      ui.form[name] = Number(value);
    } else {
      ui.form[name] = value;
    }
    ui.dirty = true;
    ui.approved = false;
    if (name === 'walletPublicKey') loadBalance().then(render);
    scheduleEstimate();
    // Every edit takes the approval back, so the buttons must say so now, not when the estimate returns.
    render();
  }

  function onClick(event) {
    const el = event.target.closest('[data-lean-action]');
    if (!el || el.tagName === 'SELECT') return;
    act(el.dataset.leanAction);
  }

  function onInput(event) {
    const el = event.target;
    if (el.dataset.leanField && el.type !== 'checkbox' && el.tagName !== 'SELECT') setField(el.dataset.leanField, el.value);
  }

  async function onChange(event) {
    const el = event.target;
    if (el.dataset.leanAction === 'select') {
      ui.selectedId = el.value || null;
      ui.dirty = false;
      ui.approved = false;
      ui.fees = null;
      ui.form = { ...DEFAULTS };
      ui.estimate = null;
      await guard('Loading', async () => {
        await loadDetail();
        await loadWallets();
        await loadBalance();
        if (!ui.detail && formReady()) await loadEstimate();
        await loadFees();
      });
      return;
    }
    if (el.dataset.leanFile === 'logo' && el.files?.[0]) {
      const file = el.files[0];
      await guard('Preparing the logo', async () => {
        ui.form.logoDataUrl = await logoFromFile(file);
        ui.form.logoName = `${file.name} (${Math.round(dataUrlBytes(ui.form.logoDataUrl) / 1024)} KB)`;
        ui.dirty = true;
      });
      return;
    }
    if (el.dataset.leanField && (el.type === 'checkbox' || el.tagName === 'SELECT')) {
      setField(el.dataset.leanField, el.type === 'checkbox' ? el.checked : el.value);
    }
  }

  async function onShow() {
    const el = root();
    if (!el) return;
    if (!el.dataset.leanBound) {
      el.dataset.leanBound = '1';
      el.addEventListener('click', onClick);
      el.addEventListener('input', onInput);
      el.addEventListener('change', onChange);
    }
    if (!global.TrebuchetV2Api?.createV2ApiClient) {
      ui.loaded = true;
      ui.error = 'The local API is unavailable in this preview.';
      render();
      return;
    }
    try {
      await refreshAll();
    } catch (error) {
      ui.error = error?.message || String(error);
    }
    ui.loaded = true;
    render();
  }

  global.TrebuchetLean = { onShow, render };
})(globalThis);
