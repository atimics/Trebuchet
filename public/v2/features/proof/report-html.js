function reportTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || 'Unknown');
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function reportNumber(value, { maximumFractionDigits = 6, fallback = '-' } = {}) {
  const number = Number(String(value ?? '').replace(/[$,\s]/g, ''));
  if (!Number.isFinite(number)) return fallback;
  return number.toLocaleString(undefined, { maximumFractionDigits });
}

function reportPercent(value, fallback = '-') {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return `${number.toFixed(2).replace(/\.?0+$/, '')}%`;
}

function reportExplorerUrl(value, kind = 'addr') {
  const text = String(value || '').trim();
  if (!text) return null;
  if (kind === 'url' || /^https?:\/\//i.test(text) || /^ar:\/\//i.test(text)) return text;
  return kind === 'tx' ? solscanTxUrl(text) : solscanAccountUrl(text);
}

function renderV2ReportAddressRow(label, value, kind = 'addr') {
  const text = String(value || '').trim();
  if (!text) {
    return `<div class="addr-row">
      <span class="addr-label">${escapeHtml(label)}</span>
      <span class="addr-value addr-missing">-</span>
    </div>`;
  }
  const href = reportExplorerUrl(text, kind);
  return `<div class="addr-row">
    <span class="addr-label">${escapeHtml(label)}</span>
    <code class="addr-value">${escapeHtml(text)}</code>
    <button class="copy-btn" type="button" data-copy="${escapeHtml(text)}" title="Copy to clipboard">Copy</button>
    ${href ? `<a class="explorer-link" href="${escapeHtml(href)}" target="_blank" rel="noopener" title="Open proof link">↗</a>` : ''}
  </div>`;
}

function renderV2ReportFactRow(label, value) {
  return `<div class="fact-row">
    <span class="fact-label">${escapeHtml(label)}</span>
    <span class="fact-value">${escapeHtml(String(value || '-'))}</span>
  </div>`;
}

function renderV2ReportObservedSpend(observedSpend = {}) {
  const summary = observedSpend && typeof observedSpend === 'object' ? observedSpend : {};
  const outflowSol = Number(summary.outflowSol || 0);
  const inflowSol = Number(summary.inflowSol || 0);
  const measuredCount = Number(summary.measuredCount || 0);
  const errorCount = Number(summary.errorCount || 0);
  const hasMeasurements = measuredCount > 0;
  const netOutflow = Math.max(0, outflowSol - inflowSol);
  const measuredLabel = Number.isFinite(measuredCount) ? reportNumber(measuredCount, { maximumFractionDigits: 0 }) : '0';
  const errorLabel = Number.isFinite(errorCount) ? reportNumber(errorCount, { maximumFractionDigits: 0 }) : '0';
  const sourceLabel = summary.source === 'execution-ledger' ? 'Guarded execution ledger' : String(summary.source || 'Execution ledger');
  const measurementNote = hasMeasurements
    ? `Derived from ${measuredLabel} guarded wallet balance observation${measuredCount === 1 ? '' : 's'}.`
    : 'No guarded wallet balance observations have been recorded in this local session yet.';
  const gapNote = errorCount > 0
    ? `${errorLabel} operation${errorCount === 1 ? '' : 's'} could not record a wallet balance delta.`
    : 'No observation gaps recorded.';

  return `<h3 class="subsection">Observed launch spend</h3>
    <div class="pool-facts observed-spend-facts">
      ${renderV2ReportFactRow('Observed SOL outflow', hasMeasurements ? `${reportNumber(outflowSol, { maximumFractionDigits: 6 })} SOL` : '-')}
      ${renderV2ReportFactRow('Observed SOL inflow', hasMeasurements ? `${reportNumber(inflowSol, { maximumFractionDigits: 6 })} SOL` : '-')}
      ${renderV2ReportFactRow('Net observed spend', hasMeasurements ? `${reportNumber(netOutflow, { maximumFractionDigits: 6 })} SOL` : '-')}
      ${renderV2ReportFactRow('Measured operations', measuredLabel)}
      ${renderV2ReportFactRow('Observation gaps', errorLabel)}
      ${renderV2ReportFactRow('Source', sourceLabel)}
    </div>
    <p class="observed-spend-note">${escapeHtml(`${measurementNote} ${gapNote}`)}</p>`;
}

function v2ReportSweepTxCell(txId, fallback = '-') {
  if (!txId) return escapeHtml(fallback);
  return `<a href="${escapeHtml(solscanTxUrl(txId))}" target="_blank" rel="noopener">${escapeHtml(shortAddress(txId))}</a>`;
}

function v2ReportSweepAssetCell(value) {
  const text = String(value || '').trim();
  if (!text) return '-';
  if (text.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(text)) {
    return `<a href="${escapeHtml(solscanAccountUrl(text))}" target="_blank" rel="noopener">${escapeHtml(fullAddress(text))}</a>`;
  }
  return escapeHtml(text);
}

function v2ReportSweepAmount(value, suffix = '') {
  if (value == null || value === '') return '-';
  const number = Number(value);
  const label = Number.isFinite(number) ? reportNumber(number, { maximumFractionDigits: 9 }) : String(value);
  return `${escapeHtml(label)}${suffix ? ` ${escapeHtml(suffix)}` : ''}`;
}

function buildV2ReportSweepTransferRows(transfer = {}) {
  const rows = [];
  const tokenTransfers = Array.isArray(transfer?.tokenSweep?.transferred) ? transfer.tokenSweep.transferred : [];
  const nftTransfers = Array.isArray(transfer?.nftSweep?.transferred) ? transfer.nftSweep.transferred : [];
  const tokenErrors = Array.isArray(transfer?.tokenTransferErrors)
    ? transfer.tokenTransferErrors
    : Array.isArray(transfer?.tokenSweep?.errors) ? transfer.tokenSweep.errors : [];
  const nftErrors = Array.isArray(transfer?.nftTransferErrors)
    ? transfer.nftTransferErrors
    : Array.isArray(transfer?.nftSweep?.errors) ? transfer.nftSweep.errors : [];
  const solAmount = transfer?.solSweep?.solTransferred ?? transfer?.solTransferred;
  const solTx = transfer?.solSweep?.txId || transfer?.solTxId || transfer?.txId || transfer?.signature || null;

  if (Number(solAmount || 0) > 0 || solTx) {
    rows.push({
      type: 'SOL',
      asset: 'Native SOL',
      amount: v2ReportSweepAmount(solAmount, 'SOL'),
      tx: solTx,
      status: solTx ? 'transferred' : 'amount recorded',
    });
  }

  tokenTransfers.forEach((row) => {
    rows.push({
      type: 'Token',
      asset: row.mint || row.tokenMint || '-',
      amount: v2ReportSweepAmount(row.amount ?? row.amountUi ?? row.tokens ?? row.amountRaw),
      tx: row.txId || row.signature || null,
      status: 'transferred',
    });
  });

  nftTransfers.forEach((row) => {
    rows.push({
      type: 'NFT',
      asset: row.mint || row.nftMint || '-',
      amount: row.programName || '1',
      tx: row.txId || row.signature || null,
      status: 'transferred',
    });
  });

  if (transfer?.solSweepError) {
    rows.push({
      type: 'SOL',
      asset: 'Native SOL',
      amount: '-',
      tx: null,
      status: transfer.solSweepError,
      error: true,
    });
  }

  tokenErrors.forEach((row) => {
    rows.push({
      type: 'Token',
      asset: row.mint || row.tokenMint || '-',
      amount: '-',
      tx: row.txId || row.signature || null,
      status: row.error || row.reason || 'transfer failed',
      error: true,
    });
  });

  nftErrors.forEach((row) => {
    rows.push({
      type: 'NFT',
      asset: row.mint || row.nftMint || '-',
      amount: '-',
      tx: row.txId || row.signature || null,
      status: row.error || row.reason || 'transfer failed',
      error: true,
    });
  });

  if (!rows.length) {
    return '<tr><td colspan="4">No final sweep transfer signatures recorded yet.</td></tr>';
  }

  return rows.map((row) => `<tr class="${row.error ? 'report-error-row' : ''}">
    <td>${escapeHtml(row.type)}</td>
    <td>${v2ReportSweepAssetCell(row.asset)}</td>
    <td>${escapeHtml(row.amount == null || row.amount === '' ? '-' : String(row.amount))}</td>
    <td>${row.tx ? `${v2ReportSweepTxCell(row.tx)}${row.error && row.status ? `<br><span class="sweep-error-reason">${escapeHtml(row.status)}</span>` : ''}` : escapeHtml(row.status || '-')}</td>
  </tr>`).join('');
}

function v2ReportPositionList(pool = {}) {
  return [
    ...(Array.isArray(pool.mainPositions) ? pool.mainPositions : []),
    ...(Array.isArray(pool.ladderPositions) ? pool.ladderPositions : []),
    ...(Array.isArray(pool.supportPositions) ? pool.supportPositions : []),
    ...(pool.bootstrap ? [pool.bootstrap] : []),
  ];
}

function v2ReportLockSummary(results = []) {
  let total = 0;
  let locked = 0;
  let transferred = 0;
  let totalRecipient = 0;
  results.forEach((pool) => {
    const positions = v2ReportPositionList(pool);
    total += positions.length;
    locked += positions.filter((position) => position?.locked === true).length;
    (Array.isArray(pool?.mainPositions) ? pool.mainPositions : []).forEach((position) => {
      if (position?.recipient) {
        totalRecipient += 1;
        if (position.transferredTo || position.txIds?.transfer || position.transferTx) transferred += 1;
      }
    });
  });
  return {
    total,
    locked,
    transferred,
    totalRecipient,
    allLocked: total > 0 && locked === total,
  };
}

function renderV2ReportStatusBanner(results = []) {
  const summary = v2ReportLockSummary(results);
  if (!results.length) {
    return `<div class="banner banner-warn">
      <strong>No pool results captured.</strong>
      This may indicate the launch did not reach the create-pool phase.
    </div>`;
  }
  if (summary.allLocked) {
    const transferIssue = summary.totalRecipient > 0 && summary.transferred < summary.totalRecipient;
    return `<div class="banner banner-${transferIssue ? 'warn' : 'ok'}">
      <strong>All ${summary.total} positions locked.</strong>
      The liquidity is permanently committed via Burn &amp; Earn. Fees accrue to the Fee Key NFT holders.
      ${transferIssue ? `<br><strong>${summary.transferred} / ${summary.totalRecipient} Fee Key NFTs reached their external recipients</strong> — the remaining ones should be forwarded manually from the destination wallet.` : ''}
    </div>`;
  }
  return `<div class="banner banner-warn">
    <strong>${summary.locked} / ${summary.total} positions locked.</strong>
    Any unlocked position is still controlled by the launch wallet or the final return wallet. Re-lock it through Raydium Burn &amp; Earn before treating the launch as complete.
    ${summary.totalRecipient > 0 && summary.transferred < summary.totalRecipient ? `<br><strong>${summary.transferred} / ${summary.totalRecipient} Fee Key NFTs reached their external recipients.</strong>` : ''}
  </div>`;
}

function renderV2ReportDemoBanner(proof, results = []) {
  const tokenMint = String(proof?.token?.mint || '');
  const demo = proof?.demo === true
    || tokenMint.startsWith('Demo')
    || results.some((pool) => String(pool?.poolId || '').startsWith('Demo'));
  return demo
    ? `<div class="banner banner-demo">
        <strong>DEMO LAUNCH REPORT</strong>
        Synthetic addresses, no real transactions. This report was generated in test mode.
      </div>`
    : '';
}

function v2ClassicReportCss() {
  return `
    /* ============================================================
       Theme - matches makesometokens.com
       Parchment background, ink typography, engineering-manuscript
       flourishes. Trebuchet MS body font is deliberately on-brand.
       ============================================================ */
    :root {
      --parchment: #efe5cd;
      --parchment-deep: #e6dab9;
      --parchment-edge: #d6c8a3;
      --ink: #1a1a1a;
      --ink-soft: #3d3a32;
      --ink-muted: #6b6657;
      --rule: #1a1a1a;
      --rule-soft: #b8ad8a;
      --accent: #8a3a1a;
      --ok: #2d5016;
      --ok-bg: #d9e6c8;
      --ok-edge: #8aa466;
      --warn: #7a3a0a;
      --warn-bg: #eed9b0;
      --warn-edge: #c89860;
      --mono: "Courier New", Courier, ui-monospace, monospace;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: "Trebuchet MS", "Lucida Sans Unicode", "Lucida Grande", Tahoma, sans-serif;
      background: var(--parchment);
      color: var(--ink);
      line-height: 1.55;
      font-size: 14.5px;
      background-image:
        radial-gradient(ellipse at center, transparent 0%, transparent 70%, rgba(110, 90, 50, 0.08) 100%),
        repeating-linear-gradient(0deg, transparent 0 28px, rgba(110, 90, 50, 0.012) 28px 29px);
      background-attachment: fixed;
    }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 36px 32px 80px; }
    a { color: var(--accent); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
    a:hover { text-decoration-thickness: 2px; }
    code { font-family: var(--mono); font-size: 0.92em; }
    .masthead {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding-bottom: 12px;
      margin-bottom: 8px;
      border-bottom: 2px solid var(--rule);
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--ink-soft);
    }
    .masthead-left { display: flex; align-items: center; gap: 18px; }
    .masthead-brand { font-weight: 700; letter-spacing: 0.35em; color: var(--ink); }
    .masthead-right { text-align: right; }
    .title-block {
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: 32px;
      align-items: center;
      margin: 32px 0 24px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--rule-soft);
    }
    .hero-logo {
      width: 120px;
      height: 120px;
      object-fit: contain;
      border-radius: 50%;
      background: var(--parchment-deep);
      border: 2px solid var(--rule);
      box-shadow: 0 2px 0 var(--rule-soft);
    }
    .hero-logo-placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--mono);
      font-size: 34px;
      font-weight: 700;
      color: var(--ink-soft);
      letter-spacing: 0.1em;
    }
    .doc-fig {
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--ink-muted);
      margin: 0 0 8px;
    }
    .doc-title {
      margin: 0;
      font-size: 44px;
      font-weight: 700;
      line-height: 1.05;
      letter-spacing: 0;
    }
    .doc-title .doc-symbol {
      color: var(--ink-muted);
      font-weight: 500;
      font-size: 0.6em;
      letter-spacing: 0.02em;
      margin-left: 0.4em;
    }
    .doc-subtitle {
      margin: 10px 0 0;
      color: var(--ink-soft);
      font-size: 15px;
      font-style: italic;
      max-width: 60ch;
    }
    .enum-badge {
      display: inline-block;
      font-family: var(--mono);
      font-size: 10.5px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--ink-muted);
      padding: 3px 10px;
      border: 1px solid var(--rule-soft);
      background: var(--parchment-deep);
      margin-bottom: 12px;
    }
    .section-rule {
      margin: 36px 0 24px;
      border: 0;
      border-top: 2px solid var(--rule);
      position: relative;
    }
    .section-rule::after {
      content: "";
      position: absolute;
      top: 4px;
      left: 0;
      right: 0;
      border-top: 1px solid var(--rule);
    }
    h2.section-title { margin: 0 0 18px; font-size: 22px; font-weight: 700; letter-spacing: 0; }
    h3.subsection {
      margin: 18px 0 8px;
      font-family: var(--mono);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      color: var(--ink-muted);
      font-weight: 600;
    }
    .banner {
      padding: 12px 16px;
      margin: 20px 0 28px;
      font-size: 13.5px;
      border: 1px solid;
      background: var(--parchment-deep);
      position: relative;
    }
    .banner::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; }
    .banner strong { display: inline-block; margin-right: 6px; }
    .banner-ok { border-color: var(--ok-edge); color: var(--ok); background: var(--ok-bg); }
    .banner-ok::before { background: var(--ok); }
    .banner-warn { border-color: var(--warn-edge); color: var(--warn); background: var(--warn-bg); }
    .banner-warn::before { background: var(--warn); }
    .banner-demo { border-color: #f0c040; color: #6b4b00; background: #fef3c7; }
    .banner-demo::before { background: #f0c040; }
    .token-summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 0;
      border: 1px solid var(--rule);
      background: var(--parchment-deep);
    }
    .token-stat { padding: 14px 18px; border-right: 1px solid var(--rule-soft); min-width: 0; }
    .token-stat:last-child { border-right: none; }
    .token-stat-label {
      font-family: var(--mono);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      color: var(--ink-muted);
      margin-bottom: 6px;
    }
    .token-stat-value { font-size: 18px; font-weight: 700; letter-spacing: 0; overflow-wrap: anywhere; }
    .tokenomics { display: grid; grid-template-columns: 320px 1fr; gap: 36px; align-items: start; margin-top: 16px; }
    .tokenomics svg { display: block; margin: 0 auto; }
    .donut-svg-wrap { width: 300px; aspect-ratio: 1; display: grid; place-items: center; margin: 0 auto; }
    .donut-svg-wrap .tokenomics-svg { display: block; width: 100%; height: auto; }
    .chart-caption {
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      text-align: center;
      color: var(--ink-muted);
      margin-top: 4px;
    }
    .breakdown-list, .breakdown-pool { display: grid; gap: 6px; }
    .breakdown-row, .breakdown-arc {
      display: grid;
      grid-template-columns: 14px 1fr auto auto;
      gap: 10px;
      align-items: center;
      font-size: 13px;
      padding: 3px 0;
    }
    .breakdown-swatch {
      width: 12px;
      height: 12px;
      border-radius: 2px;
      border: 1px solid rgba(0,0,0,0.15);
    }
    .breakdown-row strong, .breakdown-row em, .breakdown-arc-share {
      color: var(--ink-soft);
      font-variant-numeric: tabular-nums;
      font-family: var(--mono);
      font-size: 12px;
      font-style: normal;
      text-align: right;
    }
    .pool-section {
      margin: 28px 0;
      padding-top: 6px;
      border-top: 2px solid var(--rule);
    }
    .pool-section-header, .pool-section-head { margin-bottom: 18px; }
    .pool-title {
      margin: 0 0 4px;
      font-size: 24px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .pool-swatch {
      display: inline-block;
      width: 16px;
      height: 16px;
      border-radius: 2px;
      border: 1px solid var(--rule);
    }
    .pool-meta {
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--ink-muted);
    }
    .pool-addresses, .pool-facts {
      margin-bottom: 20px;
      padding: 14px 16px;
      background: var(--parchment-deep);
      border: 1px solid var(--rule-soft);
    }
    .pool-facts, .fact-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; }
    .slice-strip { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
    .slice-strip span { border: 1px solid var(--rule-soft); padding: 6px 8px; font-family: var(--mono); font-size: 12px; }
    .slice-strip em { color: var(--ink-muted); font-style: normal; }
    .pool-depth-chart {
      margin: 12px 0 18px;
      padding: 12px;
      border: 1px solid var(--rule-soft);
      background: var(--parchment-deep);
    }
    .pool-depth-chart svg { display: block; width: 100%; height: auto; }
    .depth-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      margin-top: 8px;
      font-family: var(--mono);
      font-size: 11px;
      color: var(--ink-soft);
    }
    .depth-legend span { display: inline-flex; align-items: center; gap: 6px; }
    .depth-legend i { width: 10px; height: 10px; border: 1px solid rgba(0,0,0,0.16); }
    .depth-caption { margin: 8px 0 0; color: var(--ink-muted); font-size: 11.5px; line-height: 1.45; }
    .positions-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(440px, 1fr));
      gap: 14px;
    }
    .position-card {
      background: var(--parchment-deep);
      border: 1px solid var(--rule-soft);
      padding: 14px 16px;
      position: relative;
      min-width: 0;
    }
    .position-card::before {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      width: 8px;
      height: 8px;
      border-top: 2px solid var(--rule);
      border-left: 2px solid var(--rule);
    }
    .position-card::after {
      content: "";
      position: absolute;
      bottom: 0;
      right: 0;
      width: 8px;
      height: 8px;
      border-bottom: 2px solid var(--rule);
      border-right: 2px solid var(--rule);
    }
    .position-header, .position-card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px dashed var(--rule-soft);
    }
    .position-kind { font-weight: 700; font-size: 13.5px; letter-spacing: 0; }
    .addr-row {
      display: grid;
      grid-template-columns: 140px minmax(0, 1fr) auto auto;
      gap: 8px;
      align-items: center;
      padding: 5px 0;
      font-size: 12.5px;
    }
    .addr-label, .fact-label {
      font-family: var(--mono);
      color: var(--ink-muted);
      font-size: 10.5px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .addr-value {
      font-family: var(--mono);
      font-size: 11.5px;
      background: var(--parchment);
      padding: 4px 8px;
      border: 1px solid var(--rule-soft);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .addr-missing { background: transparent; border: none; color: var(--ink-muted); font-style: italic; padding-left: 0; }
    .copy-btn {
      font: inherit;
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      padding: 4px 10px;
      background: var(--parchment);
      border: 1px solid var(--rule);
      cursor: pointer;
      color: var(--ink);
      transition: all 120ms ease;
    }
    .copy-btn:hover { background: var(--ink); color: var(--parchment); }
    .copy-btn.copied { background: var(--ok); border-color: var(--ok); color: var(--parchment); }
    .explorer-link {
      color: var(--ink-soft);
      font-size: 14px;
      text-decoration: none;
      padding: 2px 6px;
      border: 1px solid var(--rule-soft);
      background: var(--parchment);
      font-family: var(--mono);
    }
    .explorer-link:hover { background: var(--ink); color: var(--parchment); border-color: var(--ink); text-decoration: none; }
    .fact-row {
      display: grid;
      grid-template-columns: 140px minmax(0, 1fr);
      gap: 8px;
      padding: 4px 0;
      font-size: 12.5px;
    }
    .fact-value { color: var(--ink); min-width: 0; overflow-wrap: anywhere; }
    .badge {
      display: inline-block;
      padding: 3px 10px;
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      font-weight: 700;
      border: 1px solid;
    }
    .badge-locked { background: var(--ok-bg); color: var(--ok); border-color: var(--ok-edge); }
    .badge-unlocked, .badge-open, .badge-warn { background: var(--warn-bg); color: var(--warn); border-color: var(--warn-edge); }
    .report-table { width: 100%; border-collapse: collapse; margin: 10px 0 18px; font-size: 12px; }
    .report-table th, .report-table td { border-bottom: 1px solid var(--rule-soft); padding: 8px; text-align: left; vertical-align: top; }
    .report-overflow-row { color: var(--ink-muted); font-style: italic; background: var(--parchment-deep); }
    .report-error-row { color: var(--warn); background: var(--warn-bg); }
    .sweep-error-reason { display: inline-block; margin-top: 3px; color: var(--warn); }
    .observed-spend-facts { margin-bottom: 8px; }
    .observed-spend-note { margin: 0 0 22px; color: var(--ink-muted); font-size: 12.5px; line-height: 1.45; }
    .held-reserve-audit { margin-top: 18px; }
    .audit-note { margin: -8px 0 22px; color: var(--ink-muted); font-size: 12.5px; line-height: 1.45; }
    .muted, .audit-copy p { color: var(--ink-muted); }
    .doc-footer {
      margin-top: 48px;
      padding-top: 24px;
      border-top: 2px solid var(--rule);
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.08em;
      color: var(--ink-muted);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
    }
    .doc-footer a {
      color: var(--ink);
      text-decoration: none;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .doc-footer a:hover { color: var(--accent); }
    .toast {
      position: fixed;
      bottom: 32px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: var(--ink);
      color: var(--parchment);
      padding: 10px 22px;
      font-family: var(--mono);
      font-size: 12px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      border: 2px solid var(--ink);
      opacity: 0;
      pointer-events: none;
      transition: opacity 180ms ease, transform 180ms ease;
      z-index: 1000;
    }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    @media (max-width: 720px) {
      .wrap { padding: 24px 14px 56px; }
      .masthead, .masthead-left, .doc-footer, .position-header, .position-card-head { flex-direction: column; align-items: flex-start; }
      .title-block, .tokenomics, .pool-facts, .fact-grid { grid-template-columns: 1fr; }
      .positions-grid { grid-template-columns: 1fr; }
      .addr-row, .fact-row { grid-template-columns: 1fr; align-items: start; }
      .addr-value { white-space: normal; overflow-wrap: anywhere; }
      .breakdown-row, .breakdown-arc { grid-template-columns: 14px minmax(0, 1fr) auto; }
      .breakdown-row em { grid-column: 2 / -1; text-align: left; color: var(--ink-muted); }
    }
    @media print {
      body { background: white; background-image: none; font-size: 11px; }
      .wrap { padding: 0; max-width: none; }
      .copy-btn { display: none; }
      .positions-grid { grid-template-columns: 1fr; }
      a { color: inherit; text-decoration: none; }
      .pool-section, .position-card, .doc-footer { page-break-inside: avoid; }
    }
  `;
}

function v2ClassicReportScript() {
  return `
    document.body.addEventListener('click', function (event) {
      var button = event.target.closest('.copy-btn');
      if (!button) return;
      var value = button.dataset.copy || '';
      if (!value) return;
      var showCopied = function () {
        var original = button.textContent;
        button.classList.add('copied');
        button.textContent = 'Copied';
        var toast = document.getElementById('toast');
        if (toast) toast.classList.add('show');
        setTimeout(function () {
          button.classList.remove('copied');
          button.textContent = original;
          if (toast) toast.classList.remove('show');
        }, 1400);
      };
      var legacyCopy = function () {
        var input = document.createElement('textarea');
        input.value = value;
        input.setAttribute('readonly', '');
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        try { document.execCommand('copy'); } catch (error) {}
        input.remove();
        showCopied();
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(value).then(showCopied).catch(legacyCopy);
      } else {
        legacyCopy();
      }
    });
  `;
}

function v2ReportPoolConfig(config, result, index) {
  const pools = Array.isArray(config?.poolTopology?.pools) ? config.poolTopology.pools : [];
  const allocationIndex = Number(result?.allocationIndex);
  if (Number.isFinite(allocationIndex) && pools[allocationIndex]) return pools[allocationIndex];
  return pools[index] || pools.find((pool) => (
    String(pool.quoteSymbol || pool.quoteToken || '').toUpperCase()
      === String(result?.quoteSymbol || result?.quoteToken || '').toUpperCase()
  )) || null;
}

function v2ReportPoolFeeTierLabel(pool = {}, userPool = {}) {
  const index = Math.floor(Number(pool.ammConfigIndex ?? userPool.ammConfigIndex));
  const tickSpacing = numberOrNull(pool.tickSpacing ?? userPool.tickSpacing);
  const tier = normalizeClmmFeeTiers(state.clmmFeeTiers).find((item) => item.index === index);
  if (tier) {
    const feePercent = Number(tier.tradeFeeRate || 0) / 10000;
    const dynamic = tier.feeModel === 'dynamic' ? ' · dynamic (base)' : '';
    return `${feePercent.toFixed(2)}% / spacing ${tickSpacing ?? tier.tickSpacing}${dynamic}`;
  }
  if (Number.isFinite(tickSpacing) && Number.isFinite(index)) return `index ${index} / spacing ${tickSpacing}`;
  if (Number.isFinite(tickSpacing)) return `spacing ${tickSpacing}`;
  if (Number.isFinite(index)) return `index ${index}`;
  return 'not recorded';
}

function v2ReportMultiplierLabel(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '0x';
  if (number >= 1000) {
    const compact = number >= 1000000 ? `${(number / 1000000).toFixed(1).replace(/\.0$/, '')}M` : `${Math.round(number / 1000)}k`;
    return `${compact}x`;
  }
  const text = number < 10 ? number.toFixed(2).replace(/\.?0+$/, '') : String(Math.round(number));
  return `${text}x`;
}

function v2ReportSimpleLadderBands(ladder = {}) {
  const count = Math.floor(Number(ladder.bandCount || 0));
  const ceiling = Number(ladder.ceilingMultiplier || CLASSIC_LADDER_DEFAULT_CEILING_MULTIPLIER);
  if (count <= 0 || !Number.isFinite(ceiling) || ceiling <= 1) return [];
  const supplyPercent = Number.isFinite(Number(ladder.supplyPercent)) ? Number(ladder.supplyPercent) : CLASSIC_LADDER_DEFAULT_SUPPLY_PERCENT;
  const perBand = supplyPercent / count;
  return Array.from({ length: count }, (_, index) => {
    const lowerMultiplier = Math.pow(ceiling, index / count);
    const upperMultiplier = Math.pow(ceiling, (index + 1) / count);
    return {
      supplyPercent: perBand,
      lowerMultiplier: Number(lowerMultiplier.toFixed(4)),
      upperMultiplier: Number(upperMultiplier.toFixed(4)),
    };
  });
}

function v2ReportLadderBands(pool = {}, userPool = {}) {
  const ladder = userPool.ladder || {};
  if (ladder.mode === 'manual' && Array.isArray(ladder.bands)) {
    return ladder.bands.map((band) => ({
      supplyPercent: Number(band.supplyPercent || 0),
      lowerMultiplier: Number(band.lowerMultiplier || 1),
      upperMultiplier: Number(band.upperMultiplier || 1),
    })).filter((band) => band.supplyPercent > 0 && band.lowerMultiplier >= 1 && band.upperMultiplier > band.lowerMultiplier);
  }
  if (ladder.mode === 'simple') return v2ReportSimpleLadderBands(ladder);
  return (Array.isArray(pool.ladderPositions) ? pool.ladderPositions : [])
    .map((position) => ({
      supplyPercent: Number(position.supplyPercent || 0),
      lowerMultiplier: Number(position.lowerMultiplier || 1),
      upperMultiplier: Number(position.upperMultiplier || 1),
    }))
    .filter((band) => band.supplyPercent > 0 && band.lowerMultiplier >= 1 && band.upperMultiplier > band.lowerMultiplier);
}

function renderV2ReportDepthChart(pool = {}, userPool = {}) {
  const ladderBands = v2ReportLadderBands(pool, userPool);
  const support = userPool.support || {};
  const supportDepth = support.mode === 'custom' ? Number(support.depthPct || 0) : 0;
  const supportSol = support.mode === 'custom' ? Number(support.solValue || 0) : 0;
  if (!ladderBands.length && !(supportSol > 0 && supportDepth > 0)) return '';

  const bootstrapPercent = userPool.bootstrap?.mode === 'custom' ? Number(userPool.bootstrap.supplyPercent || 0) : 0;
  const ladderTotal = ladderBands.reduce((sum, band) => sum + Number(band.supplyPercent || 0), 0);
  const widePercent = Math.max(0, 100 - bootstrapPercent - ladderTotal);
  const ladderTop = ladderBands.length ? Math.max(...ladderBands.map((band) => Number(band.upperMultiplier || 1))) : 10;
  const maxX = Math.max(10, ladderTop);
  const supportLow = supportSol > 0 && supportDepth > 0 ? Math.max(0.05, 1 - supportDepth / 100) : 1;
  const minX = supportLow < 1 ? supportLow : 1;
  const logMin = Math.log(minX);
  const logSpan = Math.max(0.0001, Math.log(maxX) - logMin);
  const xFor = (value) => 34 + ((Math.log(Math.max(minX, Number(value) || minX)) - logMin) / logSpan) * 572;
  const weights = [
    widePercent,
    ...ladderBands.map((band) => Number(band.supplyPercent || 0) * 1.4),
    supportSol > 0 ? supportSol * 45 : 0,
  ].filter((value) => value > 0);
  const maxWeight = Math.max(1, ...weights);
  const heightFor = (weight) => Math.max(12, Math.min(92, (Number(weight || 0) / maxWeight) * 92));
  const baseY = 120;
  const colors = ['#9a2424', '#2f6f5e', '#c0871f', '#3f5a8a', '#8a3f6a', '#5f6a2a', '#7a4a2a'];
  const rect = ({ lo, hi, height, color, opacity = 0.9 }) => {
    const x = xFor(lo);
    const width = Math.max(2, xFor(hi) - x);
    return `<rect x="${x.toFixed(1)}" y="${(baseY - height).toFixed(1)}" width="${width.toFixed(1)}" height="${height.toFixed(1)}" fill="${color}" fill-opacity="${opacity}"></rect>`;
  };
  const supportRect = supportSol > 0 && supportDepth > 0
    ? rect({ lo: supportLow, hi: 1, height: heightFor(supportSol * 45), color: '#4f8a5a', opacity: 0.86 })
    : '';
  const wideRect = widePercent > 0
    ? rect({ lo: 1, hi: maxX, height: heightFor(widePercent), color: '#d8c39a', opacity: 0.78 })
    : '';
  const ladderRects = ladderBands.map((band, index) => rect({
    lo: band.lowerMultiplier,
    hi: band.upperMultiplier,
    height: heightFor(Number(band.supplyPercent || 0) * 1.4),
    color: colors[index % colors.length],
    opacity: 0.92,
  })).join('');
  const launchX = xFor(1);
  const legend = [
    widePercent > 0 ? `<span><i style="background:#d8c39a"></i><strong>Wide / main</strong>${reportPercent(widePercent)} pool share</span>` : '',
    supportSol > 0 && supportDepth > 0 ? `<span><i style="background:#4f8a5a"></i><strong>Support wall</strong>${reportNumber(supportSol, { maximumFractionDigits: 3 })} SOL to -${reportNumber(supportDepth, { maximumFractionDigits: 0 })}%</span>` : '',
    ...ladderBands.map((band, index) => `<span><i style="background:${colors[index % colors.length]}"></i><strong>Ladder ${index + 1}</strong>${reportPercent(band.supplyPercent)} · ${v2ReportMultiplierLabel(band.lowerMultiplier)}-${v2ReportMultiplierLabel(band.upperMultiplier)}</span>`),
  ].filter(Boolean).join('');

  return `<div class="pool-depth-chart">
    <svg viewBox="0 0 640 158" width="100%" role="img" aria-label="Liquidity depth chart for ${escapeHtml(pool.quoteSymbol || userPool.quoteSymbol || userPool.quoteToken || 'pool')} pool">
      <rect x="18" y="14" width="604" height="126" rx="0" fill="#f4ecd8" stroke="#c8bd9a"></rect>
      <line x1="34" y1="${baseY}" x2="606" y2="${baseY}" stroke="#3a2d1e" stroke-opacity="0.35"></line>
      ${supportRect}
      ${wideRect}
      ${ladderRects}
      <line x1="${launchX.toFixed(1)}" y1="24" x2="${launchX.toFixed(1)}" y2="128" stroke="#1c1610" stroke-dasharray="4 4" stroke-opacity="0.5"></line>
      <text x="${launchX.toFixed(1)}" y="144" text-anchor="middle" fill="#6f6658" font-family="JetBrains Mono, monospace" font-size="10">1x launch</text>
      <text x="34" y="144" text-anchor="start" fill="#6f6658" font-family="JetBrains Mono, monospace" font-size="10">${escapeHtml(v2ReportMultiplierLabel(minX))}</text>
      <text x="606" y="144" text-anchor="end" fill="#6f6658" font-family="JetBrains Mono, monospace" font-size="10">${escapeHtml(v2ReportMultiplierLabel(maxX))}</text>
    </svg>
    <div class="depth-legend">${legend}</div>
    <p class="depth-caption">Liquidity depth sketch: taller bands slow price movement through that range. It is derived from the launch topology, not from live market data.</p>
  </div>`;
}

function v2ReportPositionRows(pool = {}) {
  const rows = [];
  (Array.isArray(pool.mainPositions) ? pool.mainPositions : []).forEach((position, index) => {
    rows.push({ title: `Main slice ${Number(position.sliceIndex ?? index) + 1}`, kind: 'main', position });
  });
  if (pool.bootstrap) rows.push({ title: 'Bootstrap quote-side', kind: 'bootstrap', position: pool.bootstrap });
  (Array.isArray(pool.ladderPositions) ? pool.ladderPositions : []).forEach((position, index) => {
    rows.push({ title: `Ladder band ${Number(position.bandIndex ?? index) + 1}`, kind: 'ladder', position });
  });
  (Array.isArray(pool.supportPositions) ? pool.supportPositions : []).forEach((position, index) => {
    rows.push({ title: `Support band ${index + 1}`, kind: 'support', position });
  });
  return rows;
}

function v2ReportPositionRange(position = {}) {
  const lower = Number(position.tickLower);
  const upper = Number(position.tickUpper);
  if (Number.isFinite(lower) && Number.isFinite(upper)) return `${lower} to ${upper}`;
  const lowerMultiplier = Number(position.lowerMultiplier);
  const upperMultiplier = Number(position.upperMultiplier);
  if (Number.isFinite(lowerMultiplier) && Number.isFinite(upperMultiplier)) {
    return `${lowerMultiplier}x to ${upperMultiplier}x`;
  }
  return 'not recorded';
}

function renderV2ReportPositionCard(entry) {
  const position = entry.position || {};
  const status = position.locked ? 'Locked' : position.txIds?.open || position.openTx ? 'Opened' : 'Planned';
  const badgeClass = position.locked ? 'badge-locked' : status === 'Opened' ? 'badge-open' : 'badge-warn';
  const positionMint = position.positionNftMint || position.nftMint || position.positionMint || null;
  const feeKeyMint = position.feeKeyNftMint || position.feeKeyMint || null;
  const configuredRecipient = position.recipient || null;
  const deliveredRecipient = position.transferredTo || null;
  const recipient = deliveredRecipient || configuredRecipient || null;
  const transferTx = position.txIds?.transfer || position.transferTx;
  const share = Number.isFinite(Number(position.sharePercent)) ? reportPercent(position.sharePercent) : null;
  const depth = Number.isFinite(Number(position.depthPct)) ? `${reportPercent(position.depthPct)} depth` : null;
  return `<article class="position-card ${escapeHtml(entry.kind)}">
    <div class="position-header">
      <span class="position-kind">${escapeHtml(entry.title)}</span>
      <span class="badge ${badgeClass}">${escapeHtml(status)}</span>
    </div>
    <div class="fact-grid">
      ${renderV2ReportFactRow('Range', v2ReportPositionRange(position))}
      ${share ? renderV2ReportFactRow('Supply share', share) : ''}
      ${depth ? renderV2ReportFactRow('Support', depth) : ''}
      ${recipient ? renderV2ReportFactRow(position.transferredTo ? 'Fee Key sent to' : 'Fee Key recipient', fullAddress(recipient)) : ''}
    </div>
    ${renderV2ReportAddressRow('Position NFT', positionMint)}
    ${renderV2ReportAddressRow('Fee Key NFT', feeKeyMint)}
    ${configuredRecipient ? renderV2ReportAddressRow('Fee Key recipient', configuredRecipient) : ''}
    ${configuredRecipient || deliveredRecipient || transferTx ? renderV2ReportAddressRow('Fee Key delivered to', deliveredRecipient) : ''}
    ${renderV2ReportAddressRow('Open TX', position.txIds?.open || position.openTx, 'tx')}
    ${renderV2ReportAddressRow('Lock TX', position.txIds?.lock || position.lockTx, 'tx')}
    ${renderV2ReportAddressRow('Fee Key transfer TX', transferTx, 'tx')}
  </article>`;
}

function buildV2ReportHeldReserveAuditSection(audit = {}) {
  const state = audit?.state || 'warn';
  const badgeClass = state === 'danger' ? 'badge-danger' : state === 'pass' ? 'badge-ok' : 'badge-warn';
  const coverage = Number(audit?.coverage);
  return `<div class="held-reserve-audit">
    <h3 class="subsection">Held reserve audit <span class="badge ${badgeClass}">${escapeHtml(state)}</span></h3>
    <div class="pool-facts">
      ${renderV2ReportFactRow('Held reserve', reportPercent(audit?.heldReservePercent))}
      ${renderV2ReportFactRow('Explicit prealloc', reportPercent(audit?.explicitPreallocationPercent))}
      ${renderV2ReportFactRow('Airdrop reserve', reportPercent(audit?.airdropReservePercent))}
      ${renderV2ReportFactRow('Unallocated reserve', reportPercent(audit?.unallocatedReservePercent))}
      ${renderV2ReportFactRow('Configured support', audit?.supportSol != null ? `${reportNumber(audit.supportSol, { maximumFractionDigits: 3 })} SOL` : '-')}
      ${renderV2ReportFactRow('Required support', audit?.requiredSupportSol != null ? `${reportNumber(audit.requiredSupportSol, { maximumFractionDigits: 3 })} SOL` : '-')}
      ${renderV2ReportFactRow('Coverage', Number.isFinite(coverage) ? reportPercent(coverage * 100) : '-')}
      ${renderV2ReportFactRow('Estimate rate', audit?.solUsd ? `$${reportNumber(audit.solUsd, { maximumFractionDigits: 2 })} / SOL` : 'not attached')}
    </div>
    <p class="audit-note">${escapeHtml(audit?.detail || 'Held reserve backing was not evaluated.')}</p>
  </div>`;
}

function buildV2ReportTokenomics(data, config, results) {
  const items = buildV2TokenomicsItems(config, results);
  const placedPercent = items.reduce((sum, item) => sum + (Number(item.percent) || 0), 0);
  const supply = Number(String(data.totalSupply ?? config.token.supply ?? '').replace(/[$,\s]/g, ''));
  const logoDataUrl = String(config?.token?.logo?.dataUrl || '');
  const logoSrc = data?.token?.imageUri || (logoDataUrl.length > 0 && logoDataUrl.length <= 60000 ? logoDataUrl : null);
  const chartSvg = renderV2TokenomicsDonutSvg(items, {
    size: 220,
    centerLabel: reportPercent(placedPercent),
    centerDetail: 'placed',
    logoSrc,
  });
  const rows = items.map((item) => {
    const amount = Number.isFinite(supply) ? supply * (item.percent / 100) : null;
    return `<div class="breakdown-row">
      <span class="breakdown-swatch" style="background:${escapeHtml(item.color)}"></span>
      <span>${escapeHtml(item.label)}</span>
      <strong>${reportPercent(item.percent)}</strong>
      <em>${amount == null ? '-' : reportNumber(amount, { maximumFractionDigits: 0 })}</em>
    </div>`;
  }).join('');

  return `<div class="tokenomics">
    <div>
      <div class="donut-svg-wrap">${chartSvg}</div>
      <div class="chart-caption">FIG. 02 · Token supply across launch surfaces</div>
    </div>
    <div class="breakdown-list">${rows}</div>
  </div>
  ${buildV2ReportHeldReserveAuditSection(data.heldReserveAudit)}`;
}

function buildV2ReportPoolSections(results, config) {
  const topologyPools = Array.isArray(config?.poolTopology?.pools) ? config.poolTopology.pools : [];
  if (!results.length && !topologyPools.length) {
    return '<p class="muted">No liquidity pool proof or planned topology is recorded yet.</p>';
  }

  const rows = results.length ? results : topologyPools.map((pool, index) => ({
    allocationIndex: index,
    quoteSymbol: pool.quoteSymbol || pool.quoteToken,
    supplyPercent: pool.supplyPercent,
    plannedOnly: true,
    mainPositions: [],
    ladderPositions: [],
    supportPositions: [],
    bootstrap: null,
    txIds: {},
  }));
  const colorItems = buildV2TokenomicsItems(config, rows);

  return rows.map((pool, index) => {
    const userPool = v2ReportPoolConfig(config, pool, index) || {};
    const quote = pool.quoteSymbol || userPool.quoteSymbol || userPool.quoteToken || 'quote';
    const positionRows = v2ReportPositionRows(pool);
    const distribution = Array.isArray(userPool.distribution) ? userPool.distribution : [];
    const ladder = userPool.ladder || {};
    const support = userPool.support || {};
    const feeTierSummary = v2ReportPoolFeeTierLabel(pool, userPool);
    const distributionRows = distribution.length
      ? distribution.map((slice, sliceIndex) => `<span>${escapeHtml(`Slice ${sliceIndex + 1}`)} <strong>${reportPercent(slice.sharePercent)}</strong>${slice.recipient ? ` <em>${escapeHtml(fullAddress(slice.recipient))}</em>` : ''}</span>`).join('')
      : '<span>Main liquidity <strong>100%</strong></span>';
    const poolEnum = String(index + 1).padStart(2, '0');
    return `<section class="pool-section">
      <div class="pool-section-header">
        <div class="enum-badge">POOL · ${poolEnum}</div>
        <h2 class="pool-title">
          <span class="pool-swatch" style="background:${escapeHtml(colorItems[index % Math.max(1, colorItems.length)]?.color || '#8a3a1a')}"></span>
          ${escapeHtml(quote)} pool
        </h2>
        <div class="pool-meta">${escapeHtml(reportPercent(pool.supplyPercent ?? userPool.supplyPercent))} of token supply · Fee tier ${escapeHtml(feeTierSummary)} · ${pool.plannedOnly ? 'Planned topology' : 'Recorded on-chain'}</div>
      </div>
      <div class="pool-facts">
        ${renderV2ReportFactRow('Supply allocation', reportPercent(pool.supplyPercent ?? userPool.supplyPercent))}
        ${renderV2ReportFactRow('Fee tier index', pool.ammConfigIndex ?? userPool.ammConfigIndex ?? '-')}
        ${renderV2ReportFactRow('Tick spacing', pool.tickSpacing ?? '-')}
        ${renderV2ReportFactRow('Initial price', pool.initialPrice ?? '-')}
        ${renderV2ReportFactRow('Launch side', pool.launchedSide || '-')}
        ${renderV2ReportFactRow('Ladder', ladder.mode === 'manual' ? `${(ladder.bands || []).length} manual bands` : ladder.mode === 'simple' ? `${ladder.bandCount || 0} bands` : 'off')}
        ${renderV2ReportFactRow('Support', support.mode === 'custom' ? (Array.isArray(support.layers) && support.layers.length ? `${reportNumber(support.solValue, { maximumFractionDigits: 3 })} SOL in ${support.layers.length} layers, down to ${reportPercent(support.depthPct)} depth` : `${reportNumber(support.solValue, { maximumFractionDigits: 3 })} SOL at ${reportPercent(support.depthPct)} depth`) : 'off')}
      </div>
      <div class="slice-strip">${distributionRows}</div>
      <div class="pool-addresses">
        ${renderV2ReportAddressRow('Pool ID', pool.poolId)}
        ${renderV2ReportAddressRow('Quote token mint', pool.quoteAddress || pool.quoteMint || userPool.quoteMint)}
        ${renderV2ReportAddressRow('Create-pool TX', pool.txIds?.createPool || pool.createPoolTx, 'tx')}
      </div>
      ${renderV2ReportDepthChart(pool, userPool)}
      <div class="positions-grid">
        ${positionRows.length ? positionRows.map(renderV2ReportPositionCard).join('') : '<p class="muted">No position records have been written for this pool yet.</p>'}
      </div>
    </section>`;
  }).join('');
}

function buildV2ReportAirdropSection(proof, config) {
  const audit = buildV2ReportAirdropAudit(proof, config);
  const sampleLimit = 100;
  const overflowRowHtml = (hidden, noun) => (hidden > 0
    ? `<tr><td colspan="3" class="report-overflow-row">&hellip;and ${Number(hidden).toLocaleString()} more ${escapeHtml(noun)} - full row evidence is retained in the JSON proof or hash-bound embedded proof.</td></tr>`
    : '');
  const planned = Number(proof?.airdrop?.plannedRecipientCount || config?.poolTopology?.airdrop?.recipientCount || 0);
  const delivered = Number(proof?.airdrop?.deliveredCount || 0);
  const failed = Number(proof?.airdrop?.failedCount || 0);
  const transferred = Array.isArray(proof?.airdrop?.transferred) ? proof.airdrop.transferred : [];
  const failedRows = Array.isArray(proof?.airdrop?.failed) ? proof.airdrop.failed : [];
  const plannedRows = Array.isArray(config?.poolTopology?.airdrop?.recipients) ? config.poolTopology.airdrop.recipients : [];
  const deliveredRows = transferred.length
    ? transferred.slice(0, sampleLimit).map((row) => `<tr>
      <td>${escapeHtml(row.wallet || row.recipient || '-')}</td>
      <td>${escapeHtml(String(row.tokens ?? row.amount ?? '-'))}</td>
      <td>${row.txId || row.signature ? `<a href="${escapeHtml(solscanTxUrl(row.txId || row.signature))}" target="_blank" rel="noopener">${escapeHtml(shortAddress(row.txId || row.signature))}</a>` : '-'}</td>
    </tr>`).join('') + overflowRowHtml(transferred.length - sampleLimit, 'delivered recipients')
    : '<tr><td colspan="3">No delivered airdrop transfers recorded.</td></tr>';
  const failedTableRows = failedRows.length
    ? failedRows.slice(0, sampleLimit).map((row) => `<tr>
      <td>${escapeHtml(row.wallet || '-')}</td>
      <td>${escapeHtml(String(row.tokens ?? '-'))}</td>
      <td>${escapeHtml(row.error || row.reason || 'failed')}</td>
    </tr>`).join('') + overflowRowHtml(failedRows.length - sampleLimit, 'failed recipients')
    : '<tr><td colspan="3">No failed airdrop recipients recorded.</td></tr>';
  const plannedTableRows = !transferred.length && plannedRows.length
    ? plannedRows.slice(0, sampleLimit).map((row) => `<tr>
      <td>${escapeHtml(row.wallet || '-')}</td>
      <td>${escapeHtml(String(row.tokens ?? '-'))}</td>
      <td>pending</td>
    </tr>`).join('') + overflowRowHtml(plannedRows.length - sampleLimit, 'pending recipients')
    : '';

  return `<hr class="section-rule">
    <div class="enum-badge">[ 04 ] &nbsp; Airdrop</div>
    <h2 class="section-title">Airdrop distribution</h2>
    <div class="token-summary-grid">
      <div class="token-stat"><div class="token-stat-label">Planned</div><div class="token-stat-value">${planned}</div></div>
      <div class="token-stat"><div class="token-stat-label">Delivered</div><div class="token-stat-value">${delivered}</div></div>
      <div class="token-stat"><div class="token-stat-label">Failed</div><div class="token-stat-value">${failed}</div></div>
      <div class="token-stat"><div class="token-stat-label">Budget</div><div class="token-stat-value">${reportPercent(audit.effectiveSupplyPercent)}</div></div>
    </div>
    <h3 class="subsection">Budget and source</h3>
    <div class="pool-facts">
      ${renderV2ReportFactRow('Source', audit.source)}
      ${renderV2ReportFactRow('Requested budget', reportPercent(audit.requestedSupplyPercent))}
      ${renderV2ReportFactRow('Required budget', reportPercent(audit.requiredSupplyPercent))}
      ${renderV2ReportFactRow('Budget tokens', reportNumber(audit.budgetTokens, { maximumFractionDigits: 0 }))}
      ${renderV2ReportFactRow('Explicit CSV tokens', reportNumber(audit.explicitTokens, { maximumFractionDigits: 0 }))}
      ${renderV2ReportFactRow('Remaining budget', reportNumber(audit.remainingTokens, { maximumFractionDigits: 0 }))}
      ${renderV2ReportFactRow('Execution estimate', `${reportNumber(audit.executionCostSol, { maximumFractionDigits: 6 })} SOL`)}
      ${renderV2ReportFactRow('Budget warning', audit.budgetError || 'clear')}
    </div>
    <h3 class="subsection">${plannedTableRows ? 'Pending recipients' : 'Delivered recipients'}</h3>
    <table class="report-table">
      <thead><tr><th>Wallet</th><th>Tokens</th><th>${plannedTableRows ? 'State' : 'Tx'}</th></tr></thead>
      <tbody>${plannedTableRows || deliveredRows}</tbody>
    </table>
    <h3 class="subsection">Failed recipients</h3>
    <table class="report-table">
      <thead><tr><th>Wallet</th><th>Tokens</th><th>Reason</th></tr></thead>
      <tbody>${failedTableRows}</tbody>
    </table>`;
}

function buildV2ReportRecoverySection(data) {
  const audit = data?.recoveryAudit || buildV2ReportRecoveryAudit();
  const journals = Array.isArray(audit.relatedJournals) ? audit.relatedJournals : [];
  const journalRows = journals.length
    ? journals.map((journal) => `<tr>
      <td>${escapeHtml(journal.id || '-')}</td>
      <td>${escapeHtml(`${journal.status || '-'} / ${journal.stage || '-'}`)}</td>
      <td>${escapeHtml(`${journal.poolProgress?.recordedPools || 0}/${journal.poolProgress?.plannedPools || 0}`)}</td>
      <td>${escapeHtml(journal.resumePlan?.manualRecoveryRequired ? 'manual recovery' : journal.resumePlan?.title || 'review')}</td>
    </tr>`).join('')
    : '<tr><td colspan="4">No related recovery journals are loaded in this local session.</td></tr>';

  return `<hr class="section-rule">
    <div class="enum-badge">[ 06 ] &nbsp; Recovery</div>
    <h2 class="section-title">Launch journal and recovery state</h2>
    <div class="token-summary-grid">
      <div class="token-stat"><div class="token-stat-label">Proof stage</div><div class="token-stat-value">${escapeHtml(audit.stage || 'draft')}</div></div>
      <div class="token-stat"><div class="token-stat-label">Active journals</div><div class="token-stat-value">${audit.activeJournalCount || 0}</div></div>
      <div class="token-stat"><div class="token-stat-label">Failed journals</div><div class="token-stat-value">${audit.failedJournalCount || 0}</div></div>
      <div class="token-stat"><div class="token-stat-label">Pending wallets</div><div class="token-stat-value">${audit.pendingWalletCount || 0}</div></div>
    </div>
    ${renderV2ReportFactRow('Journal ID', audit.journalId || '-')}
    ${renderV2ReportFactRow('Proof status', audit.status || 'draft')}
    ${renderV2ReportFactRow('Last checkpoint', audit.updatedAt ? reportTimestamp(audit.updatedAt) : '-')}
    <h3 class="subsection">Resume evidence</h3>
    <table class="report-table">
      <thead><tr><th>Journal</th><th>Status / stage</th><th>Pools</th><th>Resume plan</th></tr></thead>
      <tbody>${journalRows}</tbody>
    </table>`;
}

function buildV2LaunchReportHtml({ proof = currentLaunchProof(), config = currentLaunchConfig(), launchData = null } = {}) {
  config = proofConfigForFingerprint(proof, config);
  const rawData = launchData || buildV2LaunchReportData(proof, config);
  const parityBundle = proofExportParityBundle(proof, config, rawData);
  const data = rawData && typeof rawData === 'object'
    ? { ...rawData, ...parityBundle }
    : rawData;
  const embeddedProofPayload = buildV2ProofExportPayload({
    proof,
    config,
    launchData: data,
    compactForHtml: true,
  });
  const token = proof?.token || {};
  const results = Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results : [];
  const report = currentReportPublish(proof, config);
  const reportUri = report?.htmlUri || report?.jsonUri || null;
  const name = token.name || config.token.name || data.name || 'Untitled token';
  const symbol = token.symbol || config.token.symbol || data.symbol || 'TOK';
  const generatedAt = data.generatedAt || new Date().toISOString();
  const authorityRows = [
    ['Mint authority', token.mintAuthorityRenounced ? 'Renounced - supply is permanently capped' : 'Not confirmed revoked'],
    ['Freeze authority', token.freezeAuthorityDisabled ? 'Disabled - holders cannot be frozen' : 'Not confirmed disabled'],
    ['Metadata update authority', token.metadataUpdateAuthorityRevoked ? 'Revoked - name, symbol, and media are locked' : 'Not confirmed revoked'],
    ['Metadata immutability', token.metadataImmutable ? 'Immutable' : 'Not confirmed immutable'],
    ['Token program', 'SPL Token (classic) - no Token-2022 extensions in the v1 launch path'],
  ].map(([label, value]) => renderV2ReportFactRow(label, value)).join('');
  const lockCount = Number(proof?.liquidity?.lockedPositionCount || proofLockedPositionCount(results));
  const feeKeyCount = Number(proof?.liquidity?.feeKeyCount || proofFeeKeyCount(results));
  const transfer = proof?.transfer || {};
  const finalDestination = proofEffectiveDestination(proof, config);
  const finalSweep = finalSweepProofState(transfer);
  const transferEvidenceHash = data?.finalSweep?.transferEvidenceHash || data?.transferEvidenceHash || comparisonTransferEvidenceHash(transfer);
  const finalSweepRows = [
    renderV2ReportFactRow('Sweep status', finalSweep.label),
    renderV2ReportFactRow('Wallet empty', transfer.walletEmpty === true ? 'yes' : transfer.walletEmpty === false ? 'no' : '-'),
    renderV2ReportAddressRow('Destination wallet', finalDestination),
    renderV2ReportFactRow('SOL transferred', transfer.solTransferred == null ? '-' : `${reportNumber(transfer.solTransferred, { maximumFractionDigits: 6 })} SOL`),
    renderV2ReportFactRow('Tokens transferred', transfer.tokensTransferred == null ? '-' : reportNumber(transfer.tokensTransferred, { maximumFractionDigits: 0 })),
    renderV2ReportFactRow('NFTs transferred', Array.isArray(transfer.nftTransfers) ? String(transfer.nftTransfers.length) : transfer.nftsTransferred ?? '-'),
    renderV2ReportFactRow('Sweep evidence hash', transferEvidenceHash || '-'),
    renderV2ReportAddressRow('Published report', reportUri, 'url'),
  ].join('');
  const finalSweepTransferRows = buildV2ReportSweepTransferRows(transfer);
  const tokenDescription = String(config.token.description || '').trim();
  const localLogoDataUrl = String(config.token.logo?.dataUrl || '');
  const logoSrc = token.imageUri || (localLogoDataUrl.length > 0 && localLogoDataUrl.length <= 60000 ? localLogoDataUrl : null);
  const logoBlock = logoSrc
    ? `<img class="hero-logo" src="${escapeHtml(logoSrc)}" alt="${escapeHtml(symbol)} logo">`
    : `<div class="hero-logo hero-logo-placeholder">${escapeHtml(String(symbol || '?').slice(0, 3).toUpperCase())}</div>`;
  const plannedPoolCount = Array.isArray(data.plannedPools) ? data.plannedPools.length : 0;
  const targetMarketCapUsd = Number.isFinite(Number(data.targetMarketCapUsd))
    ? Number(data.targetMarketCapUsd)
    : Number.isFinite(Number(config?.poolTopology?.targetMarketCapUsd ?? config?.funding?.targetMarketCapUsd))
      ? Number(config?.poolTopology?.targetMarketCapUsd ?? config?.funding?.targetMarketCapUsd)
      : null;
  const quoteRouteCount = new Set([
    ...results.map((pool) => pool.quoteSymbol || pool.quoteToken).filter(Boolean),
    ...(Array.isArray(data.plannedPools) ? data.plannedPools.map((pool) => pool.quoteSymbol || pool.quoteToken).filter(Boolean) : []),
  ]).size || '-';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#efe5cd">
  <title>${escapeHtml(name)} (${escapeHtml(symbol)}) - Launch Record</title>
  <style>
    ${v2ClassicReportCss()}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="masthead">
      <div class="masthead-left">
        <span class="masthead-brand">T R E B U C H E T</span>
        <span>FIG. 01 · Launch Record</span>
      </div>
      <div class="masthead-right">${escapeHtml(reportTimestamp(generatedAt))}</div>
    </div>

    <header class="title-block">
      ${logoBlock}
      <div>
        <p class="doc-fig">Token launch report · permanent record</p>
        <h1 class="doc-title">${escapeHtml(name)} <span class="doc-symbol">· ${escapeHtml(symbol)}</span></h1>
        ${tokenDescription ? `<p class="doc-subtitle">${escapeHtml(tokenDescription)}</p>` : ''}
      </div>
    </header>

    ${renderV2ReportDemoBanner(proof, results)}
    ${renderV2ReportStatusBanner(results)}

    <hr class="section-rule">
    <div class="enum-badge">[ 01 ] &nbsp; Token</div>
    <h2 class="section-title">Token specification</h2>
    <div class="token-summary-grid">
      <div class="token-stat"><div class="token-stat-label">Total supply</div><div class="token-stat-value">${reportNumber(token.totalSupply ?? config.token.supply, { maximumFractionDigits: 0 })}</div></div>
      <div class="token-stat"><div class="token-stat-label">Decimals</div><div class="token-stat-value">${escapeHtml(String(token.decimals ?? config.token.decimals ?? '-'))}</div></div>
      <div class="token-stat"><div class="token-stat-label">Launch market cap</div><div class="token-stat-value">${targetMarketCapUsd && targetMarketCapUsd > 0 ? `$${reportNumber(targetMarketCapUsd, { maximumFractionDigits: 0 })}` : '-'}</div></div>
      <div class="token-stat"><div class="token-stat-label">Pools</div><div class="token-stat-value">${results.length || plannedPoolCount}</div></div>
      <div class="token-stat"><div class="token-stat-label">Positions</div><div class="token-stat-value">${proofPositions(results)}</div></div>
    </div>

    <h3 class="subsection">Mint &amp; launch wallet</h3>
    ${renderV2ReportAddressRow('Token mint', token.mint)}
    ${renderV2ReportAddressRow('Launch wallet', proof?.walletPublicKey || data.launchWallet)}
    ${renderV2ReportAddressRow('Planned return wallet', finalDestination)}
    ${renderV2ReportAddressRow('Metadata URI', token.metadataUri, 'url')}
    ${renderV2ReportAddressRow('Image URI', token.imageUri, 'url')}

    <h3 class="subsection">Contract safety</h3>
    <div class="pool-facts">${authorityRows}</div>

    <hr class="section-rule">
    <div class="enum-badge">[ 02 ] &nbsp; Tokenomics</div>
    <h2 class="section-title">Supply distribution</h2>
    ${buildV2ReportTokenomics(data, config, results)}
    ${renderV2ReportObservedSpend(data.observedSpend)}

    <hr class="section-rule">
    <div class="enum-badge">[ 03 ] &nbsp; Pools &amp; Positions</div>
    <h2 class="section-title">Liquidity pool breakdown</h2>
    <div class="token-summary-grid">
      <div class="token-stat"><div class="token-stat-label">Pool IDs</div><div class="token-stat-value">${Number(data?.liquidity?.poolCount || launchProofPoolIds(proof).length || 0)}</div></div>
      <div class="token-stat"><div class="token-stat-label">Locked positions</div><div class="token-stat-value">${lockCount}</div></div>
      <div class="token-stat"><div class="token-stat-label">Fee Keys</div><div class="token-stat-value">${feeKeyCount || '-'}</div></div>
      <div class="token-stat"><div class="token-stat-label">Quote routes</div><div class="token-stat-value">${quoteRouteCount}</div></div>
    </div>
    ${buildV2ReportPoolSections(results, config)}

    ${buildV2ReportAirdropSection(proof, config)}

    ${buildV2ReportRecoverySection(data)}

    <hr class="section-rule">
    <div class="enum-badge">[ 07 ] &nbsp; Verification</div>
    <h2 class="section-title">Auditing this launch</h2>
    <div class="audit-copy">
      <p><strong>Safe token contract</strong> - fetch the mint account and verify that mint and freeze authorities are unset. If metadata is recorded above, verify the metadata account shows the expected update-authority posture.</p>
      <p><strong>Locked liquidity</strong> - every position card lists the position NFT, lock transaction, and Fee Key NFT when those facts are available. Burn &amp; Earn custody should match the lock transaction for each locked position.</p>
      <p><strong>Concentrated LP shape</strong> - the tick ranges above define the tradable bands. Compare the pool and position accounts against the configured slices, ladder bands, support bands, and Fee Key recipients.</p>
      <p><strong>Report authenticity</strong> - a permanent publish should be signed by the launch wallet that minted the token and created the pools. The Arweave items should carry <code>Data-Protocol: trebuchet-launch-report</code>; ignore third-party reposts that cannot be tied back to the launch wallet.</p>
    </div>

    <hr class="section-rule">
    <div class="enum-badge">[ 09 ] &nbsp; Final Sweep</div>
    <h2 class="section-title">Remaining assets and report custody</h2>
    ${finalSweepRows}
    <h3 class="subsection">Final sweep transfer evidence</h3>
    <table class="report-table">
      <thead><tr><th>Type</th><th>Asset</th><th>Amount</th><th>Transaction / state</th></tr></thead>
      <tbody>${finalSweepTransferRows}</tbody>
    </table>

    <footer class="doc-footer">
      <div>
        <div>Trebuchet - launch Solana tokens, no middleman.</div>
        <div style="margin-top:4px;text-transform:none;letter-spacing:0.04em;">Solscan links use mainnet-beta. Use copy buttons for every address and transaction.</div>
      </div>
      <div><a href="https://makesometokens.com/" target="_blank" rel="noopener">makesometokens.com</a></div>
    </footer>
  </div>
  <div id="toast" class="toast" role="status" aria-live="polite">Copied</div>
  <script id="trebuchet-v2-proof" type="application/json">${htmlScriptJson(embeddedProofPayload)}</script>
  <script>
    ${v2ClassicReportScript()}
  </script>
</body>
</html>`;
}

function renderReportPanel() {
  const topology = currentClassicModel();
  const destination = topology.sweepDestination;
  const funder = state.fundingWallet?.funder || null;
  const destinationState = destination
    ? isProbablySolanaAddress(destination) ? fullAddress(destination) : 'Check address'
    : funder ? `Funding wallet · ${fullAddress(funder)}` : 'Funding wallet';
  const publish = topology.report.publish;
  const summary = $('#reportSummary');
  summary.textContent = publish ? 'Saved on Arweave' : 'Local only';
  summary.className = `risk-badge ${publish ? '' : 'warn'}`;
  const publishButton = document.querySelector('[data-action="toggle-report-publish"]');
  if (publishButton) publishButton.setAttribute('aria-checked', String(Boolean(publish)));
  $('#reportPreview').innerHTML = `
    <div class="mini-row"><span>Launch report</span><strong>${publish ? 'Saved permanently on Arweave and on this computer' : 'Kept on this computer only'}</strong></div>
    <div class="mini-row ${destination && !isProbablySolanaAddress(destination) ? 'danger' : ''}"><span>Return wallet</span><strong>${escapeHtml(destinationState)}</strong></div>
    <div class="mini-row"><span>Airdrop rows</span><strong>${topology.airdrop.recipients.length || topology.airdrop.recipientCount}</strong></div>
    <div class="mini-row"><span>Fee Key recipient</span><strong>${topology.feeKeyRecipient ? escapeHtml(fullAddress(topology.feeKeyRecipient)) : 'Same as sweep'}</strong></div>
  `;
}
