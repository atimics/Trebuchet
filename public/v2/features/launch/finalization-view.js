function finalizationBadge(proof) {
  if (!proof?.token?.mint) return { label: 'Needs token', className: 'warn' };
  const config = proofConfigForFingerprint(proof, currentLaunchConfig());
  if (!proofHasReportablePoolIdentity(proof, config)) return { label: 'Needs pools', className: 'warn' };
  if (!proofHasReportPublishEvidence(proof, config)) return { label: 'Needs proof', className: 'warn' };
  if (state.reportPublishing) return { label: 'Publishing', className: '' };
  const reportArtifact = currentReportArtifact(proof, config, { allowTransient: true });
  if (!reportArtifact && staleReportPublishForProof(proof, config)) return { label: 'Report stale', className: 'warn' };
  const report = currentReportPublish(proof, config, { allowTransient: true });
  if (report?.status === 'failed' || report?.failed) return { label: 'Report retry', className: 'danger' };
  if (reportArtifact) {
    const finalSweepComplete = transferHasWalletEmptyFinalSweepEvidence(proof?.transfer);
    const reportArtifactRecord = reportArtifact.record || reportArtifact;
    if (finalSweepComplete && !reportArtifactMatchesTerminalSweep(reportArtifactRecord, proof)) {
      return { label: 'Final proof', className: 'warn' };
    }
    if (!finalSweepComplete) return { label: 'Needs sweep', className: 'warn' };
    return { label: 'Proof ready', className: '' };
  }
  return { label: 'Finalize', className: 'warn' };
}

function proofExplorerItems(proof = currentLaunchProof(), reportUri = null, config = proofConfigForFingerprint(proof, currentLaunchConfig())) {
  const results = Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results : [];
  const poolIds = [
    ...(Array.isArray(proof?.liquidity?.poolIds) ? proof.liquidity.poolIds : []),
    ...results.map((result) => result?.poolId).filter(Boolean),
  ].filter((value, index, list) => value && list.indexOf(value) === index);
  const items = [];
  if (proof?.token?.mint) {
    items.push({ label: 'Mint', value: shortAddress(proof.token.mint), href: solscanAccountUrl(proof.token.mint) });
  }
  if (proof?.walletPublicKey) {
    items.push({ label: 'Launch wallet', value: shortAddress(proof.walletPublicKey), href: solscanAccountUrl(proof.walletPublicKey) });
  }
  poolIds.slice(0, 3).forEach((poolId, index) => {
    items.push({ label: `Pool ${index + 1}`, value: shortAddress(poolId), href: solscanAccountUrl(poolId) });
  });
  if (poolIds.length > 3) {
    items.push({ label: 'More pools', value: `${poolIds.length - 3} more`, href: null });
  }
  const destination = proofEffectiveDestination(proof, config);
  if (destination) {
    items.push({ label: 'Destination', value: shortAddress(destination), href: solscanAccountUrl(destination) });
  }
  if (reportUri) {
    items.push({ label: 'Report', value: shortAddress(reportUri), href: reportUri });
  } else {
    const localDossier = currentLocalDossier(proof, config);
    if (localDossier) {
      items.push({ label: 'Dossier', value: 'Local file', href: null });
    }
  }
  return items;
}

function buildProofShareSummary(proof = currentLaunchProof(), config = currentLaunchConfig()) {
  config = proofConfigForFingerprint(proof, config);
  const token = proof?.token || {};
  const symbol = token.symbol || config.token.symbol || 'TOKEN';
  const report = currentReportPublish(proof, config, { allowTransient: true });
  const reportUri = report?.htmlUri || report?.jsonUri || null;
  const localDossier = currentLocalDossier(proof, config);
  const poolCount = launchProofPoolIds(proof).length;
  const positionCount = proofPositions(proof?.liquidity?.results || []);
  const finalSweepComplete = transferHasWalletEmptyFinalSweepEvidence(proof?.transfer);
  const airdropStatus = airdropCompletionStatus(proof, config.poolTopology);
  const airdropSummary = airdropStatus.configured
    ? airdropStatus.complete
      ? `${airdropStatus.delivered} delivered / ${airdropStatus.failed} failed`
      : `needs proof: ${(airdropStatus.missing || []).join(', ') || `${airdropStatus.pending} pending`}`
    : 'not configured';
  const audit = buildV2ReportParityAudit(proof, config);
  const retirementGate = buildClassicRetirementGate(proof, audit, config);
  const fieldVerification = buildV2FieldVerification({
    proof,
    config,
    audit,
    retirementGate,
  });
  const fieldBlockerCount = Number(fieldVerification.blockerCount || 0);
  const criterionBlockerCount = Number(fieldVerification.criteriaBlockerCount || 0);
  const totalFieldBlockerCount = fieldBlockerCount + criterionBlockerCount;
  const fieldStatus = fieldVerification.ready
    ? `${fieldVerification.passCount}/${fieldVerification.itemCount} checks passing`
    : `${fieldVerification.passCount}/${fieldVerification.itemCount} checks passing; ${totalFieldBlockerCount} blocker${totalFieldBlockerCount === 1 ? '' : 's'}${criterionBlockerCount ? ` (${criterionBlockerCount} criteria)` : ''}`;
  const nextStep = !token.mint
    ? 'Create the token'
    : poolCount === 0 || positionCount === 0
      ? 'Create and lock liquidity'
      : !finalSweepComplete
        ? 'Complete the final sweep and save proof'
        : 'Launch complete';
  const operationalSummary = [
    `Trebuchet launch record: ${symbol}`,
    `Mint: ${token.mint || 'pending'}`,
    `Liquidity: ${poolCount} recorded pool${poolCount === 1 ? '' : 's'} / ${positionCount} position${positionCount === 1 ? '' : 's'}`,
    `Airdrop: ${airdropSummary}`,
    `Destination: ${proofEffectiveDestination(proof, config) || 'pending'}`,
    `Report: ${reportUri || (localDossier ? `saved launch record ${localDossier.filename}` : 'local proof pending')}`,
    `Next: ${nextStep}`,
  ];
  if (!finalSweepComplete) return operationalSummary.join('\n');
  return [
    ...operationalSummary,
    `Classic retirement: ${retirementGate.state === 'pass' ? 'ready' : 'blocked'}`,
    `Field parity: ${fieldStatus}`,
    ...fieldVerificationHandoffLines(fieldVerification),
    `Next action: ${fieldVerification.nextAction || 'none'} - ${fieldVerification.nextDetail || 'Field verification is complete.'}`,
  ].join('\n');
}

function fieldVerificationHandoffLines(fieldVerification = {}) {
  if (fieldVerification.ready) return [];
  const formatRows = (rows = []) => {
    const visible = rows.slice(0, 2).map((item) => {
      const label = item.label || item.title || item.id || 'Proof row';
      const detail = item.detail || item.evidence || item.action || 'Needs proof.';
      return `${label}: ${detail}`;
    });
    const remaining = rows.length - visible.length;
    if (remaining > 0) visible.push(`+${remaining} more`);
    return visible.join(' | ');
  };
  const lines = [];
  const blockers = Array.isArray(fieldVerification.blockers) ? fieldVerification.blockers.filter((item) => item?.pass !== true) : [];
  const criteriaBlockers = Array.isArray(fieldVerification.criteriaBlockers)
    ? fieldVerification.criteriaBlockers.filter((item) => item?.pass !== true)
    : [];
  if (blockers.length) lines.push(`Missing field proof: ${formatRows(blockers)}`);
  if (criteriaBlockers.length) lines.push(`Missing replacement criteria: ${formatRows(criteriaBlockers)}`);
  return lines;
}

