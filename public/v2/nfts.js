// NFTs view for Trebuchet v2.
//
// Six phases per collection, the same shape as a launch:
//   Collection → Items → Addresses → Fund → Mint → Verify
// The local API (nftRoutes.js) owns every rule; this file renders its state
// and sends the operator's choices. Nothing here holds or sees a key.
(function installTrebuchetNfts(global) {
  const TABS = [
    { id: 'collection', label: 'Collection' },
    { id: 'items', label: 'Items' },
    { id: 'addresses', label: 'Addresses' },
    { id: 'fund', label: 'Fund' },
    { id: 'mint', label: 'Mint' },
    { id: 'verify', label: 'Verify' },
  ];
  const PAGE_SIZE = 20;
  const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;

  const ui = {
    client: null,
    collections: [],
    selectedId: null,
    detail: null,
    tab: 'collection',
    wallets: [],
    walletPublicKey: null,
    estimate: null,
    approved: false,
    odds: { collection: [], items: [] },
    page: 0,
    filter: 'all',
    traitType: null,
    importing: null,
    busy: null,
    error: null,
    notice: null,
    draft: null,
    thumbs: new Map(),
    pollTimer: null,
    loaded: false,
  };

  // ---------------------------------------------------------------- helpers

  function root() {
    return document.getElementById('nftRoot');
  }

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function api() {
    if (!ui.client) ui.client = global.TrebuchetV2Api.createV2ApiClient();
    return ui.client;
  }

  function request(path, init) {
    return api().request(path, init);
  }

  function base(id) {
    return `/api/v2/nfts/${encodeURIComponent(id || ui.selectedId)}`;
  }

  function sol(value, digits = 4) {
    if (!Number.isFinite(value)) return '—';
    return `${value.toFixed(digits)} SOL`;
  }

  function sci(n) {
    if (!Number.isFinite(n)) return '∞';
    if (n < 1e4) return Math.round(n).toLocaleString();
    const exp = Math.floor(Math.log10(n));
    return `${(n / 10 ** exp).toFixed(2)} × 10^${exp}`;
  }

  function bytes(n) {
    if (!Number.isFinite(n)) return '—';
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
  }

  function duration(seconds) {
    if (!Number.isFinite(seconds)) return 'never';
    if (seconds < 1) return '<1 s';
    if (seconds < 90) return `~${Math.round(seconds)} s`;
    if (seconds < 5400) return `~${Math.round(seconds / 60)} min`;
    if (seconds < 172800) return `~${Math.round(seconds / 3600)} h`;
    return `~${Math.round(seconds / 86400)} days`;
  }

  // Short address that keeps both anchors, and the whole vanity pattern.
  function addr(address, vanity) {
    if (!address) return '<span class="nft-muted">not ground</span>';
    const pattern = vanity && vanity.mode !== 'none' ? vanity.pattern.length : 0;
    const tail = Math.max(4, vanity?.mode === 'suffix' ? pattern : 0);
    const head = Math.max(4, vanity?.mode === 'prefix' ? pattern : 0);
    const start = address.slice(0, head);
    const end = address.slice(-tail);
    const hi = (text) => `<span class="nft-ok">${esc(text)}</span>`;
    const left = vanity?.mode === 'prefix' ? hi(start.slice(0, pattern)) + esc(start.slice(pattern)) : esc(start);
    const right = vanity?.mode === 'suffix' ? esc(end.slice(0, end.length - pattern)) + hi(end.slice(-pattern)) : esc(end);
    return `<span class="nft-addr" title="${esc(address)}">${left}…${right}</span>`;
  }

  function stateTag(kind, text) {
    const shapes = { draft: '○', model: '◇', staged: '◆', run: '◐', ok: '●', warn: '▲', bad: '✕' };
    return `<span class="nft-tag nft-tag-${kind}">${shapes[kind] || ''} ${esc(text)}</span>`;
  }

  function setError(error) {
    ui.error = error ? (error.message || String(error)) : null;
    render();
  }

  async function guard(label, fn) {
    ui.busy = label;
    ui.error = null;
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

  // ---------------------------------------------------------------- data

  async function loadList() {
    const data = await request('/api/v2/nfts');
    ui.collections = data.collections || [];
    if (!ui.selectedId && ui.collections.length) ui.selectedId = ui.collections[0].id;
    if (ui.selectedId && !ui.collections.some((c) => c.id === ui.selectedId)) {
      ui.selectedId = ui.collections[0]?.id || null;
    }
  }

  async function loadDetail() {
    if (!ui.selectedId) {
      ui.detail = null;
      return;
    }
    const data = await request(base());
    ui.detail = data.collection;
    if (!ui.draft || ui.draft.id !== ui.detail.id) ui.draft = draftFrom(ui.detail);
    schedulePoll();
  }

  async function loadWallets() {
    try {
      const data = await request('/api/v2/wallets');
      ui.wallets = data.wallets || [];
      if (!ui.walletPublicKey || !ui.wallets.some((w) => w.publicKey === ui.walletPublicKey)) {
        ui.walletPublicKey = ui.detail?.walletPublicKey || ui.wallets[0]?.publicKey || null;
      }
    } catch {
      ui.wallets = [];
    }
  }

  async function refresh() {
    await loadList();
    await loadDetail();
    render();
  }

  // While a job runs, poll the small job endpoint every second and the full
  // collection (which can be MBs for a large drop) every fifth tick.
  function schedulePoll() {
    clearTimeout(ui.pollTimer);
    if (ui.detail?.job?.status !== 'running') return;
    ui.pollTick = (ui.pollTick || 0) + 1;
    ui.pollTimer = setTimeout(async () => {
      try {
        const data = await request(`${base()}/job`);
        const running = data.job?.status === 'running';
        if (!running || ui.pollTick % 5 === 0) {
          await loadDetail();
          if (!running) await loadList();
        } else {
          ui.detail.job = data.job;
          schedulePoll();
        }
      } catch {
        schedulePoll();
      }
      render();
    }, 1000);
  }

  function draftFrom(detail) {
    const c = detail.config;
    return {
      id: detail.id,
      name: c.name,
      symbol: c.symbol,
      description: c.description,
      externalUrl: c.externalUrl,
      royaltyBps: c.royaltyBps,
      ownerAddress: c.ownerAddress || '',
      creators: c.creators.map((x) => ({ ...x })),
      collectionVanity: { ...c.collectionVanity },
      itemVanity: { ...c.itemVanity },
    };
  }

  function draftChanged() {
    if (!ui.detail || !ui.draft) return false;
    const now = draftFrom(ui.detail);
    return JSON.stringify(now) !== JSON.stringify(ui.draft);
  }

  async function loadOdds(target) {
    const v = target === 'collection' ? ui.draft.collectionVanity : ui.draft.itemVanity;
    if (!v || v.mode === 'none' || !v.pattern) {
      ui.odds[target] = [];
      return;
    }
    const q = new URLSearchParams({
      target,
      mode: v.mode,
      pattern: v.pattern,
      caseInsensitive: v.caseInsensitive ? '1' : '0',
    });
    try {
      const data = await request(`${base()}/odds?${q}`);
      ui.odds[target] = data.rows || [];
    } catch (error) {
      ui.odds[target] = [];
      ui.error = error.message;
    }
  }

  // ---------------------------------------------------------------- phases

  function counts(detail) {
    const items = detail?.items || [];
    return {
      items: items.length,
      ground: items.filter((it) => it.address).length,
      uploaded: items.filter((it) => it.metadataUri).length,
      minted: items.filter((it) => it.mintSignature).length,
      failed: items.filter((it) => it.mintError && !it.mintSignature).length,
      review: (detail?.review || []).filter((r) => r.index !== null && r.level !== 'error').length,
      errors: (detail?.review || []).filter((r) => r.level === 'error').length,
    };
  }

  function phaseState(tab, detail) {
    if (!detail) return { kind: 'draft', text: '' };
    const n = counts(detail);
    const job = detail.job?.status === 'running' ? detail.job : null;
    switch (tab) {
      case 'collection':
        return detail.configIssues.some((i) => i.level === 'error')
          ? { kind: 'warn', text: 'Needs input' }
          : detail.collectionSignature ? { kind: 'ok', text: 'On chain' } : { kind: 'ok', text: 'Configured' };
      case 'items':
        if (!n.items) return { kind: 'draft', text: 'Not imported' };
        if (n.errors) return { kind: 'bad', text: `${n.errors} error${n.errors === 1 ? '' : 's'}` };
        if (detail.images.missing.length) return { kind: 'warn', text: `${detail.images.missing.length} images missing` };
        if (n.review) return { kind: 'warn', text: `${n.items.toLocaleString()} · ${n.review} to review` };
        return { kind: 'ok', text: `${n.items.toLocaleString()} ready` };
      case 'addresses':
        if (job?.kind === 'grind') return { kind: 'run', text: `${job.done} / ${job.total}` };
        if (!n.items) return { kind: 'draft', text: 'After import' };
        return n.ground === n.items && detail.collectionKey
          ? { kind: 'ok', text: `${n.items.toLocaleString()} ground` }
          : { kind: 'draft', text: `${n.ground} / ${n.items} ground` };
      case 'fund':
        if (n.items && n.minted === n.items && detail.collectionSignature) return { kind: 'ok', text: 'Nothing left' };
        if (ui.estimate?.shortfallSol > 0) return { kind: 'warn', text: `Short ${sol(ui.estimate.shortfallSol, 3)}` };
        if (ui.estimate) return { kind: 'ok', text: 'Funded' };
        return { kind: 'model', text: `Model ≈${sol(detail.cost.totalSol, 3)}` };
      case 'mint':
        if (job?.kind === 'run') return { kind: 'run', text: job.step === 'mint' ? `${job.done} / ${job.total}` : job.step || 'Starting' };
        if (n.items && n.minted === n.items) return { kind: 'ok', text: 'Minted' };
        if (n.failed) return { kind: 'warn', text: `${n.failed} failed` };
        return n.minted ? { kind: 'warn', text: `${n.minted} / ${n.items}` } : { kind: 'draft', text: 'Not started' };
      case 'verify':
        if (detail.verification?.passed) return { kind: 'ok', text: 'Proof' };
        return detail.verification ? { kind: 'warn', text: 'Needs proof' } : { kind: 'draft', text: 'Needs proof' };
      default:
        return { kind: 'draft', text: '' };
    }
  }

  function nextAction(detail) {
    if (!detail) return { title: 'Create a collection', detail: 'Name it, then import a folder of images and JSON.', action: 'new', label: 'New collection' };
    const n = counts(detail);
    const job = detail.job?.status === 'running' ? detail.job : null;
    if (job) {
      return { title: job.kind === 'grind' ? 'Grinding addresses' : 'Minting', detail: job.detail || 'Working…', action: job.kind === 'grind' ? 'grind-cancel' : 'run-cancel', label: job.kind === 'grind' ? 'Cancel grinding' : 'Stop after current items', secondary: true };
    }
    if (draftChanged()) return { title: 'Save changes', detail: 'The collection has unsaved edits.', action: 'save', label: 'Save collection', tab: 'collection' };
    if (detail.configIssues.some((i) => i.level === 'error')) return { title: 'Finish the collection', detail: detail.configIssues.find((i) => i.level === 'error').detail, tab: 'collection', action: 'tab', label: 'Open collection' };
    if (!n.items) return { title: 'Import items', detail: 'Pick a folder with 0.png + 0.json, 1.png + 1.json, and so on (Sugar format).', action: 'import', label: 'Import folder', tab: 'items' };
    if (n.errors || detail.images.missing.length) return { title: 'Fix item errors', detail: 'Some items have errors or missing images. Fix the folder and import it again.', action: 'tab', tab: 'items', label: 'Open items' };
    if (n.review) return { title: `Review ${n.review} item${n.review === 1 ? '' : 's'}`, detail: 'Accept each flagged item or fix the folder and import again.', action: 'tab', tab: 'items', label: 'Review items' };
    if (!detail.collectionKey || n.ground < n.items) return { title: 'Grind addresses', detail: `${n.items - n.ground + (detail.collectionKey ? 0 : 1)} addresses to make.`, action: 'grind', label: 'Grind addresses', tab: 'addresses' };
    if (n.minted < n.items || !detail.collectionSignature) {
      if (!ui.estimate) return { title: 'Estimate funding', detail: 'Price the uploads and mints for the signing wallet.', action: 'estimate', label: 'Estimate funding', tab: 'fund' };
      if (ui.estimate.shortfallSol > 0) return { title: 'Fund the wallet', detail: `Send at least ${sol(ui.estimate.shortfallSol, 4)} to the signing wallet, then estimate again.`, action: 'estimate', label: 'Estimate again', tab: 'fund' };
      return { title: n.failed ? `Retry ${n.failed} failed` : 'Mint the collection', detail: 'Upload metadata, create the collection, and mint every item.', action: 'tab', tab: 'mint', label: n.failed ? 'Open mint' : 'Review and mint' };
    }
    if (!detail.verification?.passed) return { title: 'Verify on chain', detail: 'Read every asset back and check it.', action: 'verify', label: 'Verify', tab: 'verify' };
    return { title: 'Collection proven', detail: 'Every asset checks out on chain.', action: 'proof', label: 'Download proof', tab: 'verify' };
  }

  // ---------------------------------------------------------------- render

  function render() {
    const el = root();
    if (!el) return;
    if (!ui.loaded) {
      el.innerHTML = '<div class="nft-empty">Loading NFTs…</div>';
      return;
    }
    const d = ui.detail;
    const focus = captureFocus(el);
    el.innerHTML = `
      <div class="nft-shell">
        ${renderHeader(d)}
        ${ui.error ? `<div class="nft-banner nft-banner-bad" role="alert">${esc(ui.error)}<button type="button" class="nft-link" data-nft-action="dismiss">Dismiss</button></div>` : ''}
        ${ui.notice ? `<div class="nft-banner nft-banner-ok" role="status">${esc(ui.notice)}<button type="button" class="nft-link" data-nft-action="dismiss">Dismiss</button></div>` : ''}
        ${d ? renderTabs(d) : ''}
        <div class="nft-grid">
          <div class="nft-main">${d ? renderTab(d) : renderEmpty()}</div>
          ${renderRail(d)}
        </div>
      </div>`;
    restoreFocus(el, focus);
    loadVisibleThumbs();
  }

  // Re-rendering replaces the inputs; keep the caret where the operator is typing.
  function captureFocus(el) {
    const active = document.activeElement;
    if (!active || !el.contains(active)) return null;
    const key = active.dataset.nftField ? `[data-nft-field="${active.dataset.nftField}"]`
      : active.dataset.nftCreator ? `[data-nft-creator="${active.dataset.nftCreator}"]` : null;
    if (!key) return null;
    let start = null;
    let end = null;
    try { start = active.selectionStart; end = active.selectionEnd; } catch { /* not a text input */ }
    return { key, start, end };
  }

  function restoreFocus(el, focus) {
    if (!focus) return;
    const next = el.querySelector(focus.key);
    if (!next) return;
    next.focus();
    try { if (focus.start !== null) next.setSelectionRange(focus.start, focus.end); } catch { /* not a text input */ }
  }

  function renderHeader(d) {
    const options = ui.collections.map((c) => `<option value="${esc(c.id)}" ${c.id === ui.selectedId ? 'selected' : ''}>${esc(c.name || 'Untitled collection')} · ${c.minted}/${c.itemCount}</option>`).join('');
    return `
      <div class="nft-head">
        <div class="nft-head-title">
          <strong>${esc(d ? d.config.name || 'Untitled collection' : 'No collection')}</strong>
          ${d ? stateTag(d.verification?.passed ? 'ok' : d.job?.status === 'running' ? 'run' : d.collectionSignature ? 'warn' : 'draft', d.verification?.passed ? 'Proof' : d.job?.status === 'running' ? 'Running' : d.collectionSignature ? 'On chain' : 'Draft') : ''}
        </div>
        <div class="nft-head-actions">
          ${ui.collections.length ? `<label class="nft-inline"><span class="nft-label">Collection</span><select data-nft-action="select">${options}</select></label>` : ''}
          <button class="secondary-button compact" type="button" data-nft-action="new"><i class="fa-solid fa-plus"></i><span>New</span></button>
        </div>
      </div>`;
  }

  function renderTabs(d) {
    return `<nav class="nft-tabs" role="tablist" aria-label="Collection phases">${TABS.map((t, i) => {
      const s = phaseState(t.id, d);
      return `<button type="button" role="tab" class="nft-tab ${ui.tab === t.id ? 'is-selected' : ''}" aria-selected="${ui.tab === t.id}" data-nft-tab="${t.id}">
        <span class="nft-tab-n">0${i + 1}</span>
        <span><strong>${t.label}</strong><small class="nft-tone-${s.kind}">${esc(s.text)}</small></span>
      </button>`;
    }).join('')}</nav>`;
  }

  function renderEmpty() {
    return `<section class="nft-panel"><div class="nft-panel-body">
      <p>Make a Metaplex Core collection with a vanity collection address and, optionally, a vanity address for every item.</p>
      <p class="nft-muted">Keys come from split-key grinding: the grinder only sees a public point, and Trebuchet keeps each key encrypted under your PIN.</p>
    </div></section>`;
  }

  function renderRail(d) {
    const next = nextAction(d);
    const issues = d ? [
      ...d.configIssues.map((i) => ({ level: i.level, text: i.detail })),
      ...(d.images?.missing?.length ? [{ level: 'error', text: `${d.images.missing.length} item image${d.images.missing.length === 1 ? '' : 's'} missing` }] : []),
    ] : [];
    const n = counts(d);
    const checks = d ? [
      { ok: !d.configIssues.some((i) => i.level === 'error'), text: 'Collection config complete' },
      { ok: n.items > 0 && !n.errors && !d.images.missing.length, text: `${n.items.toLocaleString()} items imported` },
      { ok: n.items > 0 && !n.review && !n.errors, warn: n.review > 0, text: n.review ? `${n.review} items to review` : 'Items reviewed' },
      { ok: Boolean(d.collectionKey) && n.ground === n.items && n.items > 0, text: `Addresses ${n.ground} / ${n.items}` },
      { ok: n.minted === n.items && n.items > 0, text: `Minted ${n.minted} / ${n.items}` },
      { ok: d.verification?.passed === true, text: d.verification?.passed ? 'Verified on chain' : 'Not verified' },
    ] : [];
    return `
      <aside class="nft-panel nft-rail" aria-label="Next action">
        <div class="nft-panel-head"><span class="eyebrow">Next action</span></div>
        <div class="nft-panel-body">
          <div class="nft-next-title">${esc(next.title)}</div>
          <p class="nft-muted">${esc(next.detail)}</p>
          <button class="${next.secondary ? 'secondary-button' : 'primary-button'} nft-wide" type="button" data-nft-action="${esc(next.action)}" ${next.tab ? `data-nft-goto="${esc(next.tab)}"` : ''} ${ui.busy ? 'disabled' : ''}>
            ${ui.busy ? `<span>${esc(ui.busy)}…</span>` : `<span>${esc(next.label)}</span>`}
          </button>
          ${checks.length ? `<div class="nft-label nft-gap">Checks</div><ul class="nft-checks">${checks.map((c) => `<li><span class="${c.ok ? 'nft-ok' : c.warn ? 'nft-warn' : 'nft-muted'}">${c.ok ? '✓' : c.warn ? '▲' : '○'}</span><span>${esc(c.text)}</span></li>`).join('')}</ul>` : ''}
          ${issues.length ? `<div class="nft-label nft-gap">Issues</div><ul class="nft-checks">${issues.map((i) => `<li><span class="${i.level === 'error' ? 'nft-bad' : 'nft-warn'}">${i.level === 'error' ? '✕' : '▲'}</span><span>${esc(i.text)}</span></li>`).join('')}</ul>` : ''}
        </div>
      </aside>`;
  }

  function renderTab(d) {
    switch (ui.tab) {
      case 'items': return renderItems(d);
      case 'addresses': return renderAddresses(d);
      case 'fund': return renderFund(d);
      case 'mint': return renderMint(d);
      case 'verify': return renderVerify(d);
      default: return renderCollection(d);
    }
  }

  function field(label, name, value, attrs = '') {
    return `<label class="nft-field"><span class="nft-label">${label}</span><input class="nft-input" data-nft-field="${name}" value="${esc(value)}" ${attrs}></label>`;
  }

  function vanityControls(target, v, locked) {
    return `
      <div class="nft-row-controls">
        <div class="nft-seg" role="group" aria-label="${target} address match">
          ${['none', 'prefix', 'suffix'].map((m) => `<button type="button" aria-pressed="${v.mode === m}" data-nft-vmode="${target}:${m}" ${locked ? 'disabled' : ''}>${m === 'none' ? 'Any' : m[0].toUpperCase() + m.slice(1)}</button>`).join('')}
        </div>
        <input class="nft-input nft-pattern" aria-label="${target} pattern" data-nft-field="${target}Vanity.pattern" value="${esc(v.pattern)}" placeholder="pattern" maxlength="8" ${v.mode === 'none' || locked ? 'disabled' : ''}>
        <label class="nft-inline"><input class="nft-check" type="checkbox" data-nft-field="${target}Vanity.caseInsensitive" ${v.caseInsensitive ? 'checked' : ''} ${v.mode === 'none' || locked ? 'disabled' : ''}> Any case</label>
      </div>`;
  }

  function oddsTable(rows, perItem) {
    if (!rows.length) return '';
    const rate = ui.detail?.grind?.keysPerSec;
    return `
      <table class="nft-table">
        <thead><tr><th>${perItem ? 'Pattern' : 'Pattern'}</th><th>Tries each</th><th>Each</th>${perItem ? `<th>All ${ui.detail.items.length.toLocaleString()}</th>` : ''}</tr></thead>
        <tbody>${rows.map((r, i) => `<tr class="${i === rows.length - 1 ? 'is-selected' : ''}"><td>${esc(r.pattern)}</td><td>${sci(r.attempts)}</td><td>${duration(r.secondsEach)}</td>${perItem ? `<td class="${r.secondsAll > 86400 ? 'nft-bad' : r.secondsAll > 3600 ? 'nft-warn' : ''}">${duration(r.secondsAll)}</td>` : ''}</tr>`).join('')}</tbody>
      </table>
      <p class="nft-muted nft-small">At ${rate ? (rate / 1e6).toFixed(1) : '—'} M keys/s ${ui.detail?.grind?.keysPerSec === 28000000 ? '(default until a grind measures this machine)' : '(measured)'}. Averages: some grinds take 3× longer.</p>`;
  }

  function renderCollection(d) {
    const dr = ui.draft;
    const onChain = Boolean(d.collectionSignature);
    const creators = dr.creators.map((c, i) => `
      <div class="nft-creator">
        <input class="nft-input" aria-label="Creator ${i + 1} address" data-nft-creator="${i}:address" value="${esc(c.address)}" ${onChain ? 'disabled' : ''}>
        <input class="nft-input nft-num" aria-label="Creator ${i + 1} share" data-nft-creator="${i}:percentage" value="${esc(c.percentage)}" ${onChain ? 'disabled' : ''}>
        <button type="button" class="text-button" data-nft-action="creator-remove" data-nft-index="${i}" aria-label="Remove creator ${i + 1}" ${onChain ? 'disabled' : ''}>Remove</button>
      </div>`).join('');
    const total = dr.creators.reduce((s, c) => s + (Number(c.percentage) || 0), 0);
    return `
      <section class="nft-panel">
        <div class="nft-panel-head"><span class="eyebrow">01</span><h3>Collection</h3>${onChain ? stateTag('ok', 'On chain · fixed') : stateTag('draft', 'Draft')}</div>
        <div class="nft-panel-body">
          <div class="nft-form-grid">
            ${field('Name', 'name', dr.name, `maxlength="32" ${onChain ? 'disabled' : ''}`)}
            ${field('Symbol', 'symbol', dr.symbol, 'maxlength="10"')}
            ${field('Royalties (bps)', 'royaltyBps', dr.royaltyBps, `inputmode="numeric" ${onChain ? 'disabled' : ''}`)}
          </div>
          <label class="nft-field"><span class="nft-label">Description</span><textarea class="nft-input nft-textarea" data-nft-field="description" maxlength="1000">${esc(dr.description)}</textarea></label>
          <div class="nft-form-grid nft-form-grid-2">
            ${field('Website (optional)', 'externalUrl', dr.externalUrl, 'placeholder="https://"')}
            ${field('Mint items to (optional)', 'ownerAddress', dr.ownerAddress, 'placeholder="Signing wallet" spellcheck="false"')}
          </div>
          <div class="nft-field">
            <span class="nft-label">Cover image</span>
            <div class="nft-cover">
              <span class="nft-thumb nft-thumb-lg" data-nft-thumb="cover" data-nft-thumb-type="${esc(d.cover?.type || '')}"></span>
              <span>${d.cover ? `${esc(d.cover.type.toUpperCase())} · ${bytes(d.cover.bytes)}${d.collectionImageUri ? ' · uploaded' : ''}` : '<span class="nft-muted">None yet. Import a folder with collection.png, or pick one.</span>'}</span>
              <label class="secondary-button compact nft-file" ${d.collectionMetadataUri ? 'aria-disabled="true"' : ''}><span>${d.cover ? 'Replace' : 'Choose'}</span><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-nft-file="cover" ${d.collectionMetadataUri ? 'disabled' : ''}></label>
            </div>
          </div>
          <div class="nft-field">
            <span class="nft-label">Creators · shares must total 100 · <span class="${total === 100 || !dr.creators.length ? 'nft-ok' : 'nft-bad'}">${total}</span></span>
            ${creators || '<span class="nft-muted">No creators: royalties are off.</span>'}
            ${onChain ? '' : `<button type="button" class="text-button" data-nft-action="creator-add">+ Add creator</button>`}
          </div>
          <div class="nft-field">
            <span class="nft-label">Standard</span>
            <table class="nft-table">
              <thead><tr><th>Standard</th><th>Vanity address</th><th>Cost / item</th><th>Royalties</th></tr></thead>
              <tbody>
                <tr class="is-selected"><td><strong>Metaplex Core</strong> <span class="nft-ok">selected</span></td><td class="nft-ok">● Yes · asset key</td><td>${sol(d.cost.perAssetSol, 5)}</td><td>Plugin · enforced</td></tr>
                <tr class="nft-dim"><td>Token Metadata · pNFT</td><td>Yes · mint key</td><td>higher</td><td>Not built yet</td></tr>
                <tr class="nft-dim"><td>Compressed · Bubblegum</td><td class="nft-bad">✕ No vanity</td><td>lowest</td><td>Not built yet</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>
      <section class="nft-panel">
        <div class="nft-panel-head"><span class="eyebrow">Vanity CA</span><h3>Collection address</h3>${d.collectionKey ? stateTag('ok', 'Ground') : stateTag('staged', 'Not ground')}</div>
        <div class="nft-panel-body">
          ${d.collectionKey ? `<div class="nft-big-addr">${addr(d.collectionKey.address, d.config.collectionVanity)} <button type="button" class="text-button" data-nft-copy="${esc(d.collectionKey.address)}">Copy</button></div>` : ''}
          ${vanityControls('collection', dr.collectionVanity, onChain)}
          ${oddsTable(ui.odds.collection, false)}
          <p class="nft-muted nft-small">Changing the pattern discards an unused collection key that no longer matches. Grinding happens in the Addresses phase.</p>
        </div>
      </section>
      <div class="nft-actions">
        <button class="primary-button" type="button" data-nft-action="save" ${draftChanged() ? '' : 'disabled'}>Save collection</button>
        <button class="secondary-button" type="button" data-nft-action="revert" ${draftChanged() ? '' : 'disabled'}>Discard edits</button>
        <button class="secondary-button nft-danger" type="button" data-nft-action="delete">Delete local collection…</button>
      </div>
      ${ui.confirmDelete ? renderDeleteConfirm(d) : ''}`;
  }

  function renderDeleteConfirm(d) {
    const onChain = Boolean(d.collectionSignature || d.items.some((it) => it.mintSignature));
    return `
      <section class="nft-panel nft-confirm" role="dialog" aria-label="Delete collection">
        <div class="nft-panel-body">
          <strong>Delete the local record of ${esc(d.config.name)}?</strong>
          <p class="nft-muted">${onChain ? 'Assets already on chain stay there. Unminted keys and imported images are deleted. Type the collection address to confirm.' : 'Imported images and ground keys are deleted. Nothing is on chain yet.'}</p>
          ${onChain ? `<input class="nft-input" data-nft-field="confirmDelete" aria-label="Collection address" placeholder="${esc(d.collectionKey?.address || '')}">` : ''}
          <div class="nft-actions"><button class="secondary-button nft-danger" type="button" data-nft-action="delete-confirm">Delete</button><button class="secondary-button" type="button" data-nft-action="delete-cancel">Cancel</button></div>
        </div>
      </section>`;
  }

  function reviewFor(d, index) {
    return d.review.filter((r) => r.index === index);
  }

  function renderItems(d) {
    const n = counts(d);
    const flagged = new Set(d.review.filter((r) => r.index !== null).map((r) => r.index));
    const rows = ui.filter === 'review' ? d.items.filter((it) => flagged.has(it.index)) : d.items;
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    ui.page = Math.min(ui.page, pages - 1);
    const pageRows = rows.slice(ui.page * PAGE_SIZE, (ui.page + 1) * PAGE_SIZE);
    const traits = d.traits || [];
    const trait = traits.find((t) => t.traitType === ui.traitType) || traits[0];
    const importing = ui.importing;
    return `
      <section class="nft-panel">
        <div class="nft-panel-head"><span class="eyebrow">02</span><h3>Items</h3><span class="nft-muted">${n.items ? `${n.items.toLocaleString()} items · ${bytes(d.items.reduce((s, it) => s + (it.imageBytes || 0), 0))}` : 'Nothing imported'}</span>
          <label class="secondary-button compact nft-file nft-push" ${n.uploaded ? 'aria-disabled="true"' : ''}><span>${n.items ? 'Re-import folder' : 'Import folder'}</span><input type="file" webkitdirectory multiple data-nft-file="folder" ${n.uploaded ? 'disabled' : ''}></label>
        </div>
        ${importing ? `<div class="nft-progress-row"><span>${esc(importing.label)}</span><span class="nft-bar"><span style="width:${importing.total ? (100 * importing.done) / importing.total : 0}%"></span></span><span>${importing.done} / ${importing.total}</span></div>` : ''}
        ${n.items ? `
        <div class="nft-toolbar">
          <div class="nft-seg" role="group" aria-label="Filter items">
            <button type="button" aria-pressed="${ui.filter === 'all'}" data-nft-filter="all">All ${n.items.toLocaleString()}</button>
            <button type="button" aria-pressed="${ui.filter === 'review'}" data-nft-filter="review">Flagged ${flagged.size}</button>
          </div>
          ${flagged.size && !n.uploaded ? `<button type="button" class="secondary-button compact" data-nft-action="accept-all">Accept all warnings</button>` : ''}
        </div>
        <table class="nft-table nft-items">
          <thead><tr><th>#</th><th></th><th>Name</th><th>Traits</th><th>Image</th><th>Address</th><th>State</th></tr></thead>
          <tbody>${pageRows.map((it) => {
            const issues = reviewFor(d, it.index);
            const bad = issues.some((x) => x.level === 'error');
            return `<tr class="${issues.length ? 'is-flagged' : ''}">
              <td class="${issues.length ? (bad ? 'nft-bad' : 'nft-warn') : 'nft-muted'}">${String(it.index).padStart(4, '0')}</td>
              <td><span class="nft-thumb" data-nft-thumb="${it.index}" data-nft-thumb-type="${esc(it.imageType || '')}"></span></td>
              <td>${esc(it.name)}${issues.map((x) => `<div class="nft-small ${x.level === 'error' ? 'nft-bad' : 'nft-warn'}">${x.level === 'error' ? '✕' : '▲'} ${esc(x.detail)}</div>`).join('')}</td>
              <td class="nft-muted">${esc(it.attributes.map((a) => a.value).join(' · '))}</td>
              <td>${it.imageType ? `${esc(it.imageType)}${it.imageWidth ? ` ${it.imageWidth}×${it.imageHeight}` : ''}` : '<span class="nft-bad">missing</span>'}</td>
              <td>${addr(it.address, d.config.itemVanity)}</td>
              <td>${it.mintSignature ? stateTag('ok', 'Minted') : it.metadataUri ? stateTag('staged', 'Uploaded') : issues.length && !bad && !it.accepted ? `<button type="button" class="text-button" data-nft-action="accept" data-nft-index="${it.index}">Accept</button>` : stateTag('draft', 'Draft')}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
        <div class="nft-pager"><span class="nft-muted">Rows ${rows.length ? ui.page * PAGE_SIZE + 1 : 0}–${Math.min(rows.length, (ui.page + 1) * PAGE_SIZE)} of ${rows.length.toLocaleString()}</span>
          <span><button type="button" class="secondary-button compact" data-nft-page="-1" ${ui.page === 0 ? 'disabled' : ''}>Prev</button> <button type="button" class="secondary-button compact" data-nft-page="1" ${ui.page >= pages - 1 ? 'disabled' : ''}>Next</button></span></div>
        ` : `<div class="nft-panel-body"><p>Pick a folder in the Metaplex Sugar layout: <code>0.png</code> + <code>0.json</code>, <code>1.png</code> + <code>1.json</code>, … and optionally <code>collection.png</code> + <code>collection.json</code>.</p><p class="nft-muted">Each JSON needs <code>name</code> and may have <code>description</code> and <code>attributes</code>. Images stay on this machine until the mint uploads them to Arweave.</p></div>`}
      </section>
      ${trait ? `
      <section class="nft-panel">
        <div class="nft-panel-head"><span class="eyebrow">Traits</span><h3>${esc(trait.traitType)}</h3><span class="nft-muted">${traits.length} traits</span></div>
        <div class="nft-panel-body">
          <div class="nft-chips">${traits.map((t) => `<button type="button" class="nft-chip" aria-pressed="${t.traitType === trait.traitType}" data-nft-trait="${esc(t.traitType)}">${esc(t.traitType)}</button>`).join('')}</div>
          ${trait.values.slice(0, 12).map((v) => `<div class="nft-dist"><span>${esc(v.value)}</span><span class="nft-bar"><span style="width:${(100 * v.count) / trait.values[0].count}%"></span></span><span class="nft-muted">${v.count} · ${(v.share * 100).toFixed(1)}%</span></div>`).join('')}
        </div>
      </section>` : ''}`;
  }

  function renderAddresses(d) {
    const n = counts(d);
    const dr = ui.draft;
    const job = d.job?.kind === 'grind' ? d.job : null;
    const running = job?.status === 'running';
    const locked = n.minted > 0;
    const recent = d.items.filter((it) => it.address).slice(-6).reverse();
    return `
      <section class="nft-panel">
        <div class="nft-panel-head"><span class="eyebrow">03</span><h3>Collection address</h3>${d.collectionKey ? stateTag('ok', 'Ground') : stateTag('draft', 'Not ground')}</div>
        <div class="nft-panel-body nft-facts">
          <div><span class="nft-label">Address</span><div class="nft-big-addr">${addr(d.collectionKey?.address, d.config.collectionVanity)}</div></div>
          <div><span class="nft-label">Pattern</span><div>${d.config.collectionVanity.mode === 'none' ? 'any address' : `${esc(d.config.collectionVanity.mode)} ${esc(d.config.collectionVanity.pattern)}${d.config.collectionVanity.caseInsensitive ? ' · any case' : ''}`}</div></div>
          <div><span class="nft-label">Tries</span><div>${d.collectionKey?.attempts ? sci(d.collectionKey.attempts) : '—'}</div></div>
          <div><span class="nft-label">Time</span><div>${d.collectionKey?.elapsedSec ? duration(d.collectionKey.elapsedSec) : '—'}</div></div>
        </div>
      </section>
      <section class="nft-panel">
        <div class="nft-panel-head"><span class="eyebrow">03</span><h3>Item addresses</h3><span class="nft-muted">one pattern for every item</span></div>
        <div class="nft-panel-body">
          ${vanityControls('item', dr.itemVanity, locked)}
          ${draftChanged() ? '<div class="nft-actions"><button class="primary-button" type="button" data-nft-action="save">Save pattern</button><span class="nft-muted nft-small">Saving discards unused keys that do not match.</span></div>' : ''}
          ${oddsTable(ui.odds.items, true)}
        </div>
      </section>
      <section class="nft-panel">
        <div class="nft-panel-head"><span class="eyebrow">Queue</span><h3>${n.ground.toLocaleString()} / ${n.items.toLocaleString()} ground</h3>${running ? stateTag('run', 'Running') : job?.status === 'failed' ? stateTag('bad', 'Failed') : ''}
          <span class="nft-push">${running ? `<button class="secondary-button compact" type="button" data-nft-action="grind-cancel">Cancel</button>` : `<button class="primary-button compact" type="button" data-nft-action="grind" ${n.items && (n.ground < n.items || !d.collectionKey) && !draftChanged() ? '' : 'disabled'}>Grind ${n.items - n.ground + (d.collectionKey ? 0 : 1)} addresses</button>`}</span></div>
        <div class="nft-progress-row"><span>${running ? esc(job.detail || '') : ''}</span><span class="nft-bar"><span style="width:${running && job.total ? (100 * job.done) / job.total : n.items ? (100 * n.ground) / n.items : 0}%"></span></span><span>${running && job.rate ? `${(job.rate / 1e6).toFixed(1)} M/s` : ''}</span></div>
        ${job?.error ? `<div class="nft-panel-body nft-bad">${esc(job.error)}</div>` : ''}
        ${recent.length ? `<table class="nft-table"><thead><tr><th>Item</th><th>Address</th><th>Tries</th><th>Time</th></tr></thead><tbody>${recent.map((it) => `<tr><td class="nft-muted">#${String(it.index).padStart(4, '0')}</td><td>${addr(it.address, d.config.itemVanity)}</td><td>${it.key?.attempts ? sci(it.key.attempts) : '—'}</td><td>${it.key?.elapsedSec ? duration(it.key.elapsedSec) : '—'}</td></tr>`).join('')}</tbody></table>` : ''}
      </section>
      <section class="nft-panel">
        <div class="nft-panel-head"><span class="eyebrow">Custody</span><h3>How each key is made</h3></div>
        <ol class="nft-steps">
          <li>Trebuchet makes a secret <strong>a</strong> and keeps it encrypted under your PIN.</li>
          <li>The grinder gets only the public point <strong>A = a·G</strong>.</li>
          <li>It walks <strong>A + k·G</strong> until the address matches, then returns <strong>k</strong>.</li>
          <li>Trebuchet checks that <strong>k</strong> gives the pattern. A wrong offset is rejected.</li>
          <li>The key <strong>a + k</strong> is stored encrypted and signs that asset's create transaction once.</li>
        </ol>
        <p class="nft-muted nft-small nft-pad">A PIN reset deletes unminted keys. Addresses are not reserved on chain until minted.</p>
      </section>`;
  }

  function walletOptions() {
    if (!ui.wallets.length) return '<span class="nft-muted">No Trebuchet wallet. Create one in Wallet.</span>';
    return `<select data-nft-action="wallet" aria-label="Signing wallet" ${ui.detail?.walletPublicKey ? 'disabled' : ''}>${ui.wallets.map((w) => `<option value="${esc(w.publicKey)}" ${w.publicKey === ui.walletPublicKey ? 'selected' : ''}>${esc(w.label || 'Wallet')} · ${esc(w.publicKey.slice(0, 4))}…${esc(w.publicKey.slice(-4))}</option>`).join('')}</select>`;
  }

  function renderFund(d) {
    const e = ui.estimate;
    const c = e || d.cost;
    return `
      <section class="nft-panel">
        <div class="nft-panel-head"><span class="eyebrow">04</span><h3>Fund</h3>${e ? stateTag(e.shortfallSol > 0 ? 'warn' : 'ok', e.shortfallSol > 0 ? 'Short' : 'Funded') : stateTag('model', 'Model')}</div>
        <div class="nft-panel-body">
          <div class="nft-row-controls"><span class="nft-label">Signing wallet</span>${walletOptions()}
            <button class="primary-button compact" type="button" data-nft-action="estimate" ${ui.walletPublicKey ? '' : 'disabled'}>${e ? 'Estimate again' : 'Estimate funding'}</button></div>
          ${d.walletPublicKey ? `<p class="nft-muted nft-small">This collection is signed by ${esc(d.walletPublicKey)}. It keeps the same wallet.</p>` : ''}
          <table class="nft-table nft-kv">
            <tbody>
              <tr><td>Collection account</td><td>${sol(c.collectionSol, 5)}</td></tr>
              <tr><td>${c.remainingItems.toLocaleString()} assets × ${sol(c.perAssetSol, 5)}</td><td>${sol(c.assetsSol)}</td></tr>
              <tr><td>Priority fees</td><td>${sol(c.priorityFeesSol, 5)}</td></tr>
              <tr><td>Arweave storage${e ? ` · ${bytes(e.uploadBytes)}` : ''}</td><td>${e ? (e.storageSol === null ? `<span class="nft-warn">price unavailable</span>` : sol(e.storageSol, 5)) : '<span class="nft-muted">priced at estimate</span>'}</td></tr>
              <tr><td>Buffer 20%</td><td>${sol(c.bufferSol)}</td></tr>
              <tr class="nft-total"><td>Total</td><td>${sol(c.totalSol)}</td></tr>
              ${e ? `<tr><td>Wallet balance</td><td>${sol(e.balanceSol)}</td></tr><tr><td>Shortfall</td><td class="${e.shortfallSol > 0 ? 'nft-bad' : 'nft-ok'}">${sol(e.shortfallSol)}</td></tr>` : ''}
            </tbody>
          </table>
          ${e?.storageError ? `<p class="nft-warn nft-small">Storage price lookup failed: ${esc(e.storageError)}</p>` : ''}
          ${e?.shortfallSol > 0 ? `<p>Send at least <strong>${sol(e.shortfallSol)}</strong> to <code>${esc(e.walletPublicKey)}</code> <button type="button" class="text-button" data-nft-copy="${esc(e.walletPublicKey)}">Copy</button>, then estimate again.</p>` : ''}
          <p class="nft-muted nft-small">Asset and collection costs were measured on the Metaplex Core program and include its protocol fee. Rent comes back only if an asset is burned.</p>
        </div>
      </section>`;
  }

  function renderMint(d) {
    const n = counts(d);
    const job = d.job?.kind === 'run' ? d.job : null;
    const running = job?.status === 'running';
    const e = ui.estimate;
    const failed = d.items.filter((it) => it.mintError && !it.mintSignature);
    const ready = e && e.shortfallSol <= 0 && n.items && n.ground === n.items && d.collectionKey;
    const steps = [
      { label: 'Upload metadata', detail: `${n.uploaded} / ${n.items} items${d.collectionMetadataUri ? ' + collection' : ''} · Arweave`, state: n.uploaded === n.items && d.collectionMetadataUri ? 'ok' : running && job.step === 'upload' ? 'run' : 'draft' },
      { label: 'Create collection', detail: d.collectionKey ? d.collectionKey.address : '', state: d.collectionSignature ? 'ok' : running && job.step === 'collection' ? 'run' : 'draft', sig: d.collectionSignature },
      { label: 'Mint items', detail: `${n.minted} / ${n.items}${n.failed ? ` · ${n.failed} failed` : ''}`, state: n.minted === n.items && n.items ? 'ok' : running && job.step === 'mint' ? 'run' : n.failed ? 'warn' : 'draft' },
    ];
    const labels = { ok: 'Proof', run: 'Running', warn: 'Review', draft: 'Waiting' };
    return `
      <section class="nft-panel">
        <div class="nft-panel-head"><span class="eyebrow">05</span><h3>Run</h3>${running ? stateTag('run', 'Running') : n.minted === n.items && n.items ? stateTag('ok', 'Minted') : stateTag('staged', 'Staged')}
          <span class="nft-muted nft-push">${n.minted} minted · ${n.failed} failed · ${n.items - n.minted - n.failed} queued</span></div>
        <div class="nft-progress-row"><span>${running ? esc(job.detail || '') : ''}</span><span class="nft-bar"><span style="width:${running && job.total ? (100 * job.done) / job.total : n.items ? (100 * n.minted) / n.items : 0}%"></span></span><span>${running && job.total ? `${job.done} / ${job.total}` : ''}</span></div>
        <table class="nft-table">
          <thead><tr><th></th><th>Step</th><th>State</th><th>Signature</th></tr></thead>
          <tbody>${steps.map((s) => `<tr><td class="nft-tone-${s.state}">${{ ok: '✓', run: '◐', warn: '▲', draft: '○' }[s.state]}</td><td>${esc(s.label)}<div class="nft-small nft-muted">${esc(s.detail)}</div></td><td>${stateTag(s.state === 'draft' ? 'draft' : s.state, labels[s.state])}</td><td>${s.sig ? `<span class="nft-addr" title="${esc(s.sig)}">${esc(s.sig.slice(0, 4))}…${esc(s.sig.slice(-4))}</span>` : '<span class="nft-muted">—</span>'}</td></tr>`).join('')}</tbody>
        </table>
        ${job?.error ? `<div class="nft-panel-body nft-bad">${esc(job.error)}</div>` : ''}
        ${failed.length ? `<div class="nft-panel-body"><div class="nft-label">Failed items</div>${failed.slice(0, 10).map((it) => `<div class="nft-small"><span class="nft-warn">#${String(it.index).padStart(4, '0')}</span> ${esc(it.mintError)}</div>`).join('')}${failed.length > 10 ? `<div class="nft-muted nft-small">and ${failed.length - 10} more</div>` : ''}</div>` : ''}
      </section>
      <section class="nft-panel">
        <div class="nft-panel-head"><span class="eyebrow">Approve</span><h3>${n.items && n.minted === n.items && d.collectionSignature ? 'Done' : n.minted ? 'Resume run' : 'Start run'}</h3></div>
        <div class="nft-panel-body">
          ${running ? `<p>Running: ${esc(job.detail || job.step || '')}</p><button class="secondary-button" type="button" data-nft-action="run-cancel">Stop after current items</button>` : n.items && n.minted === n.items && d.collectionSignature ? `<p>Every item is minted${d.run?.spentSol ? `. This wallet spent ${sol(d.run.spentSol)}` : ''}.</p><button class="secondary-button" type="button" data-nft-action="tab" data-nft-goto="verify">Open verify</button>` : ready ? `
            <table class="nft-table nft-kv"><tbody>
              <tr><td>Signing wallet</td><td><code>${esc(e.walletPublicKey)}</code></td></tr>
              <tr><td>Items to mint</td><td>${(n.items - n.minted).toLocaleString()}</td></tr>
              <tr><td>Spend cap</td><td>${sol(e.totalSol)}</td></tr>
              <tr><td>Estimated at</td><td>${esc(new Date(e.estimatedAt).toLocaleString())}</td></tr>
            </tbody></table>
            <label class="nft-inline"><input class="nft-check" type="checkbox" data-nft-field="approved" ${ui.approved ? 'checked' : ''}> I approve spending up to ${sol(e.totalSol)} from this wallet. The run stops if it would go over.</label>
            <div class="nft-actions"><button class="primary-button" type="button" data-nft-action="run" ${ui.approved ? '' : 'disabled'}>${n.failed ? `Retry ${n.failed} failed and continue` : n.minted ? 'Resume minting' : 'Upload and mint'}</button></div>
            <p class="nft-muted nft-small">A rerun skips anything already on chain, so it never double-mints.</p>` : `<p class="nft-muted">${!n.items || n.ground < n.items || !d.collectionKey ? 'Grind every address first.' : 'Estimate funding with enough balance first.'}</p><button class="secondary-button" type="button" data-nft-action="tab" data-nft-goto="${!n.items || n.ground < n.items || !d.collectionKey ? 'addresses' : 'fund'}">Open ${!n.items || n.ground < n.items || !d.collectionKey ? 'addresses' : 'fund'}</button>`}
        </div>
      </section>`;
  }

  function renderVerify(d) {
    const v = d.verification;
    const n = counts(d);
    const row = (label, check, total) => {
      const failed = check.failed?.length || 0;
      const ok = check.passed === total && !failed;
      return `<tr><td class="${ok ? 'nft-ok' : failed ? 'nft-bad' : 'nft-warn'}">${ok ? '✓' : failed ? '✕' : '▲'}</td><td>${label}${failed ? `<div class="nft-small nft-bad">${esc(check.failed.slice(0, 8).map((x) => (typeof x === 'number' ? `#${x}` : x)).join(', '))}${failed > 8 ? ' …' : ''}</div>` : ''}</td><td>${check.passed} / ${total}</td></tr>`;
    };
    return `
      <section class="nft-panel">
        <div class="nft-panel-head"><span class="eyebrow">06</span><h3>Verify</h3>${v?.passed ? stateTag('ok', 'Proof') : stateTag('warn', 'Needs proof')}
          <span class="nft-push"><button class="primary-button compact" type="button" data-nft-action="verify" ${d.collectionSignature ? '' : 'disabled'}>Verify on chain</button></span></div>
        ${v ? `
        <table class="nft-table">
          <tbody>
            <tr><td class="${v.checks.collection.ok ? 'nft-ok' : 'nft-bad'}">${v.checks.collection.ok ? '✓' : '✕'}</td><td>Collection ${addr(d.collectionKey?.address, d.config.collectionVanity)}${v.checks.collection.detail ? `<div class="nft-small nft-bad">${esc(v.checks.collection.detail)}</div>` : ''}</td><td>${v.checks.collection.royaltyBps === null || v.checks.collection.royaltyBps === undefined ? 'royalties off' : `royalties ${v.checks.collection.royaltyBps} bps`}</td></tr>
            ${row('Address matches pattern', v.checks.pattern, n.items)}
            ${row('In the collection', v.checks.membership, n.items)}
            ${row('Name matches', v.checks.name, n.items)}
            ${row('Metadata URI matches', v.checks.uri, n.items)}
            ${row('Owner', v.checks.owner, n.items)}
            <tr><td class="${v.checks.uriResolves.failed.length ? 'nft-warn' : v.checks.uriResolves.passed ? 'nft-ok' : 'nft-muted'}">${v.checks.uriResolves.failed.length ? '▲' : v.checks.uriResolves.passed ? '✓' : '○'}</td><td>Metadata URI resolves${v.checks.uriResolves.skipped ? ` <span class="nft-muted">(${v.checks.uriResolves.skipped} not checkable)</span>` : ''}</td><td>${v.checks.uriResolves.passed} / ${v.checks.uriResolves.passed + v.checks.uriResolves.failed.length}</td></tr>
            <tr><td class="${v.checks.supply.onChain === n.items ? 'nft-ok' : 'nft-warn'}">${v.checks.supply.onChain === n.items ? '✓' : '○'}</td><td>Supply on chain</td><td>${v.checks.supply.onChain} / ${n.items}</td></tr>
          </tbody>
        </table>
        <p class="nft-muted nft-small nft-pad">Checked ${esc(new Date(v.checkedAt).toLocaleString())}.</p>` : '<div class="nft-panel-body nft-muted">Reads the collection and every asset back from chain and checks address, membership, name, URI, owner and royalties.</div>'}
      </section>
      <div class="nft-actions"><button class="secondary-button" type="button" data-nft-action="proof" ${v ? '' : 'disabled'}>Download proof JSON</button></div>`;
  }

  // ---------------------------------------------------------------- thumbs

  async function loadVisibleThumbs() {
    const el = root();
    if (!el || !ui.detail) return;
    for (const span of el.querySelectorAll('[data-nft-thumb]')) {
      const name = span.dataset.nftThumb;
      if (!span.dataset.nftThumbType) continue;
      const key = `${ui.detail.id}:${name}:${span.dataset.nftThumbType}:${name === 'cover' ? ui.detail.cover?.sha256 : ''}`;
      const cached = ui.thumbs.get(key);
      if (cached) {
        span.style.backgroundImage = `url("${cached}")`;
        continue;
      }
      if (cached === null) continue;
      ui.thumbs.set(key, null);
      thumbFetch(key, name).then((url) => {
        if (url) span.style.backgroundImage = `url("${url}")`;
      });
    }
  }

  async function thumbFetch(key, name) {
    try {
      const token = await api().getSessionToken?.();
      const headers = token ? { 'x-trebuchet-session': token } : {};
      const res = await fetch(`${base()}/images/${encodeURIComponent(name)}`, { headers, credentials: 'same-origin' });
      if (!res.ok) return null;
      const url = URL.createObjectURL(await res.blob());
      ui.thumbs.set(key, url);
      return url;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- import

  async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function imageSize(file) {
    try {
      const bitmap = await createImageBitmap(file);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return size;
    } catch {
      return { width: null, height: null };
    }
  }

  async function readJson(file) {
    try {
      return JSON.parse(await file.text());
    } catch {
      return null;
    }
  }

  async function uploadImage(name, file) {
    await request(`${base()}/images/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      // An ArrayBuffer, not the File: the API client JSON-encodes other objects.
      body: await file.arrayBuffer(),
      timeoutMs: 120000,
    });
  }

  async function importFolder(fileList) {
    const files = Array.from(fileList || []);
    const byStem = new Map();
    for (const file of files) {
      const name = file.name;
      const stem = name.replace(/\.[^.]+$/, '');
      if (!/^(\d+|collection)$/.test(stem)) continue;
      const entry = byStem.get(stem) || {};
      if (/\.json$/i.test(name)) entry.json = file;
      else if (IMAGE_RE.test(name)) entry.image = file;
      byStem.set(stem, entry);
    }
    const stems = [...byStem.keys()].filter((s) => s !== 'collection').map(Number).sort((a, b) => a - b);
    if (!stems.length) throw new Error('No numbered items found. Expected 0.png + 0.json, 1.png + 1.json, …');

    ui.importing = { label: 'Reading files', done: 0, total: stems.length };
    render();
    const items = [];
    for (const index of stems) {
      const { json, image } = byStem.get(String(index));
      const meta = json ? await readJson(json) : null;
      const size = image ? await imageSize(image) : { width: null, height: null };
      items.push({
        index,
        name: meta?.name || '',
        description: meta?.description || '',
        attributes: Array.isArray(meta?.attributes) ? meta.attributes : [],
        imageName: image?.name || '',
        imageBytes: image?.size ?? null,
        imageWidth: size.width,
        imageHeight: size.height,
        imageSha256: image ? await sha256Hex(await image.arrayBuffer()) : null,
      });
      ui.importing.done += 1;
      if (ui.importing.done % 25 === 0) render();
    }

    const collection = byStem.get('collection');
    const collectionMeta = collection?.json ? await readJson(collection.json) : null;
    if (collectionMeta && ui.draft) {
      if (!ui.draft.name && collectionMeta.name) ui.draft.name = String(collectionMeta.name).slice(0, 32);
      if (!ui.draft.symbol && collectionMeta.symbol) ui.draft.symbol = String(collectionMeta.symbol).slice(0, 10);
      if (!ui.draft.description && collectionMeta.description) ui.draft.description = String(collectionMeta.description);
    }
    if (!ui.draft.symbol && items[0]) {
      const first = files.find((f) => f.name === `${stems[0]}.json`);
      const meta = first ? await readJson(first) : null;
      if (meta?.symbol) ui.draft.symbol = String(meta.symbol).slice(0, 10);
    }
    if (draftChanged()) await saveDraft();

    await request(`${base()}/items`, { method: 'POST', body: { items } });
    ui.importing = { label: 'Copying images', done: 0, total: stems.length + (collection?.image ? 1 : 0) };
    render();
    for (const index of stems) {
      const { image } = byStem.get(String(index));
      if (image) await uploadImage(String(index), image);
      ui.importing.done += 1;
      if (ui.importing.done % 10 === 0) render();
    }
    if (collection?.image) {
      await uploadImage('cover', collection.image);
      ui.importing.done += 1;
    }
    ui.importing = null;
    ui.page = 0;
    ui.notice = `Imported ${stems.length.toLocaleString()} items.`;
    await loadDetail();
  }

  // ---------------------------------------------------------------- actions

  function draftBody() {
    const dr = ui.draft;
    return {
      name: dr.name,
      symbol: dr.symbol,
      description: dr.description,
      externalUrl: dr.externalUrl,
      royaltyBps: Number(dr.royaltyBps) || 0,
      ownerAddress: dr.ownerAddress,
      creators: dr.creators.map((c) => ({ address: c.address.trim(), percentage: Number(c.percentage) })),
      collectionVanity: dr.collectionVanity,
      itemVanity: dr.itemVanity,
    };
  }

  async function saveDraft() {
    const data = await request(`${base()}/config`, { method: 'PUT', body: { config: draftBody() } });
    ui.detail = data.collection;
    ui.draft = draftFrom(ui.detail);
    await loadList();
  }

  async function act(action, target) {
    switch (action) {
      case 'dismiss':
        ui.error = null;
        ui.notice = null;
        render();
        return;
      case 'new':
        return guard('Creating', async () => {
          const data = await request('/api/v2/nfts', { method: 'POST', body: { config: { name: '', symbol: '' } } });
          ui.selectedId = data.collection.id;
          ui.draft = null;
          ui.tab = 'collection';
          ui.estimate = null;
          await refresh();
        });
      case 'tab':
        ui.tab = target?.dataset.nftGoto || ui.tab;
        render();
        return;
      case 'import':
        ui.tab = 'items';
        render();
        root()?.querySelector('[data-nft-file="folder"]')?.click();
        return;
      case 'save':
        ui.tab = target?.dataset.nftGoto || ui.tab;
        return guard('Saving', saveDraft);
      case 'revert':
        ui.draft = draftFrom(ui.detail);
        render();
        return;
      case 'creator-add':
        ui.draft.creators.push({ address: ui.walletPublicKey || '', percentage: ui.draft.creators.length ? 0 : 100 });
        render();
        return;
      case 'creator-remove':
        ui.draft.creators.splice(Number(target.dataset.nftIndex), 1);
        render();
        return;
      case 'delete':
        ui.confirmDelete = true;
        render();
        return;
      case 'delete-cancel':
        ui.confirmDelete = false;
        render();
        return;
      case 'delete-confirm':
        return guard('Deleting', async () => {
          const typed = root()?.querySelector('[data-nft-field="confirmDelete"]')?.value || '';
          await request(base(), { method: 'DELETE', body: { confirmAddress: typed.trim() } });
          ui.confirmDelete = false;
          ui.selectedId = null;
          ui.draft = null;
          await refresh();
        });
      case 'accept':
        return guard('Accepting', async () => {
          const data = await request(`${base()}/items/accept`, { method: 'POST', body: { indexes: [Number(target.dataset.nftIndex)] } });
          ui.detail = data.collection;
        });
      case 'accept-all':
        return guard('Accepting', async () => {
          const indexes = ui.detail.review.filter((r) => r.index !== null && r.level === 'warn').map((r) => r.index);
          const data = await request(`${base()}/items/accept`, { method: 'POST', body: { indexes } });
          ui.detail = data.collection;
        });
      case 'grind':
        ui.tab = 'addresses';
        return guard('Starting grind', async () => {
          if (draftChanged()) await saveDraft();
          await request(`${base()}/grind`, { method: 'POST', body: {} });
          await loadDetail();
        });
      case 'grind-cancel':
        return guard('Cancelling', async () => {
          await request(`${base()}/grind/cancel`, { method: 'POST', body: {} });
          await loadDetail();
        });
      case 'estimate':
        ui.tab = 'fund';
        return guard('Estimating', async () => {
          if (!ui.walletPublicKey) throw new Error('Pick a signing wallet.');
          const data = await request(`${base()}/estimate`, { method: 'POST', body: { walletPublicKey: ui.walletPublicKey }, timeoutMs: 60000 });
          ui.estimate = data.estimate;
          ui.approved = false;
        });
      case 'run':
        return guard('Starting run', async () => {
          if (!ui.approved || !ui.estimate) throw new Error('Approve the spend cap first.');
          await request(`${base()}/run`, { method: 'POST', body: { walletPublicKey: ui.estimate.walletPublicKey, maxSpendSol: ui.estimate.totalSol } });
          ui.approved = false;
          ui.estimate = null;
          await loadDetail();
        });
      case 'run-cancel':
        return guard('Stopping', async () => {
          await request(`${base()}/run/cancel`, { method: 'POST', body: {} });
          await loadDetail();
        });
      case 'verify':
        ui.tab = 'verify';
        return guard('Verifying', async () => {
          const data = await request(`${base()}/verify`, { method: 'POST', body: {}, timeoutMs: 300000 });
          ui.detail = data.collection;
        });
      case 'proof':
        return guard('Preparing proof', async () => {
          const data = await request(`${base()}/proof`);
          const blob = new Blob([JSON.stringify(data.proof, null, 2)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `${(ui.detail.config.symbol || 'collection').toLowerCase()}-nft-proof.json`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        });
      default:
    }
  }

  function setDraftField(name, value) {
    if (name === 'approved') {
      ui.approved = value === true;
      return;
    }
    if (name.includes('.')) {
      const [group, key] = name.split('.');
      ui.draft[group] = { ...ui.draft[group], [key]: value };
      const target = group === 'collectionVanity' ? 'collection' : 'items';
      clearTimeout(ui.oddsTimer);
      ui.oddsTimer = setTimeout(async () => {
        await loadOdds(target);
        render();
      }, 250);
      return;
    }
    ui.draft[name] = value;
  }

  function onClick(event) {
    const tab = event.target.closest('[data-nft-tab]');
    if (tab) {
      ui.tab = tab.dataset.nftTab;
      ui.confirmDelete = false;
      ui.notice = null;
      render();
      if (ui.tab === 'fund' || ui.tab === 'mint') loadWallets().then(render);
      if (ui.tab === 'addresses' && !ui.odds.items.length) loadOdds('items').then(render);
      if (ui.tab === 'collection' && !ui.odds.collection.length) loadOdds('collection').then(render);
      return;
    }
    const mode = event.target.closest('[data-nft-vmode]');
    if (mode) {
      const [target, value] = mode.dataset.nftVmode.split(':');
      const group = `${target}Vanity`;
      ui.draft[group] = { ...ui.draft[group], mode: value, caseInsensitive: value === 'none' ? false : ui.draft[group].caseInsensitive || ui.draft[group].mode === 'none' };
      loadOdds(target === 'collection' ? 'collection' : 'items').then(render);
      render();
      return;
    }
    const filter = event.target.closest('[data-nft-filter]');
    if (filter) {
      ui.filter = filter.dataset.nftFilter;
      ui.page = 0;
      render();
      return;
    }
    const page = event.target.closest('[data-nft-page]');
    if (page) {
      ui.page = Math.max(0, ui.page + Number(page.dataset.nftPage));
      render();
      return;
    }
    const trait = event.target.closest('[data-nft-trait]');
    if (trait) {
      ui.traitType = trait.dataset.nftTrait;
      render();
      return;
    }
    const copy = event.target.closest('[data-nft-copy]');
    if (copy) {
      navigator.clipboard?.writeText(copy.dataset.nftCopy).then(() => {
        ui.notice = 'Copied.';
        render();
      });
      return;
    }
    const button = event.target.closest('button[data-nft-action]');
    if (button && !button.disabled) act(button.dataset.nftAction, button);
  }

  function onInput(event) {
    const el = event.target;
    if (el.dataset.nftField && ui.draft) {
      const value = el.type === 'checkbox' ? el.checked : el.value;
      if (el.dataset.nftField === 'confirmDelete') return;
      setDraftField(el.dataset.nftField, value);
      render();
      return;
    }
    if (el.dataset.nftCreator && ui.draft) {
      const [i, key] = el.dataset.nftCreator.split(':');
      ui.draft.creators[Number(i)][key] = el.value;
      render();
    }
  }

  function onChange(event) {
    const el = event.target;
    if (el.dataset.nftAction === 'select') {
      ui.selectedId = el.value;
      ui.draft = null;
      ui.estimate = null;
      ui.odds = { collection: [], items: [] };
      guard('Loading', loadDetail);
      return;
    }
    if (el.dataset.nftAction === 'wallet') {
      ui.walletPublicKey = el.value;
      ui.estimate = null;
      render();
      return;
    }
    if (el.dataset.nftFile === 'folder') {
      guard('Importing', () => importFolder(el.files)).finally(() => { ui.importing = null; render(); });
      return;
    }
    if (el.dataset.nftFile === 'cover' && el.files?.[0]) {
      guard('Uploading cover', async () => {
        await uploadImage('cover', el.files[0]);
        await loadDetail();
      });
      return;
    }
    if (el.dataset.nftField || el.dataset.nftCreator) render();
  }

  async function onShow() {
    const el = root();
    if (!el) return;
    if (!el.dataset.nftBound) {
      el.dataset.nftBound = '1';
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
      await refresh();
      await loadWallets();
      if (ui.detail) await Promise.all([loadOdds('collection'), loadOdds('items')]);
    } catch (error) {
      ui.error = error?.message || String(error);
    }
    ui.loaded = true;
    render();
  }

  global.TrebuchetNfts = { onShow, render };
})(globalThis);
