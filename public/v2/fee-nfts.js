(function installFeeNfts(global) {
  const ui = { data: null, wallets: [], selected: null, detail: null, busy: false, error: '', timer: null, wallet: null };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const root = () => document.getElementById('feeNftRoot');
  const api = () => global.TrebuchetV2Api.createV2ApiClient();
  const request = (url, body) => api().request(url, body ? { method: 'POST', body, timeoutMs: 90_000 } : { timeoutMs: 30_000 });
  const sol = (v) => (Number(v || 0) / 1e9).toFixed(6);
  const short = (v) => `${String(v).slice(0, 5)}…${String(v).slice(-5)}`;
  const control = (label, input) => `<label class="nft-field"><span class="nft-label">${label}</span>${input}</label>`;
  function render() {
    const el = root(); if (!el) return;
    const d = ui.detail; const data = ui.data;
    el.innerHTML = `<div class="nft-shell"><div class="nft-heading"><div><h2>Branded fee NFTs</h2><p>Each NFT holds an equal share of the fees from one locked position.</p></div><button class="secondary-button compact" data-fee-action="refresh">Refresh</button></div>
      ${ui.error ? `<div class="nft-banner nft-banner-bad" role="alert">${esc(ui.error)}</div>` : ''}
      ${!data ? '<p>Loading fee collections…</p>' : `
      <section class="surface fee-nft-form">
        ${control('Signing wallet', `<select id="feeWallet">${ui.wallets.map((w) => `<option value="${esc(w.publicKey)}" ${w.publicKey === ui.wallet ? 'selected' : ''}>${esc(w.label || 'Wallet')} · ${esc(short(w.publicKey))}</option>`).join('')}</select>`)}
        ${control('Saved fee collection', `<select id="feeSaved"><option value="">Create a fee collection</option>${data.vaults.map((v) => `<option value="${esc(v.id)}" ${v.id === ui.selected ? 'selected' : ''}>${esc(v.plan.name)} · ${esc(v.status)}</option>`).join('')}</select>`)}
        ${!d ? `${control('Branded collection', `<select id="feeCollection"><option value="">Choose a minted NFT collection</option>${data.collections.map((c) => `<option value="${esc(c.id)}" ${c.minted !== c.count || !c.count ? 'disabled' : ''}>${esc(c.name)} · ${c.minted}/${c.count} minted</option>`).join('')}</select>`)}
          <p>Create the artwork and mint one NFT per recipient in the NFTs view. Keep them in the signing wallet for setup.</p>
          ${control('Fee source', '<select id="feeVenue"><option value="meteora">Meteora DAMM v2</option><option value="raydium">Raydium CLMM Burn & Earn</option></select>')}
          ${control('Backing position NFT or Fee Key mint', '<input id="feeBacking" placeholder="Solana NFT mint address" autocomplete="off">')}
          ${control('Recipient wallets', `<textarea id="feeRecipients" rows="6" spellcheck="false">${esc(data.sample.wallets.join('\n'))}</textarea>`)}
          <p>The sample list has ${data.sample.wallets.length} wallets. Each receives one NFT.</p>
          ${data.programId ? `<button class="primary-button" data-fee-action="prepare" ${ui.busy ? 'disabled' : ''}>Review backing and estimate setup</button>` : '<p>Set up the fee vault program on your selected network. The setup steps are in docs/fee-nfts.md.</p>'}` : renderDetail(d)}
      </section>`}</div>`;
  }
  function renderDetail(d) {
    const p = d.plan; const job = d.job; const active = d.onChain?.active;
    const shares = d.onChain?.shares || p.shares;
    return `<div class="fee-nft-facts"><h3>${esc(p.name)}</h3>
      <p>${p.count} branded NFTs · each receives 1/${p.count} of this position’s LP fees.</p>
      <p>${esc(p.transferRule)}</p>
      <dl><dt>Backing NFT</dt><dd>${esc(p.source.nativeNftMint)}</dd><dt>Pool</dt><dd>${esc(p.source.pool)}</dd><dt>Vault</dt><dd>${esc(d.vault)}</dd></dl>
      ${job?.status === 'running' ? `<p role="status">${esc(job.step)}</p>` : ''}
      ${job?.error ? `<p role="alert">${esc(job.error)}</p>` : ''}
      ${!active || d.status !== 'active' ? `<p>Setup estimate: ${sol(d.estimate.totalLamports)} SOL, including account rent and fees.</p>
        ${control('Setup spend cap in SOL', `<input id="feeCap" type="number" min="0.001" step="0.001" value="${(d.estimate.totalLamports / 1e9 * 1.2).toFixed(3)}">`)}
        <label class="nft-inline"><input id="feeApprove" type="checkbox"> I approve the listed NFT shares. The vault will hold this backing NFT for the collection.</label>
        <button class="primary-button" data-fee-action="run" ${ui.busy || job?.status === 'running' ? 'disabled' : ''}>${d.status === 'draft' ? 'Back collection and send NFTs' : 'Resume setup'}</button>` : ''}
      ${active ? `<p>Fee rights are active. Collect pool fees into the vault, then claim your NFT’s share. SOL fees arrive as wrapped SOL in your wallet.</p>
        ${control('Transaction spend cap in SOL', '<input id="feeActionCap" type="number" min="0.001" step="0.001" value="0.01">')}
        <button class="secondary-button" data-fee-action="harvest" ${ui.busy ? 'disabled' : ''}>Collect pool fees</button>` : ''}
      <div class="fee-nft-table"><table><thead><tr><th>NFT</th><th>Holder</th><th>Claimable</th><th></th></tr></thead><tbody>${shares.map((s) => `<tr><td>${esc(s.name)}<br><small>${esc(short(s.asset))}</small></td><td title="${esc(s.owner || s.recipient)}">${esc(short(s.owner || s.recipient))}</td><td>${s.claimable ? s.claimable.map((raw, i) => `${esc(formatUnits(raw, p.source.decimals[i]))} ${esc(short(p.source.mints[i]))}`).join('<br>') : 'After activation'}</td><td>${active && s.owner === ui.wallet ? `<button class="secondary-button compact" data-fee-action="claim" data-index="${s.index}" ${ui.busy ? 'disabled' : ''}>Claim</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
      <button class="secondary-button compact" data-fee-action="proof">Download fee proof</button></div>`;
  }
  function formatUnits(raw, decimals) {
    const n = BigInt(raw); const scale = 10n ** BigInt(decimals);
    return `${n / scale}${decimals ? `.${(n % scale).toString().padStart(decimals, '0').replace(/0+$/, '') || '0'}` : ''}`;
  }
  async function refresh() {
    ui.data = await request('/api/v2/fee-nfts');
    ui.wallets = (await request('/api/v2/wallets')).wallets || [];
    ui.wallet ||= ui.wallets[0]?.publicKey || null;
    if (ui.selected) ui.detail = (await request(`/api/v2/fee-nfts/${ui.selected}`)).vault;
  }
  async function act(action, el) {
    if (action === 'proof') {
      const blob = new Blob([JSON.stringify(ui.detail, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${ui.detail.plan.name}-fees.json`; a.click(); URL.revokeObjectURL(url); return;
    }
    if (action === 'prepare') {
      const config = await request('/api/rpc-config');
      const payload = { collectionId: root().querySelector('#feeCollection').value, venue: root().querySelector('#feeVenue').value, nativeNftMint: root().querySelector('#feeBacking').value.trim(), recipients: root().querySelector('#feeRecipients').value, walletPublicKey: ui.wallet, network: config.activeNetwork || config.config?.activeNetwork || 'mainnet' };
      ui.detail = (await request('/api/v2/fee-nfts/prepare', payload)).vault; ui.selected = ui.detail.id;
    }
    if (action === 'run') {
      if (!root().querySelector('#feeApprove').checked) throw new Error('Approve the NFT shares and backing before setup');
      const maxSpendLamports = Math.round(Number(root().querySelector('#feeCap').value) * 1e9);
      await request(`/api/v2/fee-nfts/${ui.selected}/run`, { walletPublicKey: ui.wallet, approvedDigest: ui.detail.plan.digest, confirmNativeNftMint: ui.detail.plan.source.nativeNftMint, maxSpendLamports });
    }
    if (action === 'harvest' || action === 'claim') {
      const maxSpendLamports = Math.round(Number(root().querySelector('#feeActionCap').value) * 1e9);
      await request(`/api/v2/fee-nfts/${ui.selected}/${action}`, { walletPublicKey: ui.wallet, index: action === 'claim' ? Number(el.dataset.index) : undefined, maxSpendLamports });
    }
    await refresh();
  }
  async function onShow() {
    const el = root(); if (!el) return;
    if (!el.dataset.bound) {
      el.dataset.bound = '1';
      el.addEventListener('click', async (event) => {
        const target = event.target.closest('[data-fee-action]'); if (!target || ui.busy) return;
        ui.busy = true; ui.error = '';
        try { await act(target.dataset.feeAction, target); } catch (e) { ui.error = e.message; }
        finally { ui.busy = false; render(); }
      });
      el.addEventListener('change', async (event) => {
        if (event.target.id === 'feeWallet') { ui.wallet = event.target.value; render(); }
        if (event.target.id === 'feeSaved') {
          ui.selected = event.target.value || null; ui.detail = null;
          try { await refresh(); } catch (e) { ui.error = e.message; } render();
        }
      });
    }
    try { await refresh(); } catch (e) { ui.error = e.message; } render();
    clearInterval(ui.timer);
    ui.timer = setInterval(async () => {
      if (document.getElementById('view-fee-nfts')?.classList.contains('is-active') && ui.detail?.job?.status === 'running' && !ui.busy) {
        try { await refresh(); } catch (e) { ui.error = e.message; } render();
      }
    }, 3000);
  }
  global.TrebuchetFeeNfts = { onShow, render };
})(globalThis);