function reportParityClass(stateName) {
  if (stateName === 'pass') return '';
  if (stateName === 'mismatch') return 'danger';
  if (stateName === 'missing') return 'danger';
  return 'warn';
}

function renderClassicArtifactComparisonPanel() {
  const comparison = state.classicReportComparison || {};
  const inputResult = comparison.result || null;
  const proof = currentLaunchProof();
  const config = proofConfigForFingerprint(proof, currentLaunchConfig());
  const selectedResult = currentClassicComparisonForProof(proof, config);
  const inputResultMatchesProof = Boolean(inputResult && classicComparisonMatchesProof(inputResult, proof, config));
  const result = selectedResult || inputResult;
  const usingProofSavedResult = Boolean(result && inputResult && !inputResultMatchesProof && result !== inputResult);
  const staleResult = Boolean(result && !classicComparisonMatchesProof(result, proof, config));
  const visibleComparisonError = usingProofSavedResult ? null : comparison.error;
  const badgeClass = staleResult ? 'warn' : result ? reportParityClass(result.status) : visibleComparisonError ? 'danger' : 'warn';
  const badgeLabel = usingProofSavedResult ? 'proof' : staleResult ? 'stale' : result ? result.status : visibleComparisonError ? 'error' : 'waiting';
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const resultSummary = result
    ? staleResult
      ? 'Comparison is for another Trebuchet proof'
      : result.status === 'missing'
      ? `${result.missingCount}/${result.fieldCount} proof fields missing`
      : result.status === 'mismatch'
        ? `${result.mismatchCount}/${result.fieldCount} fields mismatch`
        : `${result.passCount}/${result.fieldCount} fields match`
    : 'Paste classic report JSON or HTML';
  return `
    <details class="classic-compare-panel" ${result || visibleComparisonError ? 'open' : ''}>
      <summary>
        <span>
          <small>Classic artifact compare</small>
          <strong>${escapeHtml(resultSummary)}</strong>
        </span>
        <span class="risk-badge ${escapeHtml(badgeClass)}">${escapeHtml(badgeLabel)}</span>
      </summary>
      <textarea class="classic-artifact-text" rows="4" spellcheck="false" placeholder="Paste a completed classic report JSON export or HTML dossier">${escapeHtml(comparison.input || '')}</textarea>
      <div class="operator-toolbar compact">
        <button class="pill-button" type="button" data-action="load-classic-artifact">Load artifact</button>
        <button class="pill-button" type="button" data-action="compare-classic-artifact">Compare artifact</button>
        <button class="pill-button" type="button" data-action="clear-classic-artifact" ${comparison.input || result || visibleComparisonError ? '' : 'disabled'}>Clear</button>
      </div>
      ${usingProofSavedResult ? '<p class="classic-compare-note">Using the proof-saved Classic comparison; pasted artifact text is stale for this proof.</p>' : ''}
      ${visibleComparisonError ? `<p class="classic-compare-error">${escapeHtml(visibleComparisonError)}</p>` : ''}
      ${rows.length ? `<div class="classic-compare-list">
        ${rows.slice(0, 6).map((row) => `
          <article class="${escapeHtml(reportParityClass(row.state))}">
            <i class="fa-solid ${row.state === 'pass' ? 'fa-check' : row.state === 'mismatch' ? 'fa-circle-xmark' : row.state === 'missing' ? 'fa-circle-exclamation' : 'fa-triangle-exclamation'}"></i>
            <span>
              <strong>${escapeHtml(row.label)}</strong>
              <small>${escapeHtml(row.detail)}</small>
            </span>
          </article>
        `).join('')}
      </div>` : ''}
    </details>
  `;
}

function renderReportParityAuditPanel(audit = buildV2ReportParityAudit()) {
  const items = Array.isArray(audit?.items) ? audit.items : [];
  const orderedItems = [
    ...items.filter((item) => item.state === 'missing'),
    ...items.filter((item) => item.state === 'warn'),
    ...items.filter((item) => item.state === 'pass'),
  ];
  const comparisonItem = items.find((item) => item.id === 'classic-comparison');
  const focusItems = comparisonItem
    ? [comparisonItem, ...orderedItems.filter((item) => item.id !== comparisonItem)].slice(0, 6)
    : orderedItems.slice(0, 6);
  return `
    <div class="report-parity-audit ${escapeHtml(reportParityClass(audit?.status))}">
      <div class="report-parity-head">
        <span>
          <span class="eyebrow">Classic report parity audit</span>
          <strong>${escapeHtml(audit?.status === 'pass' ? 'Classic evidence complete' : audit?.status === 'missing' ? 'Proof fields missing' : 'Ready for review')}</strong>
          <em>${escapeHtml(`${audit?.passCount || 0} of ${audit?.itemCount || items.length || 0} checks pass`)}</em>
        </span>
        <span class="risk-badge ${escapeHtml(reportParityClass(audit?.status))}">${escapeHtml(audit?.status || 'missing')}</span>
      </div>
      <div class="report-parity-stats">
        <span><small>Pass</small><strong>${Number(audit?.passCount || 0)}</strong></span>
        <span><small>Warn</small><strong>${Number(audit?.warnCount || 0)}</strong></span>
        <span><small>Missing</small><strong>${Number(audit?.missingCount || 0)}</strong></span>
      </div>
      <div class="report-parity-list">
        ${focusItems.map((item) => `
          <article class="${escapeHtml(reportParityClass(item.state))}">
            <i class="fa-solid ${item.state === 'pass' ? 'fa-check' : item.state === 'missing' ? 'fa-circle-exclamation' : 'fa-triangle-exclamation'}"></i>
            <span>
              <strong>${escapeHtml(item.label)}</strong>
              <small>${escapeHtml(item.detail)}</small>
            </span>
          </article>
        `).join('')}
      </div>
      ${renderClassicArtifactComparisonPanel()}
    </div>
  `;
}

