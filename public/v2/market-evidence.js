(function installMarketEvidence(global) {
  const SOL = 'So11111111111111111111111111111111111111112';
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = (value) => value ? `${String(value).slice(0, 4)}…${String(value).slice(-4)}` : 'Awaiting check';
  const percent = (value) => Number.isFinite(value) ? `${value}%` : 'Awaiting supply';
  function units(raw, decimals) {
    const text = String(raw ?? '0').padStart(Number(decimals) + 1, '0');
    if (!Number(decimals)) return text;
    return `${text.slice(0, -decimals)}.${text.slice(-decimals)}`.replace(/\.?0+$/, '');
  }
  const link = (address, network) => address
    ? `<a href="https://solscan.io/account/${encodeURIComponent(address)}${network === 'devnet' ? '?cluster=devnet' : ''}" target="_blank" rel="noopener noreferrer" title="${escape(address)}">${escape(short(address))}</a>` : 'Awaiting owner check';
  function reserves(row) {
    if (!row?.quote) return '<p class="pool-support-intro">Quote reserves: awaiting a supported pool read.</p>';
    const quote = row.quote.mint === SOL ? 'SOL' : short(row.quote.mint);
    return `<dl class="pool-support-facts"><div><dt>Token inventory</dt><dd>${escape(units(row.token.amount, row.token.decimals))}</dd></div><div><dt>Quote reserve</dt><dd>${escape(units(row.quote.amount, row.quote.decimals))} ${escape(quote)}</dd></div></dl>`;
  }
  function render(evidence) {
    if (!evidence) return '';
    const sample = evidence.holderSample;
    return `<div class="market-evidence">
      <p class="pool-support-intro">Checked ${escape(evidence.inspectedAt)} · ${escape(evidence.network)}. Pool balances span price ranges. Sell quotes show estimated proceeds for a chosen amount.</p>
      ${sample ? `<dl class="pool-support-facts"><div><dt>Supply in pool vaults</dt><dd>${percent(sample.poolSupplyPercent)}</dd></div><div><dt>Supply in sampled wallets</dt><dd>${percent(sample.sampledWalletSupplyPercent)}</dd></div><div><dt>Supply in other accounts</dt><dd>${percent(sample.otherSupplyPercent)}</dd></div></dl><p class="pool-support-intro">Largest ${sample.accounts.length} accounts; supply covered: ${percent(sample.sampledSupplyPercent)}.</p>` : `<p class="pool-support-intro">Holder sample: ${escape(evidence.holderError || 'awaiting check')}</p>`}
      <p class="pool-support-intro">${escape(evidence.feeRights)} ${escape(evidence.flywheel)}</p>
      ${(evidence.pools || []).map((pool) => `<details class="market-evidence-pool"><summary>${pool.venue === 'meteora-damm-v2' ? 'Meteora pool' : 'Pool'} ${escape(short(pool.poolId))} · ${pool.error ? 'needs review' : pool.venue === 'meteora-damm-v2' ? (pool.locks[0] ? `${escape(pool.locks[0].lockedPercent)}% locked` : 'not locked') : `${pool.locks.length} lock records`}</summary>
        <p>${link(pool.poolId, evidence.network)}</p>
        ${pool.error ? `<p class="pool-support-error">${escape(pool.error)}</p>` : `${reserves(pool)}<p class="pool-support-intro">Lock scan: ${escape(pool.lockStatus)}${pool.lockError ? ` · ${escape(pool.lockError)}` : ''}. These records cover the positions listed below.</p>
        <ul class="market-evidence-locks">${pool.locks.map((lock) => lock.kind === 'meteora-permanent-lock' ? `<li><dl><div><dt>Permanently locked</dt><dd>${escape(lock.lockedPercent)}% of the pool's liquidity</dd></div></dl></li>` : `<li><dl><div><dt>Lock record</dt><dd>${link(lock.lockAccount, evidence.network)}</dd></div><div><dt>Position account</dt><dd>${link(lock.positionId, evidence.network)}</dd></div><div><dt>Price range ticks</dt><dd>${lock.tickLower} to ${lock.tickUpper}</dd></div><div><dt>Fee Key</dt><dd>${link(lock.feeKeyMint, evidence.network)}</dd></div><div><dt>Current fee owner</dt><dd>${link(lock.feeOwner?.address, evidence.network)}</dd></div></dl>${lock.feeOwnerError ? `<p class="pool-support-intro">${escape(lock.feeOwnerError)}</p>` : ''}</li>`).join('')}</ul>`}
      </details>`).join('')}
      <p class="pool-support-intro">Pool coverage: ${evidence.poolCoverage?.inspected ?? 0} of ${evidence.poolCoverage?.requested ?? 0} discovered addresses. Other venues and later changes need fresh checks.</p>
    </div>`;
  }
  function sellQuote(quote) {
    if (!quote) return '';
    return `<dl class="pool-support-facts"><div><dt>Estimated proceeds</dt><dd>${escape(units(quote.outputLamports, 9))} SOL</dd></div><div><dt>Minimum at 1% slippage</dt><dd>${escape(units(quote.minimumLamports, 9))} SOL</dd></div></dl><p class="pool-support-intro">${escape(quote.amount)} tokens · ${escape(quote.source)} · ${escape(quote.quotedAt)}. ${escape(quote.scope)} Request a fresh quote before trading.</p>`;
  }
  global.TrebuchetMarketEvidence = { render, reserves, sellQuote, units };
}(window));