function finalizationNoticeRows({
  report,
  localDossier,
  staleReport,
  reportNeedsFinalArtifact,
  airdropStatus,
  failedAirdrop,
} = {}) {
  const rows = [];
  if (report?.status === 'failed' || report?.failed) {
    rows.push({
      state: 'danger',
      text: `Report publish failed: ${report.error || 'retry after checking RPC, Arweave, and Recovery PIN state'}. Click Publish report to retry.`,
    });
  } else if (report?.status === 'skipped') {
    rows.push({
      state: 'warn',
      text: `Report publish skipped: ${report.reason || 'server did not return a permanent report URI'}. Click Publish report to retry when proof is ready.`,
    });
  }
  if (staleReport) {
    rows.push({
      state: 'warn',
      text: 'Existing report proof belongs to an older launch state. Regenerate it before treating the launch record as current.',
    });
  }
  if (reportNeedsFinalArtifact) {
    rows.push({
      state: 'warn',
      text: 'Terminal sweep is recorded. Download a fresh final launch record so the artifact carries the final sweep hash.',
    });
  }
  if (state.prefs.publishLaunchReport === false && !localDossier) {
    rows.push({
      state: 'warn',
      text: 'Report publishing is off. Download the saved launch record before treating the launch as reviewable.',
    });
  }
  const airdropIssue = airdropCompletionIssue(airdropStatus, 'publishing the report or sweeping');
  if (airdropIssue) {
    rows.push({
      state: airdropStatus?.retryRequired ? 'danger' : 'warn',
      text: airdropIssue,
    });
  } else if (failedAirdrop > 0) {
    rows.push({
      state: 'warn',
      text: `${failedAirdrop} airdrop recipient${failedAirdrop === 1 ? '' : 's'} still need attention before you call the launch clean.`,
    });
  }
  return rows;
}

// A practice run proves the recipe, not an on-chain launch, so it gets its own
// result instead of the live proof panel (whose report, lock, and sweep
// evidence a simulation cannot produce).
function renderPracticeResultPanel() {
  const run = state.lastDemoLaunchRun;
  const config = currentLaunchConfig();
  const symbol = run?.token?.symbol || config.token.symbol;
  const poolCount = Number(run?.liquidity?.results?.length || config.poolTopology?.pools?.length || 0);
  return `
    <div class="finalize-panel is-terminal practice-result">
      <div class="finalize-grid">
        <span><small>Token</small><strong>${escapeHtml(symbol)}</strong></span>
        <span><small>Pools</small><strong>${poolCount} locked</strong></span>
        <span><small>SOL spent</small><strong>0</strong></span>
      </div>
      <div class="operator-toolbar compact finalize-primary-actions">
        <button class="pill-button" type="button" data-action="select-environment" data-environment="live">Switch to live</button>
        <button class="pill-button" type="button" data-action="run-demo-launch" ${state.demoLaunchRunning ? 'disabled' : ''}>Run test again</button>
        <button class="pill-button" type="button" data-launch-workspace="configure">Edit token &amp; pools</button>
        <button class="pill-button" type="button" data-action="download-v2-proof">Download launch record</button>
      </div>
    </div>
  `;
}

function renderFinalizationPanel() {
  if (state.demoActive && state.lastDemoLaunchRun) return renderPracticeResultPanel();
  const proof = currentLaunchProof();
  const config = proofConfigForFingerprint(proof, currentLaunchConfig());
  const badge = finalizationBadge(proof);
  const tokenMint = proof?.token?.mint || null;
  const poolCount = launchProofPoolIds(proof).length;
  const positionCount = proofPositions(proof?.liquidity?.results || []);
  const report = currentReportPublish(proof, config, { allowTransient: true });
  const staleReport = staleReportPublishForProof(proof, config);
  const reportUri = report?.htmlUri || report?.jsonUri || null;
  const localDossier = currentLocalDossier(proof, config);
  const finalDestination = proofEffectiveDestination(proof, config);
  const finalSweepComplete = transferHasWalletEmptyFinalSweepEvidence(proof?.transfer);
  const reportArtifactRecord = report || localDossier || null;
  const reportArtifactSweepBound = Boolean(
    finalSweepComplete
    && reportArtifactRecord
    && reportArtifactMatchesTerminalSweep(reportArtifactRecord, proof)
  );
  const reportNeedsFinalArtifact = Boolean(
    finalSweepComplete
    && (reportUri || localDossier)
    && !reportArtifactSweepBound
  );
  const airdropStatus = airdropCompletionStatus(proof, config.poolTopology);
  const plannedAirdrop = Number(airdropStatus.planned || proof?.airdrop?.plannedRecipientCount || config.poolTopology?.airdrop?.recipients?.length || 0);
  const deliveredAirdrop = Number(airdropStatus.delivered || proof?.airdrop?.deliveredCount || 0);
  const failedAirdrop = Number(airdropStatus.failed || proof?.airdrop?.failedCount || 0);
  const airdropRecipientRows = Array.isArray(proof?.airdrop?.recipients) ? proof.airdrop.recipients : [];
  const airdropNeedsEvidenceRepair = Boolean(
    airdropStatus.configured
    && !airdropStatus.complete
    && !airdropStatus.retryRequired
    && Number(airdropStatus.pending || 0) <= 0
    && airdropRecipientRows.length > 0
  );
  const reportProofReady = proofHasReportPublishEvidence(proof, config) && airdropStatus.complete;
  const localDossierReady = proofCanCreateLocalDossier(proof, config) && airdropStatus.complete;
  const canPublish = state.apiStatus === 'connected'
    && proof?.canPublishReport
    && reportProofReady
    && state.prefs.publishLaunchReport !== false
    && !state.reportPublishing;
  const canRunAirdrop = state.apiStatus === 'connected'
    && !state.demoActive
    && proof?.canRunAirdrop
    && plannedAirdrop > 0
    && (airdropStatus.pending > 0 || airdropNeedsEvidenceRepair)
    && !state.airdropRunning;
  const canRetryAirdrop = state.apiStatus === 'connected'
    && !state.demoActive
    && failedAirdrop > 0
    && !state.airdropRunning;
  const canDownload = Boolean(proof || state.launchPlan);
  const canDownloadDossier = canDownload && (!proof?.token?.mint || localDossierReady || reportNeedsFinalArtifact);
  const reportLabel = state.reportPublishing
    ? 'Publishing report'
    : reportNeedsFinalArtifact
      ? 'Report needs final proof'
      : reportUri
        ? 'Report published'
        : localDossier
          ? 'Saved launch record active'
          : state.prefs.publishLaunchReport === false
            ? 'Publishing off'
            : canPublish
              ? 'Publish report'
              : 'Publishing unavailable';
  const dossierDownloadLabel = reportNeedsFinalArtifact
    ? 'Download final launch record'
    : localDossier
      ? 'Download launch record again'
      : localDossierReady
        ? 'Use saved launch record'
        : 'Download launch record';
  const airdropLabel = state.airdropRunning
    ? 'Airdropping'
    : airdropNeedsEvidenceRepair ? 'Repair proof'
    : deliveredAirdrop || failedAirdrop ? 'Airdrop recorded' : 'Run airdrop';
  const explorerItems = proofExplorerItems(proof, reportUri, config);
  const notices = finalizationNoticeRows({
    report,
    localDossier,
    staleReport,
    reportNeedsFinalArtifact,
    airdropStatus,
    failedAirdrop,
  });
  if (!reportUri && !localDossier && localDossierReady) {
    notices.unshift({
      state: 'warn',
      text: canPublish
        ? 'Choose one proof path: publish the report, or use a saved launch record. Either choice unlocks final sweep.'
        : 'Publishing is unavailable for this proof. Use saved launch record to save proof locally and unlock final sweep.',
    });
  }

  const primaryProofActions = `
    <button class="pill-button" type="button" data-action="download-v2-dossier" ${canDownloadDossier ? '' : 'disabled'}>${escapeHtml(dossierDownloadLabel)}</button>
    <button class="pill-button" type="button" data-action="download-v2-proof" ${canDownload ? '' : 'disabled'}>Download proof</button>
    ${reportUri ? `<a class="pill-button link-button" href="${escapeHtml(reportUri)}" target="_blank" rel="noopener">Open report</a>` : ''}
  `;
  const supplementalProofActions = [
    canPublish || state.reportPublishing
      ? `<button class="pill-button" type="button" data-action="publish-v2-report" ${canPublish ? '' : 'disabled'}>${escapeHtml(reportLabel)}</button>`
      : '',
    plannedAirdrop > 0
      ? `<button class="pill-button" type="button" data-action="run-v2-airdrop" ${canRunAirdrop ? '' : 'disabled'}>${escapeHtml(airdropLabel)}</button>`
      : '',
    failedAirdrop > 0
      ? `<button class="pill-button" type="button" data-action="retry-v2-airdrop" ${canRetryAirdrop ? '' : 'disabled'}>Retry failed</button>`
      : '',
    '<button class="pill-button" type="button" data-action="load-v2-proof">Load proof</button>',
  ].filter(Boolean).join('');

  return `
    <div class="finalize-panel ${finalSweepComplete ? 'is-terminal' : ''}">
      <div class="finalize-head">
        <span>
          <span class="eyebrow">Launch completion</span>
          <h3>${finalSweepComplete ? 'Launch complete' : 'Report, airdrop, and proof'}</h3>
          <p>${finalSweepComplete
            ? `Mint ${tokenMint ? shortAddress(tokenMint) : 'recorded'} · ${poolCount} pool${poolCount === 1 ? '' : 's'} · launch wallet empty.`
            : tokenMint ? `Mint ${shortAddress(tokenMint)} has ${poolCount} recorded pool ID${poolCount === 1 ? '' : 's'}.` : 'Create token and liquidity before final proof.'}</p>
        </span>
        <span class="finalize-head-status">
          <span class="risk-badge ${escapeHtml(badge.className)}">${escapeHtml(badge.label)}</span>
          ${finalSweepComplete ? '<button class="text-button" type="button" data-view="history">Launch record</button>' : ''}
        </span>
      </div>
      <div class="finalize-grid">
        <span>
          <small>Report</small>
          <strong>${escapeHtml(reportNeedsFinalArtifact ? 'Needs final proof' : reportUri ? 'Published' : localDossier ? 'Saved launch record' : staleReport ? 'Stale' : state.prefs.publishLaunchReport === false ? 'Local' : canPublish ? 'Ready' : 'Waiting')}</strong>
          <em>${reportNeedsFinalArtifact ? 'download after sweep' : reportUri ? escapeHtml(shortAddress(reportUri)) : localDossier ? escapeHtml(localDossier.filename) : staleReport ? 'regenerate required' : `${poolCount} pool ID proof${poolCount === 1 ? '' : 's'}`}</em>
        </span>
        <span>
          <small>Airdrop</small>
          <strong>${deliveredAirdrop}/${plannedAirdrop}</strong>
          <em>${failedAirdrop} failed</em>
        </span>
        <span>
          <small>Positions</small>
          <strong>${positionCount}</strong>
          <em>${Number(proof?.liquidity?.lockedPositionCount || 0)} locked</em>
        </span>
        <span>
          <small>Sweep</small>
          <strong>${finalSweepComplete ? 'Recorded' : proof?.transfer ? 'Needs proof' : proof?.canSweep ? 'Ready' : 'Waiting'}</strong>
          <em>${finalDestination ? escapeHtml(shortAddress(finalDestination)) : 'no destination'}</em>
        </span>
      </div>
      <div class="verify-panel-stage">
      <div class="proof-review-panel" id="proofExplorer">
        <div class="proof-review-head">
          <span>
            <span class="eyebrow">Proof review</span>
            <strong>${tokenMint ? 'Explorer bundle ready' : 'Waiting for launch record'}</strong>
          </span>
          <button class="pill-button" type="button" data-action="copy-v2-proof-summary" ${canDownload ? '' : 'disabled'}>Copy summary</button>
        </div>
        <div class="proof-link-grid">
          ${explorerItems.length ? explorerItems.map((item) => (
            item.href
              ? `<a href="${escapeHtml(item.href)}" target="_blank" rel="noopener"><small>${escapeHtml(item.label)}</small><strong>${escapeHtml(item.value)}</strong></a>`
              : `<span><small>${escapeHtml(item.label)}</small><strong>${escapeHtml(item.value)}</strong></span>`
          )).join('') : '<span><small>Status</small><strong>No proof yet</strong></span>'}
        </div>
      </div>
      </div>
      <div class="operator-toolbar compact finalize-primary-actions">
        ${primaryProofActions}
      </div>
      ${supplementalProofActions ? `<details class="drawer finalize-advanced-tools">
        <summary><span>More proof tools</span><strong>Load${canPublish ? ' · publish' : ''}${plannedAirdrop > 0 ? ' · airdrop' : ''}</strong></summary>
        <div class="operator-toolbar compact">${supplementalProofActions}</div>
      </details>` : ''}
      ${notices.length ? `<div class="finalize-notices">
        ${notices.map((notice) => `<p class="finalize-warning ${escapeHtml(notice.state)}">${escapeHtml(notice.text)}</p>`).join('')}
      </div>` : ''}
    </div>
  `;
}

function renderCancelRefundPanel(config = currentLaunchConfig()) {
  const walletPublicKey = selectedLaunchWalletPublicKey();
  const destinationWallet = config.poolTopology.sweepDestination || '';
  const busy = Boolean(
    state.fullRunRunning
    || state.realExecutionRunning
    || state.demoLaunchRunning
    || state.reportPublishing
    || state.airdropRunning
    || state.quoteAcquire.running
    || state.cancelRefund.running
  );
  const validDestination = isProbablySolanaAddress(destinationWallet);
  const sameWallet = walletPublicKey && destinationWallet === walletPublicKey;
  const canCancel = state.apiStatus === 'connected'
    && Boolean(state.apiClient?.cancelLaunchRefund || state.apiClient?.sweepPendingWallet)
    && Boolean(walletPublicKey)
    && validDestination
    && !sameWallet
    && !busy
    && !state.secretPin.locked;
  const result = state.cancelRefund.lastResult;
  const metrics = result ? recoverySweepMetrics({
    result: result.result,
    warningCount: result.warningCount,
    stillPending: result.partial,
  }) : null;
  const badge = state.cancelRefund.running
    ? { label: 'Sweeping', className: 'warn' }
    : state.cancelRefund.error
      ? { label: 'Failed', className: 'danger' }
      : result?.partial
        ? { label: 'Review', className: 'warn' }
        : result
          ? { label: 'Refunded', className: '' }
          : !walletPublicKey
            ? { label: 'Needs wallet', className: 'warn' }
            : !validDestination || sameWallet
              ? { label: 'Needs destination', className: 'warn' }
              : busy
                ? { label: 'Busy', className: 'warn' }
                : { label: 'Ready', className: '' };
  const detail = state.cancelRefund.error
    || (result
      ? result.message
      : 'Sweep the selected launch wallet back to your destination. Already-created token or pools remain on-chain.');
  return `
    <div class="cancel-refund-panel ${escapeHtml(badge.className)}">
      <div class="cancel-refund-head">
        <span>
          <span class="eyebrow">Abort and recover</span>
          <h3>Abort launch and sweep wallet</h3>
          <p>${escapeHtml(detail)}</p>
        </span>
        <span class="risk-badge ${escapeHtml(badge.className)}">${escapeHtml(badge.label)}</span>
      </div>
      <div class="cancel-refund-grid">
        <span><small>Launch wallet</small><strong>${walletPublicKey ? escapeHtml(shortAddress(walletPublicKey)) : 'Select'}</strong></span>
        <span><small>Destination</small><strong>${destinationWallet ? escapeHtml(shortAddress(destinationWallet)) : 'Set sweep'}</strong></span>
        <span><small>Tokens</small><strong>${metrics ? metrics.tokens : '-'}</strong></span>
        <span><small>NFTs</small><strong>${metrics ? metrics.nfts : '-'}</strong></span>
        <span><small>SOL</small><strong>${metrics ? metrics.sol.toFixed(4) : '-'}</strong></span>
        <span><small>Warnings</small><strong>${metrics ? metrics.warnings : '-'}</strong></span>
      </div>
      <div class="operator-toolbar compact">
        <button class="pill-button danger" type="button" data-action="cancel-refund-launch" ${canCancel ? '' : 'disabled'}>
          ${state.cancelRefund.running ? 'Refunding' : 'Cancel & refund'}
        </button>
        <button class="pill-button" type="button" data-action="inspect-recovery">Recovery</button>
      </div>
    </div>
  `;
}

function renderClassicBridge() {
  const config = currentLaunchConfig();
  const topology = config.poolTopology;
  const poolCount = topology.pools.length;
  const sliceCount = topology.pools.reduce((sum, pool) => sum + (pool.distribution?.length || 1), 0);
  const ladderCount = topology.pools.reduce((sum, pool) => sum + Number(pool.ladder?.bandCount || pool.ladder?.bands?.length || 0), 0);
  const fundingEstimateStatus = classicFundingEstimateStatus(config);
  const estimate = fundingEstimateStatus.matchesConfig ? state.classicFundingEstimate : null;
  const totalSol = Number(estimate?.totalSol || 0);
  const routeCount = estimate?.autoSwapPlan?.length || 0;
  const manualQuoteCount = quoteAcquireManualCount();
  const funding = fundingMeterSnapshot(config);
  const fundingBalanceKnown = state.demoActive || (funding.hasWalletBalance && funding.walletBalanceFresh);
  const fundingSolReady = fundingBalanceKnown && Number(funding.missingSol || 0) <= 0.001;
  const quoteStatus = quoteAcquireStatus(config);
  const manualSummary = manualPrefundSummary(quoteManualPrefundItems());
  const quoteFundingReady = quoteStatus.ready && (!manualQuoteCount || manualSummary.className === '');
  const fundingReady = Boolean(estimate && fundingSolReady && quoteFundingReady);
  const fundingWallet = selectedLaunchWalletPublicKey();
  const readiness = state.executionReadiness;
  const readinessMeta = readinessBadge(readiness);
  const quoteSafety = customQuoteSafetySummary(topology);
  const effectiveReadinessMeta = quoteSafety.blockers.length
    ? { label: 'Blocked', className: 'danger' }
    : quoteSafety.warnings.length && readinessMeta.className !== 'danger'
      ? { label: readinessMeta.label === 'Ready' ? 'Review' : readinessMeta.label, className: 'warn' }
      : readinessMeta;
  const blockers = Array.isArray(readiness?.blockers) ? readiness.blockers : [];
  const readinessNextDetail = {
    '/api/create-token': 'Funding is verified. The next irreversible operation creates the mint, attaches metadata, and revokes token authorities.',
    '/api/finish-token-creation': 'An on-chain mint exists, but metadata, supply, or authority safety is incomplete. Finish this mint before creating liquidity.',
    '/api/create-lp': 'The token is complete. The next operation creates the planned markets, positions, and liquidity locks.',
    '/api/resume-launch': 'Trebuchet found an incomplete liquidity operation and can resume only the missing work.',
    '/api/reveal-sealed-metadata': 'Liquidity is locked. The next operation reveals the committed identity and makes metadata immutable.',
    '/api/transfer-assets': 'Liquidity proof is complete. The next operation distributes assets, sweeps the launch wallet, and records final evidence.',
  }[readiness?.nextEndpoint];
  const readinessDetail = quoteSafety.blockers[0]?.detail
    || blockers[0]?.detail
    || readinessNextDetail
    || (state.apiStatus === 'connected' ? '' : 'Open the Trebuchet desktop app to continue.');
  const demoRunLabel = state.demoLaunchRunning
    ? 'Running test launch'
    : state.lastDemoLaunchRun
      ? 'Run test again'
      : 'Run test launch';
  const armedRunEnvelopeId = state.lastRunEnvelope?.status === 'armed'
    ? String(state.lastRunEnvelope.id || '')
    : '';
  const canExecuteNext = !state.demoActive
    && readiness?.status === 'ready'
    && Boolean(readiness?.nextEndpoint)
    && state.apiStatus === 'connected'
    && Boolean(armedRunEnvelopeId)
    && quoteSafety.blockers.length === 0;
  const heldPercent = currentPreallocationPlan().supplyPercent + (currentAirdropPlan().enabled ? currentAirdropPlan().supplyPercent : 0);
  $('#classicSummary').textContent = `${poolCount} pool${poolCount === 1 ? '' : 's'}${heldPercent > 0 ? ` · ${Number(heldPercent.toFixed(1))}% held back` : ''}`;

  const walletPublicKey = selectedLaunchWalletPublicKey();
  const selectedWallet = account();
  const walletReady = Boolean(walletPublicKey && walletIsUnlocked());
  const proofToken = currentLaunchProof()?.token || {};
  const tokenComplete = Boolean(
    isReadinessPhaseComplete('token')
    || (
      proofToken.mint
      && proofToken.mintAuthorityRenounced === true
      && proofToken.freezeAuthorityDisabled === true
    )
  );
  const liquidityComplete = Boolean(
    isReadinessPhaseComplete('liquidity')
    || (poolCount > 0 && launchProofPoolIds(currentLaunchProof()).length >= poolCount)
  );
  const metadataRevealPending = readiness?.nextEndpoint === '/api/reveal-sealed-metadata'
    || (
      liquidityComplete
      && (
        readiness?.completion?.metadataRevealPending === true
        || proofToken.sealedMetadataPending === true
      )
    );
  const finalSweepComplete = transferHasWalletEmptyFinalSweepEvidence(currentLaunchProof()?.transfer);
  const practiceComplete = Boolean(state.demoActive && state.lastDemoLaunchRun);
  const restoredPlanNotice = state.restoredLaunchJournalId && !finalSweepComplete ? `
    <aside class="recovered-plan-notice" role="status">
      <i class="fa-solid fa-rotate-left" aria-hidden="true"></i>
      <span><strong>Recovery loaded</strong><small>Journal ${escapeHtml(shortAddress(state.restoredLaunchJournalId))} restored this launch. Only unfinished work remains.</small></span>
      <button class="text-button" type="button" data-view="history">View record</button>
    </aside>
  ` : '';
  const classicBridge = $('#classicBridge');
  classicBridge.classList.toggle('has-recovery-notice', Boolean(restoredPlanNotice));
  classicBridge.classList.toggle('is-terminal-launch', finalSweepComplete);
  const mintEndpoint = readiness?.nextEndpoint === '/api/finish-token-creation'
    ? '/api/finish-token-creation'
    : '/api/create-token';
  const mintCanRun = canExecuteNext && ['/api/create-token', '/api/finish-token-creation'].includes(readiness?.nextEndpoint);
  const liquidityCanRun = canExecuteNext && ['/api/create-lp', '/api/resume-launch'].includes(readiness?.nextEndpoint);
  const revealCanRun = canExecuteNext && readiness?.nextEndpoint === '/api/reveal-sealed-metadata';
  const finishCanRun = canExecuteNext && readiness?.nextEndpoint === '/api/transfer-assets';
  const finishReturn = returnWalletStatus();
  const completedJournal = completedLaunchJournal();
  const finishDestinationReady = finishReturn.kind !== 'unverified'
    && Boolean(finishReturn.address)
    && finishReturn.address !== walletPublicKey;
  const fundingNeed = !estimate
    ? {
      eyebrow: 'Not estimated',
      title: 'Estimate the launch cost',
      detail: 'Work out how much SOL this launch needs.',
      action: 'estimate-funding',
      actionLabel: fundingEstimateStatus.stale ? 'Update estimate' : 'Estimate cost',
    }
    : state.demoActive
      ? {
        eyebrow: 'Test launch',
        title: 'No SOL needed',
        detail: `A live launch would need ${totalSol.toFixed(4)} SOL in the launch wallet. A test launch spends nothing.`,
        action: null,
        actionLabel: null,
      }
    : !fundingBalanceKnown
      ? {
        eyebrow: 'Send to launch wallet',
        title: `${totalSol.toFixed(4)} SOL`,
        detail: 'Send this much SOL to the address below, then check the balance.',
        action: 'refresh-manual-prefund',
        actionLabel: state.manualPrefund.polling ? 'Checking balance' : 'I funded it · check balance',
      }
      : Number(funding.missingSol || 0) > 0.001
        ? {
          eyebrow: 'Still needed',
          title: `${Number(funding.missingSol).toFixed(4)} SOL`,
          detail: `The launch wallet has ${Number(funding.availableSol || 0).toFixed(4)} of ${totalSol.toFixed(4)} SOL.`,
          action: 'refresh-manual-prefund',
          actionLabel: state.manualPrefund.polling ? 'Checking balance' : 'Check balance again',
        }
        : !quoteFundingReady
          ? {
            eyebrow: 'Pair tokens missing',
            title: 'Get the pair tokens',
            detail: 'Buy or send the pair tokens listed below.',
            action: routeCount ? 'start-quote-acquire' : 'refresh-manual-prefund',
            actionLabel: routeCount ? 'Acquire tokens' : 'Check token balance',
          }
          : {
            eyebrow: 'Funded',
            title: 'Launch wallet ready',
            detail: `${Number(funding.availableSol || 0).toFixed(4)} SOL is in the launch wallet.`,
            action: null,
            actionLabel: null,
          };
  const fundingPanel = `
    <section class="funding-task ${fundingReady ? 'is-ready' : ''}" aria-live="polite">
      <div class="funding-task-main">
        <span class="eyebrow">${escapeHtml(fundingNeed.eyebrow)}</span>
        <strong>${escapeHtml(fundingNeed.title)}</strong>
        <p>${escapeHtml(fundingNeed.detail)}</p>
      </div>
      ${estimate && fundingWallet && !state.demoActive ? `
        <div class="funding-task-address">
          <small>Launch wallet</small>
          <code>${escapeHtml(fundingWallet)}</code>
          <button class="secondary-button compact" type="button" data-action="copy-wallet-address"><i class="fa-solid fa-copy"></i><span>Copy address</span></button>
        </div>
      ` : ''}
      ${estimate ? renderFundingReceipt(estimate) : ''}
      ${renderPairTokenChecks()}
      <div class="funding-task-action">
        ${fundingNeed.action ? `<button class="primary-button" type="button" data-action="${escapeHtml(fundingNeed.action)}" ${state.manualPrefund.polling || (fundingNeed.action === 'estimate-funding' && state.fundingEstimating) ? 'disabled' : ''}><span>${escapeHtml(fundingNeed.action === 'estimate-funding' && state.fundingEstimating ? 'Estimating…' : fundingNeed.actionLabel)}</span><i class="fa-solid ${fundingNeed.action === 'estimate-funding' && state.fundingEstimating ? 'fa-spinner fa-spin' : estimate ? 'fa-rotate' : 'fa-calculator'}"></i></button>` : '<span class="risk-badge">Ready</span>'}
      </div>
    </section>
  `;
  const readinessPanel = ({
    title,
    detail,
    canRun,
    runLabel,
    complete,
    endpoint,
    primary = false,
    finalizationIssue = null,
  }) => {
    const recoveringToken = endpoint === '/api/finish-token-creation';
    const finalSweepAction = endpoint === '/api/transfer-assets';
    const finalSweepProofMissing = finalSweepAction
      && Boolean(finalizationIssue)
      && /report|dossier|proof/i.test(String(finalizationIssue));
    const recoveryDoesNotNeedFreshEstimate = [
      '/api/create-lp', // only ever next after the token exists
      '/api/finish-token-creation',
      '/api/resume-launch',
      '/api/reveal-sealed-metadata',
      '/api/transfer-assets',
    ].includes(endpoint);
    const needsFunding = !complete
      && !state.demoActive
      && !fundingReady
      && !recoveryDoesNotNeedFreshEstimate;
    const nextOperationReady = !complete
      && !state.demoActive
      && (fundingReady || recoveryDoesNotNeedFreshEstimate)
      && readiness?.status === 'ready'
      && readiness?.nextEndpoint === endpoint
      && blockers.length === 0
      && quoteSafety.blockers.length === 0;
    const needsRunEnvelope = nextOperationReady && !armedRunEnvelopeId && !finalizationIssue;
    const panelEyebrow = state.demoActive && !complete
      ? ''
      : complete
        ? 'Done'
        : needsFunding
          ? 'Needs funding'
          : finalizationIssue
            ? 'Needed first'
          : needsRunEnvelope
            ? 'Last check'
            : canRun
              ? 'Ready'
              : 'Checking';
    const panelTitle = state.demoActive && !complete
      ? 'Run the whole launch as a test'
      : complete
      ? title
      : needsFunding
        ? 'Fund the launch wallet'
        : finalSweepProofMissing
          ? 'Save local launch record'
          : finalizationIssue
            ? 'Resolve the final-sweep requirement'
        : needsRunEnvelope
          ? finalSweepAction
            ? 'Authorize final sweep'
            : recoveringToken ? 'Finish interrupted token safely' : 'Review this launch'
          : readiness?.nextAction || title;
    const panelDetail = state.demoActive && !complete
      ? 'Creates the token, pool and locks in a simulator. Nothing is sent.'
      : complete
      ? detail
      : needsFunding
        ? 'Send the estimated SOL on the Fund step.'
        : finalizationIssue
          ? String(finalizationIssue)
        : needsRunEnvelope
          ? finalSweepAction
            ? 'Confirm the return wallet, then approve the final sweep.'
            : recoveringToken
            ? 'Review the recovery once. Trebuchet will finish the existing mint, not create another.'
            : 'Check what will be sent and the most it can spend.'
        : readinessDetail;
    const panelBadge = state.demoActive && !complete ? '' : complete ? 'Done' : needsFunding || finalizationIssue ? 'Required' : needsRunEnvelope ? 'Review' : effectiveReadinessMeta.label;
    const panelClass = complete ? '' : needsFunding || finalizationIssue || needsRunEnvelope ? 'warn' : effectiveReadinessMeta.className;
    return `
    <div class="execution-readiness ${escapeHtml(panelClass)} ${primary ? 'is-primary-action' : ''}">
      <div class="readiness-main">
        <span>
          ${panelEyebrow ? `<span class="eyebrow">${escapeHtml(panelEyebrow)}</span>` : ''}
          <strong>${escapeHtml(panelTitle)}</strong>
          <small>${escapeHtml(panelDetail)}</small>
        </span>
        ${panelBadge ? `<span class="risk-badge ${escapeHtml(panelClass)}">${escapeHtml(panelBadge)}</span>` : ''}
      </div>
      <div class="launch-phase-actions">
        ${complete
          ? '<button class="primary-button compact" type="button" data-next-fact hidden></button>'
          : state.demoActive
            ? `<button class="primary-button compact" type="button" data-action="run-demo-launch" ${state.demoLaunchRunning ? 'disabled' : ''}><span>${escapeHtml(demoRunLabel)}</span><i class="fa-solid fa-flask"></i></button>`
            : finalSweepProofMissing
              ? '<button class="primary-button compact" type="button" data-action="download-v2-dossier"><span>Save launch record</span><i class="fa-solid fa-download"></i></button>'
              : finalizationIssue
                ? `<button class="primary-button compact" type="button" data-action="check-readiness" ${state.executionChecking ? 'disabled' : ''}><span>${state.executionChecking ? 'Checking' : 'Check requirement again'}</span><i class="fa-solid fa-rotate"></i></button>`
            : canRun
              ? `<button class="primary-button compact" type="button" data-action="execute-next-run" ${state.realExecutionRunning || state.fullRunRunning ? 'disabled' : ''}><span>${escapeHtml(state.realExecutionRunning ? 'Running' : runLabel)}</span><i class="fa-solid fa-arrow-right"></i></button>`
              : needsRunEnvelope
                ? `<button class="primary-button compact" type="button" data-action="review-and-arm-run"><span>${finalSweepAction ? 'Review final sweep' : recoveringToken ? 'Review recovery' : 'Review launch'}</span><i class="fa-solid fa-shield-halved"></i></button>`
              : fundingReady || recoveryDoesNotNeedFreshEstimate
                ? `<button class="primary-button compact" type="button" data-action="check-readiness" ${state.executionChecking ? 'disabled' : ''}><span>${state.executionChecking ? 'Checking' : 'Check again'}</span><i class="fa-solid fa-rotate"></i></button>`
                : '<button class="primary-button compact" type="button" data-launch-workspace="fund"><span>Fund the launch wallet</span><i class="fa-solid fa-coins"></i></button>'}
      </div>
    </div>
  `;
  };

  // With no wallet the row creates one; with wallets but none selected it
  // opens the picker.
  const hasManagedWallets = state.managedWallets.length > 0;
  const walletChoiceAction = walletPublicKey
    ? 'unlock-wallet-and-continue'
    : hasManagedWallets ? 'choose-launch-wallet' : 'generate-wallet';
  const walletChoiceLabel = walletPublicKey
    ? selectedWallet.name
    : hasManagedWallets ? 'Choose a launch wallet' : 'Create launch wallet';

  classicBridge.innerHTML = `
    ${restoredPlanNotice}
    <section class="classic-workspace-section launch-phase-workspace" data-classic-workspace="wallet">
      <h2 class="visually-hidden" id="walletStepTitle">Launch wallet</h2>
      <button class="launch-wallet-choice ${walletReady ? 'is-ready' : 'needs-action'}" type="button" data-action="${walletChoiceAction}" aria-label="${escapeHtml(walletChoiceLabel)}">
        <span class="launch-wallet-choice-icon"><i class="fa-solid ${walletPublicKey ? 'fa-key' : 'fa-plus'}"></i></span>
        <span class="launch-wallet-choice-copy">
          <small>${walletPublicKey ? 'Launch wallet' : 'No launch wallet yet'}</small>
          <strong>${escapeHtml(walletChoiceLabel)}</strong>
          <code>${escapeHtml(walletPublicKey || 'A new wallet, saved encrypted on this computer.')}</code>
        </span>
        ${walletPublicKey || hasManagedWallets ? `<span class="risk-badge ${walletReady ? '' : 'warn'}">${walletReady ? 'Continue' : walletPublicKey ? 'Unlock' : 'Choose'}</span>` : ''}
      </button>
      <details class="drawer phase-options">
        <summary><span>Wallet options</span><strong>Copy · lock · manage</strong></summary>
        <div class="launch-phase-actions">
          ${walletPublicKey
            ? `<button class="secondary-button" type="button" data-action="copy-wallet-address"><i class="fa-solid fa-copy"></i><span>Copy address</span></button>
               <button class="secondary-button" type="button" data-action="${walletReady ? 'toggle-wallet' : 'unlock-wallet-and-continue'}"><i class="fa-solid ${walletReady ? 'fa-lock' : 'fa-unlock'}"></i><span>${walletReady ? 'Lock wallet' : 'Unlock'}</span></button>`
            : ''}
          <button class="secondary-button" type="button" data-view="wallet"><i class="fa-solid fa-wallet"></i><span>Manage wallets</span></button>
        </div>
      </details>
    </section>
    <section class="classic-workspace-section classic-workspace-fund" data-classic-workspace="fund">
      <h2 class="visually-hidden" id="fundStepTitle">Fund</h2>
      ${completedJournal ? renderLaunchCompleteCard(completedJournal) : finishReturn.kind === 'unverified' ? renderFundingWalletHint({ compact: true }) : fundingPanel}
      ${!completedJournal && (state.destinations.funders || []).length ? `<section class="return-wallet fund-asset-destinations" aria-label="Where assets go">${assetDestinationsHtml()}</section>` : ''}
      ${estimate && (routeCount || manualQuoteCount) ? `<details class="drawer funding-extra" open><summary><span>Pair tokens</span><strong>${routeCount + manualQuoteCount} item${routeCount + manualQuoteCount === 1 ? '' : 's'}</strong></summary>${renderQuoteAcquirePanel()}</details>` : ''}
      <div class="launch-phase-actions">
        <button class="primary-button" type="button" data-next-fact hidden></button>
      </div>
    </section>
    <section class="classic-workspace-section classic-workspace-execute" data-classic-workspace="mint">
      <section class="launch-step-guide irreversible" aria-labelledby="mintStepTitle">
        <div>
          <h2 id="mintStepTitle">Create token</h2>
          <p>${config.token.sealedLaunch
            ? 'Mints the supply and removes mint and freeze control. The name and logo stay hidden until the pool is locked.'
            : 'Mints the supply and removes mint and freeze control.'}</p>
        </div>
        ${state.demoActive ? '' : `<aside><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span><strong>Can't be undone.</strong> Fix mistakes in Token &amp; pools first.</span></aside>`}
      </section>
      <div class="launch-fact-grid">
        <span><small>Name</small><strong>${escapeHtml(config.token.name || 'Untitled')}</strong></span>
        <span><small>Symbol</small><strong>${escapeHtml(config.token.symbol || 'TOK')}</strong></span>
        <span><small>Supply</small><strong>${escapeHtml(String(config.token.supply || '0'))}</strong></span>
        <span><small>Contract address</small><strong>${escapeHtml(state.selectedVanityPublicKey ? shortAddress(state.selectedVanityPublicKey) : 'Random')}</strong></span>
      </div>
      ${readinessPanel({
        title: tokenComplete ? 'Token created' : mintEndpoint === '/api/finish-token-creation' ? 'Finish interrupted token' : 'Create token',
        detail: tokenComplete ? 'Mint and freeze control are removed.' : mintEndpoint === '/api/finish-token-creation' ? 'The token was started but not finished. This finishes the same token; it does not make a new one.' : 'Checks the wallet, funding and token details first.',
        canRun: mintCanRun,
        runLabel: mintEndpoint === '/api/finish-token-creation' ? 'Finish token safely' : 'Create token',
        complete: tokenComplete,
        endpoint: mintEndpoint,
        primary: true,
      })}
    </section>
    <section class="classic-workspace-section classic-workspace-execute" data-classic-workspace="liquidity">
      <section class="launch-step-guide irreversible" aria-labelledby="liquidityStepTitle">
        <div>
          <h2 id="liquidityStepTitle">Create &amp; lock liquidity</h2>
        </div>
        <aside><i class="fa-solid fa-lock" aria-hidden="true"></i><span><strong>Can't be undone.</strong> If it stops partway, it resumes where it stopped.</span></aside>
      </section>
      <div class="launch-fact-grid">
        <span><small>Pools</small><strong>${poolCount}</strong></span>
        <span><small>Positions</small><strong>${sliceCount}</strong></span>
        ${ladderCount ? `<span><small>Extra price bands</small><strong>${ladderCount}</strong></span>` : ''}
        ${topology.pools.some((pool) => pool.support?.enabled) ? '<span><small>Buy support</small><strong>On</strong></span>' : ''}
      </div>
      ${readinessPanel({
        title: metadataRevealPending ? 'Reveal the name and logo' : liquidityComplete ? 'Liquidity created and locked' : 'Create and lock liquidity',
        detail: metadataRevealPending
          ? 'Liquidity is locked. Publish the name, symbol and logo, then lock them for good.'
          : liquidityComplete ? 'Pools are open and positions are locked.' : 'Takes a few minutes. Keep Trebuchet open.',
        canRun: metadataRevealPending ? revealCanRun : liquidityCanRun,
        runLabel: metadataRevealPending ? 'Reveal & lock identity' : readiness?.nextEndpoint === '/api/resume-launch' ? 'Resume missing work' : 'Create liquidity',
        complete: liquidityComplete && !metadataRevealPending,
        endpoint: metadataRevealPending ? '/api/reveal-sealed-metadata' : readiness?.nextEndpoint === '/api/resume-launch' ? '/api/resume-launch' : '/api/create-lp',
        primary: true,
      })}
      <details class="drawer phase-tree-drawer">
        <summary><span>Each position</span><strong>${poolCount} pool${poolCount === 1 ? '' : 's'} / ${sliceCount} position${sliceCount === 1 ? '' : 's'}</strong></summary>
        <div class="phase-tree">${renderClassicPhaseTree(topology)}</div>
      </details>
    </section>
    <section class="classic-workspace-section classic-workspace-verify" data-classic-workspace="finish">
      ${completedJournal && !finalSweepComplete ? '<h2 class="visually-hidden" id="finishStepTitle">Launch complete</h2>' : `<section class="launch-step-guide ${finalSweepComplete ? 'is-complete' : ''}" aria-labelledby="finishStepTitle">
        <div>
          <h2 id="finishStepTitle">${practiceComplete ? 'Test launch complete' : finalSweepComplete ? 'Launch complete' : 'Finish launch'}</h2>
          <p>${practiceComplete ? 'Every step ran. Nothing was sent.' : finalSweepComplete ? 'Everything is in the return wallet and the launch wallet is empty.' : 'Send the remaining assets to the return wallet and save the launch record.'}</p>
        </div>
        ${practiceComplete ? '' : `<aside><i class="fa-solid ${finalSweepComplete ? 'fa-check' : finishDestinationReady ? 'fa-flag-checkered' : 'fa-wallet'}" aria-hidden="true"></i><span>${finalSweepComplete ? 'Launch record ready.' : !finishDestinationReady ? 'Return wallet needed below.' : finishCanRun ? 'Ready for the final sweep.' : 'Fix the item below.'}</span></aside>`}
      </section>`}
      ${practiceComplete ? renderPracticeResultPanel() : ''}
      ${completedJournal && !finalSweepComplete ? renderLaunchCompleteCard(completedJournal) : ''}
      ${!completedJournal && !finalSweepComplete && !finishDestinationReady ? renderFundingWalletHint({ compact: true }) : ''}
      ${!finalSweepComplete && finishDestinationReady ? readinessPanel({
        title: 'Send everything to the return wallet',
        detail: 'Fee Keys, airdrops, leftover tokens and SOL. The return wallet is checked again first.',
        canRun: finishCanRun,
        runLabel: 'Run final sweep',
        complete: false,
        endpoint: '/api/transfer-assets',
        primary: true,
        finalizationIssue: executeNextTransferFinalizationIssue(readiness, config),
      }) : ''}
      ${(completedJournal && !finalSweepComplete) || practiceComplete ? '' : `<details class="drawer launch-proof-details" ${finalSweepComplete ? 'open' : ''}>
        <summary><span>Launch record</span><strong>${finalSweepComplete ? 'Ready' : 'Not ready'}</strong></summary>
        ${renderFinalizationPanel()}
      </details>`}
      ${!finalSweepComplete && !completedJournal ? `<details class="drawer launch-recovery-details">
        <summary><span>Interrupted launch or refund</span><strong>Open recovery actions</strong></summary>
        ${renderCancelRefundPanel(config)}
      </details>
      <div class="launch-phase-secondary"><button class="text-button" type="button" data-view="history"><i class="fa-solid fa-life-ring"></i> Open full recovery history</button></div>` : ''}
    </section>
  `;
  // Balance polling and other async refreshes rebuild this bridge directly.
  // Reapply the active workspace immediately so only one launch phase is visible.
  renderLaunchWorkspace();
}
