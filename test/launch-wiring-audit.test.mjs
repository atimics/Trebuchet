import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createLaunchJournalStore } from '../packages/core/src/launch-journal.js';
import {
  v2TransferHasWalletEmptyFinalSweepEvidence as coreTransferWalletEmptyEvidence,
  v2TransferSweepErrorCount as coreTransferSweepErrorCount,
} from '../packages/core/src/v2-execution-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const serverSrc = readFileSync(path.join(REPO, 'server.js'), 'utf8');
const serviceSrc = readFileSync(path.join(REPO, 'launchExecution.js'), 'utf8');
const lpSrc = readFileSync(path.join(REPO, 'lpService.js'), 'utf8');
// The journal contract moved into @trebuchet/core; the app-level
// launchJournal.js is a thin adapter. Audit the Core module's source.
const journalSrc = readFileSync(path.join(REPO, 'packages/core/src/launch-journal.js'), 'utf8');
const coreExecSrc = readFileSync(path.join(REPO, 'packages/core/src/v2-execution-context.js'), 'utf8');

function loadV2ServerFingerprintHarness() {
  const start = serverSrc.indexOf('function v2ProofPositionCount');
  const end = serverSrc.indexOf('\nfunction v2TransferFinalizationIssue', start);
  assert.ok(start >= 0 && end > start, 'v2 server fingerprint helpers must be extractable');
  // The transfer-evidence helpers moved into Core; seed the sandbox with the
  // real implementations so the extracted slice resolves them.
  const sandbox = {
    String, Number, Array, JSON, Math,
    v2TransferHasWalletEmptyFinalSweepEvidence: coreTransferWalletEmptyEvidence,
    v2TransferSweepErrorCount: coreTransferSweepErrorCount,
  };
  vm.runInNewContext(
    [
      serverSrc.slice(start, end),
      'globalThis.v2LaunchProofFingerprint = v2LaunchProofFingerprint;',
      'globalThis.v2LaunchDataProofFingerprint = v2LaunchDataProofFingerprint;',
      'globalThis.v2TransferHasFinalSweepEvidence = v2TransferHasFinalSweepEvidence;',
      'globalThis.v2TransferHasWalletEmptyFinalSweepEvidence = v2TransferHasWalletEmptyFinalSweepEvidence;',
      'globalThis.v2AirdropDeliveryEvidenceState = v2AirdropDeliveryEvidenceState;',
      'globalThis.v2LaunchDataAirdropCompletionStatus = v2LaunchDataAirdropCompletionStatus;',
      'globalThis.v2LaunchDataReportCompletenessState = v2LaunchDataReportCompletenessState;',
    ].join('\n'),
    sandbox,
    { filename: 'server.js v2 fingerprint harness' },
  );
  return sandbox;
}

// ---------------------------------------------------------------------------
// Wiring-audit regression tests (ladder / prealloc / airdrop / support).
//
// Source-level assertions, matching the repo's test pattern (server.js
// boots Express on import, so importing it from tests is off the table).
// Each test pins a wiring contract whose absence was a real, found bug:
//
//   1. The journal's event-replay (applyLpEventToResults) must cover ALL
//      position types — support locks were missing, so a crash-resume
//      re-attempted locks against escrowed position NFTs.
//   2. Lock events must carry feeKeyNftMint so crash-resumed launches keep
//      the Fee Key (Phase 4 transfers it; the audit record publishes it).
//   3. The airdrop must be per-recipient idempotent across transfer
//      re-runs — the transfer endpoint is legitimately re-runnable after a
//      partial failure, and re-running used to re-pay every recipient.
//   4. The airdrop plan and result must survive an app restart via the
//      journal, or a resumed launch silently skips its configured airdrop
//      and loses the report's delivered/failed record.
// ---------------------------------------------------------------------------

// The transfer-assets route is a named handler; slice its function body.
function transferAssetsHandlerSource() {
  const start = serviceSrc.indexOf('async function transferAssets(');
  assert.ok(start >= 0, 'transferAssets service must exist');
  const end = serviceSrc.indexOf('\n  }\n', start);
  return serviceSrc.slice(start, end);
}

test('journal replay covers support locks (and keys on supportIndex)', () => {
  assert.ok(
    /if \(event\.stage === 'support_lock_done'[^)]*\) \{\r?\n\s*const pos = positionForIndex\(result\.supportPositions, 'supportIndex', event\.supportIndex\);/.test(coreExecSrc),
    'applyLpEventToResults must handle support_lock_done by supportIndex',
  );
});

test('lock events carry feeKeyNftMint end to end', () => {
  // Emitter side: all four lock_done events include the recorded mint.
  for (const [stage, v] of [
    ['main_lock_done', 'pos'],
    ['ladder_lock_done', 'lp'],
    ['support_lock_done', 'sp'],
    ['bootstrap_lock_done', 'bs'],
  ]) {
    const re = new RegExp(
      `stage: '${stage}',[\\s\\S]{0,300}?feeKeyNftMint: ${v}\\.feeKeyNftMint,`,
    );
    assert.ok(re.test(lpSrc), `${stage} event must carry feeKeyNftMint`);
  }
  // Journal side: every lock handler applies it (4 handlers).
  const applies = coreExecSrc.match(/feeKeyNftMint = event\.feeKeyNftMint \|\|/g) || [];
  assert.ok(applies.length >= 4, `journal handlers must apply feeKeyNftMint (found ${applies.length}/4)`);
});

test('bootstrap_open_done keeps the tick range through the journal', () => {
  assert.ok(
    /stage: 'bootstrap_open_done',[\s\S]{0,300}?tickLower: bsTicks\.tickLower,/.test(lpSrc),
    'bootstrap_open_done event must carry the tick range',
  );
  assert.ok(
    /event\.stage === 'bootstrap_open_done'[\s\S]{0,600}?tickLower: Number\.isFinite\(event\.tickLower\)/.test(coreExecSrc),
    'journal handler must keep the bootstrap tick range',
  );
});

test('airdrop is a first-class journal field (survives normalizeJournal)', () => {
  assert.ok(
    /airdrop: raw\.airdrop && typeof raw\.airdrop === 'object' \? raw\.airdrop : null,/.test(journalSrc),
    'normalizeJournal must preserve journal.airdrop — it whitelists keys, so an unknown key is dropped on the next load()',
  );
});

test('transfer-assets airdrop step skips recipients already delivered', () => {
  // Reads the journal record, filters by delivered wallet set, and runs
  // executeAirdrop with the pending subset only.
  assert.ok(
    /const priorAirdrop = launchJournal\.activeForWallet\(walletPublicKey\)\?\.airdrop \|\| null;[\s\S]{0,700}?const pendingRecipients = input\.airdrop\.recipients\.filter\(/.test(serviceSrc),
    'transfer airdrop must filter against the journal delivered record',
  );
  assert.ok(
    /recipients: pendingRecipients,[\s\S]{0,200}?onProgress: \(s\) => airdropProgressStep/.test(serviceSrc),
    'executeAirdrop must receive the pending subset, not the raw request list',
  );
  // The persistent per-recipient record is written at completion.
  assert.ok(
    /\{ airdrop: airdropResult \},[\s\S]{0,200}?stage: 'airdrop_completed',/.test(serviceSrc),
    'completion must persist the merged record on journal.airdrop',
  );
  // The all-delivered fast path skips execution entirely.
  assert.ok(
    /airdrop_skipped_already_delivered/.test(serviceSrc),
    'a fully-delivered re-run must skip the airdrop with a journal event',
  );
});

test('retry-airdrop dedupes, merges, and returns the merged record', () => {
  // The handler was extracted to a named function when /api/run-airdrop
  // was added as an alias — anchor on the function, not the route line.
  assert.match(serverSrc, /launchServices\.runAirdrop\(req\.body\)/);
  const retryStart = serviceSrc.indexOf('async function runAirdrop(');
  assert.ok(retryStart >= 0);
  const retry = serviceSrc.slice(retryStart, retryStart + 7000);
  assert.ok(
    /const pendingRecipients = recipients\.filter\(\(r\) => !deliveredWallets\.has\(r\.wallet\)\);/.test(retry),
    'retry must drop wallets the journal already records as delivered',
  );
  assert.ok(
    /const mergedAirdrop = \{/.test(retry) && /\{ airdrop: mergedAirdrop \},/.test(retry),
    'retry must persist the merged record on journal.airdrop',
  );
  assert.ok(
    /return \{ success: true, airdrop: mergedAirdrop \};/.test(retry),
    'retry response must return the merged record',
  );
});

test('classic resume materializes recoverable Phase 1 pool events before retrying', () => {
  assert.match(serverSrc, /app\.post\('\/api\/resume-launch', resumeLaunchHandler\);/);
  const resumeStart = serviceSrc.indexOf('async function resumeLiquidity(');
  assert.ok(resumeStart >= 0, 'resume-launch handler must exist');
  const resumeSrc = serviceSrc.slice(resumeStart, serviceSrc.indexOf('async function transferAssets(', resumeStart));
  assert.ok(
    /const activeJournal = launchJournal\.activeForWallet\(walletPublicKey\);/.test(resumeSrc),
    'resume-launch must inspect the active journal before starting another attempt',
  );
  assert.ok(
    /materializePhase1RecoveryResults\(\s*activeJournal \|\| \{\},\s*priorResults,\s*allocations,\s*\)/.test(resumeSrc),
    'resume-launch must materialize incomplete Phase 1 pool state from journal events',
  );
  assert.ok(
    /effectivePriorResults = mergePriorResults\(priorResults, phase1Recovery\.recoveredResults\)/.test(resumeSrc),
    'resume-launch must pass recovered Phase 1 entries as priorResults',
  );
  assert.ok(
    /lp_phase1_recovery_prepared/.test(resumeSrc),
    'resume-launch must journal that Phase 1 recovery was prepared',
  );
  assert.ok(
    /code: 'UNSAFE_PARTIAL_POOL_STATE'/.test(resumeSrc) &&
      /manualRecoveryRequired: true/.test(resumeSrc),
    'ambiguous partial pool state must still produce a structured non-retryable response',
  );
});

test('Meteora recovery journal stores original per-allocation intent and preserves the pool plan', () => {
  const configDir = mkdtempSync(path.join(tmpdir(), 'trebuchet-meteora-intent-'));
  try {
    const filePath = path.join(configDir, 'launchJournals.json');
    const launchJournal = createLaunchJournalStore({ filePath });
    const wallet = 'Wallet1111111111111111111111111111111111';
    launchJournal.start({ walletPublicKey: wallet });
    launchJournal.upsertForWallet(wallet, {
      poolPlan: { tokenMint: 'Mint111', allocations: [{ venue: 'meteora-damm-v2' }] },
    });

    const recordStart = serverSrc.indexOf('function recordLpJournalProgress(');
    const recordEnd = serverSrc.indexOf('\nfunction mergePriorResults(', recordStart);
    assert.ok(recordStart >= 0 && recordEnd > recordStart, 'journal progress handler must be extractable');
    const sandbox = {
      launchJournal,
      journalResultList: () => [],
      applyLpEventToResults: () => false,
    };
    vm.runInNewContext(
      `${serverSrc.slice(recordStart, recordEnd)}\nglobalThis.recordLpJournalProgress = recordLpJournalProgress;`,
      sandbox,
      { filename: 'server.js Meteora journal handler' },
    );

    const intent = {
      tokenMint: 'Mint111',
      quoteMint: 'So11111111111111111111111111111111111111112',
      positionNft: 'Position111',
      supplyRaw: '800000000000000000',
      startingMarketCapLamports: '25000000',
      rangeMultiple: 1000,
    };
    sandbox.recordLpJournalProgress(wallet, {
      stage: 'meteora_pool_start',
      allocationIndex: 0,
      poolIntent: intent,
    });

    const reloadedJournal = createLaunchJournalStore({ filePath }).activeForWallet(wallet);
    assert.equal(reloadedJournal.poolPlan.tokenMint, 'Mint111');
    assert.deepEqual(reloadedJournal.poolPlan.allocations, [{ venue: 'meteora-damm-v2' }]);
    assert.deepEqual(reloadedJournal.poolPlan.meteoraPoolIntents[0], intent);
    assert.equal(reloadedJournal.events.at(-1).stage, 'meteora_pool_start');
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test('Phase 1 recovery materializer reconstructs opened slices and blocks duplicate pool ids', () => {
  assert.ok(
    /function materializePhase1RecoveryResults\(journal, priorResults, allocations\)/.test(serverSrc),
    'server must have a journal-event materializer for legacy Phase 1 failures',
  );
  assert.ok(
    /phase1Incomplete: true/.test(serverSrc) &&
      /recoveredFrom: 'journal_events'/.test(serverSrc),
    'materialized entries must be explicitly marked as incomplete Phase 1 recovery',
  );
  assert.ok(
    /latestEventsByIndex\(\s*journal\.events,\s*'main_open_done',\s*'sliceIndex',\s*allocationIndex,\s*\)/.test(serverSrc),
    'materializer must replay recorded main_open_done events by slice index',
  );
  assert.ok(
    /multiple created pools recorded for one allocation/.test(serverSrc),
    'materializer must block ambiguous duplicate pool creations',
  );
});

test('/api/run-airdrop aliases the idempotent airdrop handler', () => {
  assert.ok(
    /app\.post\('\/api\/run-airdrop', runAirdropHandler\);/.test(serverSrc.replace(/\//g, '\/'))
      || /app\.post\('\/api\/run-airdrop', runAirdropHandler\);/.test(serverSrc),
    'run-airdrop route must exist',
  );
  assert.ok(
    /app\.post\('\/api\/retry-airdrop', runAirdropHandler\);/.test(serverSrc),
    'retry-airdrop must share the same handler',
  );
});

test('publish endpoint is journal-idempotent by proof fingerprint', () => {
  assert.ok(
    /reportPublish: raw\.reportPublish && typeof raw\.reportPublish === 'object' \? raw\.reportPublish : null,/.test(journalSrc),
    'normalizeJournal must preserve journal.reportPublish',
  );
  assert.ok(
    /const reportJournal = launchJournalForReport\(walletPublicKey, launchData\);/.test(serverSrc)
      && /function launchJournalForReport\(walletPublicKey, launchData = \{\}\)/.test(serverSrc)
      && /const exact = launchJournal\.get\(requestedId\)/.test(serverSrc)
      && /const prior = reportJournal\?\.reportPublish;/.test(serverSrc),
    'publish endpoint must check the proof-bound non-archived journal before uploading',
  );
  assert.ok(
    /launchJournal\.update\(reportJournal\.id, reportPublishPatch, reportPublishEvent\)/.test(serverSrc),
    'publish endpoint must update a completed matching journal by id instead of creating a new active journal',
  );
  assert.ok(
    /priorFingerprint === reportProofFingerprint/.test(serverSrc),
    'reusing a report must require a matching proof fingerprint',
  );
  assert.ok(
    /prior report for \$\{mint\} belongs to a different proof/.test(serverSrc),
    'a prior report for another proof must not be accepted as current',
  );
  assert.ok(
    /proofFingerprint: reportProofFingerprint/.test(serverSrc),
    'a successful publish must record the proof fingerprint in the journal',
  );
  assert.ok(
    /alreadyPublished: true/.test(serverSrc),
    'matching re-requests must return the recorded URIs',
  );
});

test('v2 report publish blocks incomplete airdrops before upload', () => {
  assert.ok(
    /if \(launchData\?\.source === 'trebuchet-v2'\)/.test(serverSrc),
    'publish endpoint must identify v2 report requests',
  );
  assert.ok(
    /const launchDataProofFingerprint = typeof launchData\?\.proofFingerprint === 'string'/.test(serverSrc),
    'v2 publish must read the proof fingerprint from the uploaded launch data',
  );
  assert.ok(
    /reason: 'missing-proof-fingerprint'/.test(serverSrc),
    'v2 publish must reject report envelopes without a proof fingerprint',
  );
  assert.ok(
    /requestProofFingerprint && requestProofFingerprint !== launchDataProofFingerprint/.test(serverSrc),
    'v2 publish must reject mismatched request and launch-data fingerprints',
  );
  assert.ok(
    /reason: 'proof-fingerprint-mismatch'/.test(serverSrc),
    'mismatched v2 fingerprints must return an explicit stale proof result',
  );
  assert.ok(
    /reportProofFingerprint = launchDataProofFingerprint;/.test(serverSrc),
    'v2 publish must journal the fingerprint bound to the uploaded launch data',
  );
  assert.ok(
    /const airdropStatus = v2LaunchDataAirdropCompletionStatus\(launchData\);/.test(serverSrc),
    'publish endpoint must derive v2 airdrop completion from launch data',
  );
  assert.ok(
    /airdropIncomplete: true/.test(serverSrc),
    'incomplete v2 airdrops must return an explicit skipped result',
  );
  assert.ok(
    /airdrop-proof-missing:\$\{airdropStatus\.missing\.join/.test(serverSrc),
    'missing exact v2 airdrop proof must be reported before upload',
  );
  assert.ok(
    /airdrop-pending:\$\{airdropStatus\.pending\}/.test(serverSrc),
    'pending v2 airdrops must be reported before upload',
  );
  assert.ok(
    /airdrop-failed:\$\{airdropStatus\.failed\}/.test(serverSrc),
    'failed v2 airdrops must be reported before upload',
  );
  assert.ok(
    serverSrc.indexOf('v2LaunchDataAirdropCompletionStatus(launchData)') <
      serverSrc.indexOf('const { secretKeyArr } = resolveSigner'),
    'v2 airdrop completion must be checked before resolving the signer and uploading',
  );
  assert.ok(
    /Array\.isArray\(airdrop\.transferred\) \? airdrop\.transferred\.length : 0/.test(serverSrc),
    'v2 publish airdrop completion must account for delivered transfer rows',
  );
  assert.ok(
    /function v2AirdropDeliveryEvidenceState\(airdrop = \{\}\)/.test(serverSrc),
    'v2 publish must use exact airdrop row/signature evidence, not only counts',
  );
  assert.ok(
    /const derivedProofFingerprint = v2LaunchDataProofFingerprint\(launchData\);/.test(serverSrc),
    'v2 publish must recompute the proof fingerprint from launch data',
  );
  assert.ok(
    /reason: 'launch-data-proof-fingerprint-mismatch'/.test(serverSrc),
    'v2 publish must reject envelopes whose launch data does not derive the claimed fingerprint',
  );
  assert.ok(
    serverSrc.indexOf('v2LaunchDataProofFingerprint(launchData)') <
      serverSrc.indexOf('const { secretKeyArr } = resolveSigner'),
    'v2 launch-data fingerprint must be verified before resolving the signer and uploading',
  );
});

test('v2 server derives report fingerprints from launchData evidence', () => {
  const {
    v2LaunchDataProofFingerprint,
    v2LaunchProofFingerprint,
    v2TransferHasFinalSweepEvidence,
    v2TransferHasWalletEmptyFinalSweepEvidence,
    v2LaunchDataAirdropCompletionStatus,
    v2LaunchDataReportCompletenessState,
  } = loadV2ServerFingerprintHarness();
  const launchData = {
    source: 'trebuchet-v2',
    launchWallet: 'WalletReport11111111111111111111111111111111',
    destinationWallet: 'DestReport111111111111111111111111111111111',
    transfer: {
      status: 'planned-before-sweep',
      destinationWallet: 'WrongPlannedDest11111111111111111111111111',
    },
    mint: 'MintReport111111111111111111111111111111111',
    token: {
      mint: 'MintReport111111111111111111111111111111111',
      authorities: {
        mintAuthorityRenounced: true,
        freezeAuthorityDisabled: true,
        metadataUpdateAuthorityRevoked: true,
        metadataImmutable: true,
      },
    },
    pools: [{
      poolId: 'PoolReport111111111111111111111111111111111',
      quoteMint: 'QuoteReport11111111111111111111111111111111',
      supplyPercent: 42.5,
      tickSpacing: 60,
      initialPrice: '0.00042',
      launchedSide: 'base',
      createPoolTx: 'CreatePoolReport111111111111111111111111111',
      positions: [{
        type: 'main',
        positionNftMint: 'PositionReport111111111111111111111111111',
        feeKeyNftMint: 'FeeKeyReport1111111111111111111111111111',
        locked: true,
        tickLower: -443640,
        tickUpper: 443640,
      }],
    }],
    liquidity: {
      positionCount: 1,
      lockedPositionCount: 1,
      feeKeyCount: 1,
    },
    airdrop: {
      plannedRecipientCount: 1,
      deliveredCount: 1,
      failedCount: 0,
      recipients: [{ wallet: 'DropReport1111111111111111111111111111111', tokens: 100 }],
      transferred: [{ wallet: 'DropReport1111111111111111111111111111111', tokens: 100, txId: 'DropTxReport111111111111111111111111111111' }],
      failed: [],
    },
  };
  const proof = {
    walletPublicKey: launchData.launchWallet,
    destinationWallet: launchData.destinationWallet,
    transfer: launchData.transfer,
    token: {
      mint: launchData.mint,
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
      metadataUpdateAuthorityRevoked: true,
      metadataImmutable: true,
    },
    liquidity: {
      poolIds: [launchData.pools[0].poolId],
      positionCount: 1,
      lockedPositionCount: 1,
      feeKeyCount: 1,
      results: [{
        poolId: launchData.pools[0].poolId,
        quoteMint: launchData.pools[0].quoteMint,
        supplyPercent: launchData.pools[0].supplyPercent,
        tickSpacing: launchData.pools[0].tickSpacing,
        initialPrice: launchData.pools[0].initialPrice,
        launchedSide: launchData.pools[0].launchedSide,
        createPoolTx: launchData.pools[0].createPoolTx,
        mainPositions: [{
          positionNftMint: launchData.pools[0].positions[0].positionNftMint,
          feeKeyNftMint: launchData.pools[0].positions[0].feeKeyNftMint,
          locked: true,
          tickLower: -443640,
          tickUpper: 443640,
        }],
      }],
    },
    airdrop: launchData.airdrop,
  };
  const fromLaunchData = v2LaunchDataProofFingerprint(launchData);
  const fromProof = v2LaunchProofFingerprint(proof);
  const fingerprint = JSON.parse(fromLaunchData);
  const zeroLiquidityProof = {
    ...proof,
    liquidity: {
      ...proof.liquidity,
      positionCount: 0,
      lockedPositionCount: 0,
      feeKeyCount: 0,
    },
  };
  const zeroLiquidityFingerprint = JSON.parse(v2LaunchProofFingerprint(zeroLiquidityProof));

  assert.equal(fromLaunchData, fromProof);
  assert.equal(fingerprint.mint, launchData.mint);
  assert.equal(fingerprint.destinationWallet, launchData.destinationWallet);
  assert.equal(v2TransferHasFinalSweepEvidence(launchData.transfer), false);
  assert.equal(v2TransferHasWalletEmptyFinalSweepEvidence(launchData.transfer), false);
  assert.equal(fingerprint.positionCount, 1);
  assert.equal(fingerprint.lockedPositionCount, 1);
  assert.equal(fingerprint.feeKeyCount, 1);
  assert.equal(fingerprint.positions[0].positionNftMint, launchData.pools[0].positions[0].positionNftMint);
  assert.notEqual(fingerprint.airdrop.transferredHash, '00000000');
  assert.equal(zeroLiquidityFingerprint.positionCount, 0);
  assert.equal(zeroLiquidityFingerprint.lockedPositionCount, 0);
  assert.equal(zeroLiquidityFingerprint.feeKeyCount, 0);

  const terminalTransferData = {
    ...launchData,
    destinationWallet: 'ConfigDestReport11111111111111111111111111111',
    transfer: {
      destinationWallet: 'TerminalDestReport1111111111111111111111111',
      walletEmpty: true,
    },
  };
  const terminalFingerprint = JSON.parse(v2LaunchDataProofFingerprint(terminalTransferData));
  assert.equal(v2TransferHasFinalSweepEvidence(terminalTransferData.transfer), true);
  assert.equal(v2TransferHasWalletEmptyFinalSweepEvidence(terminalTransferData.transfer), true);
  assert.equal(terminalFingerprint.destinationWallet, terminalTransferData.transfer.destinationWallet);

  const partialTransferData = {
    ...launchData,
    destinationWallet: 'ConfigDestReport11111111111111111111111111111',
    transfer: {
      destinationWallet: 'PartialDestReport111111111111111111111111111',
      tokenSweep: {
        transferred: [{
          mint: launchData.mint,
          amount: '100',
          txId: 'PartialSweepTxReport111111111111111111111111',
        }],
        errors: [],
      },
    },
  };
  const partialFingerprint = JSON.parse(v2LaunchDataProofFingerprint(partialTransferData));
  assert.equal(v2TransferHasFinalSweepEvidence(partialTransferData.transfer), true);
  assert.equal(v2TransferHasWalletEmptyFinalSweepEvidence(partialTransferData.transfer), false);
  assert.equal(partialFingerprint.destinationWallet, partialTransferData.destinationWallet);
  assert.notEqual(partialFingerprint.destinationWallet, partialTransferData.transfer.destinationWallet);

  const countOnlyAirdropData = {
    ...launchData,
    airdrop: {
      plannedRecipientCount: 1,
      deliveredCount: 1,
      failedCount: 0,
      recipients: [],
      transferred: [],
      failed: [],
    },
  };
  const countOnlyStatus = v2LaunchDataAirdropCompletionStatus(countOnlyAirdropData);
  assert.equal(countOnlyStatus.complete, false);
  assert.match(countOnlyStatus.missing.join(','), /airdrop recipient rows/);
  assert.match(countOnlyStatus.missing.join(','), /airdrop delivered rows/);
  assert.match(countOnlyStatus.missing.join(','), /airdrop transaction signatures/);
  const countOnlyCompleteness = v2LaunchDataReportCompletenessState(countOnlyAirdropData);
  assert.equal(countOnlyCompleteness.complete, false);
  assert.ok(countOnlyCompleteness.missing.includes('airdrop recipient rows'));
  assert.ok(countOnlyCompleteness.missing.includes('airdrop delivered rows'));
  assert.ok(countOnlyCompleteness.missing.includes('airdrop transaction signatures'));

  const hashOnlyAirdropData = {
    ...launchData,
    airdrop: {
      plannedRecipientCount: 1,
      deliveredCount: 1,
      failedCount: 0,
      recipientsHash: 'hash-only-recipients',
      transferredHash: 'hash-only-transferred',
      failedHash: 'hash-only-failed',
      recipients: [],
      transferred: [],
      failed: [],
    },
  };
  const hashOnlyStatus = v2LaunchDataAirdropCompletionStatus(hashOnlyAirdropData);
  assert.equal(hashOnlyStatus.complete, false);
  assert.match(hashOnlyStatus.missing.join(','), /full airdrop rows/);

  const zeroDeliveredCountData = {
    ...launchData,
    airdrop: {
      ...launchData.airdrop,
      deliveredCount: 0,
    },
  };
  const zeroDeliveredStatus = v2LaunchDataAirdropCompletionStatus(zeroDeliveredCountData);
  assert.equal(zeroDeliveredStatus.complete, false);
  assert.match(zeroDeliveredStatus.missing.join(','), /airdrop delivered count/);

  const zeroLiquidityCountData = {
    ...launchData,
    liquidity: {
      poolCount: 0,
      positionCount: 0,
      lockedPositionCount: 0,
      feeKeyCount: 0,
    },
  };
  const zeroLiquidityCompleteness = v2LaunchDataReportCompletenessState(zeroLiquidityCountData);
  assert.equal(zeroLiquidityCompleteness.complete, false);
  assert.ok(zeroLiquidityCompleteness.missing.includes('pool count'));
  assert.ok(zeroLiquidityCompleteness.missing.includes('position count'));
  assert.ok(zeroLiquidityCompleteness.missing.includes('lock count'));
  assert.ok(zeroLiquidityCompleteness.missing.includes('fee key count'));
});

test('publish service degrades gracefully on oversized HTML', () => {
  const svcSrc = readFileSync(path.join(REPO, 'launchReportService.js'), 'utf8');
  assert.ok(/HTML_UPLOAD_MAX_BYTES = 95 \* 1024;/.test(svcSrc), 'size guard constant must exist');
  assert.ok(
    /report_html_skipped_oversize/.test(svcSrc),
    'oversized HTML must skip the HTML upload (JSON record still publishes)',
  );
});


test('transfer-assets validates an explicit destination before resolving a saved signer', () => {
  const handler = transferAssetsHandlerSource();
  const validIndex = handler.indexOf('destinationWallet must be a valid Solana address');
  const signerIndex = handler.indexOf('resolveSigner({ tempWalletSecretKey, walletPublicKey: input.walletPublicKey })');
  const funderIndex = handler.indexOf('findFundingWallet(walletPublicKey)');
  const requiredIndex = handler.indexOf('destinationWallet required');
  const unsafeIndex = handler.indexOf('unsafeSweepDestinationReason(destinationWallet');
  const sweepIndex = handler.indexOf('sweepNftsToDestination(');
  assert.ok(validIndex >= 0, 'transfer-assets must reject malformed destinationWallet');
  assert.ok(signerIndex >= 0, 'transfer-assets signer resolution anchor missing');
  assert.ok(validIndex < signerIndex, 'malformed destination must be rejected before signer resolution');
  // A blank destination resolves to the funding wallet, which needs the signer's address.
  assert.ok(signerIndex < funderIndex && funderIndex < requiredIndex, 'blank destination resolves to the funder, else is rejected');
  assert.ok(unsafeIndex > funderIndex && (sweepIndex < 0 || unsafeIndex < sweepIndex), 'unsafe destinations are refused before any sweep');
});

test('transfer-assets response exposes authoritative sweep verification', () => {
  const handler = transferAssetsHandlerSource();

  assert.match(handler, /return \{[\s\S]*?walletEmpty,[\s\S]*?hasPartialFailure,/);
});

test('an existing mint account is adopted instead of re-created forever', () => {
  const tokenServiceSrc = readFileSync(path.join(REPO, 'tokenService.js'), 'utf8');
  // When create-token fails because the mint account already exists (an
  // earlier attempt landed without finishing), the server must adopt the
  // known address so readiness routes to finish-token-creation. Without this
  // the launch dies on "already in use" on every retry.
  assert.match(serviceSrc, /const accountAlreadyInUse = \/already in use\|custom program error: 0x0\/i\.test/);
  assert.match(serviceSrc, /stage: 'token_account_adopted'/);
  assert.match(serviceSrc, /code: 'TOKEN_ACCOUNT_ALREADY_EXISTS'/);
  assert.match(serviceSrc, /token: \{ mint: existingMint \}/);
  // The service surfaces the derived mint address when mint creation fails.
  assert.match(tokenServiceSrc, /if \(derived && !mintError\.tokenMint\) mintError\.tokenMint = derived;/);
});

test('transfer-assets delegates the SOL gate to the orchestrator, wired correctly', () => {
  // The gate LOGIC (straggler pass, SOL gate, gated SOL sweep) lives in
  // sweepOrchestrator.js and has full behavioral branch coverage in
  // test/sweep-orchestration.test.mjs. What THIS pin protects is the
  // wiring: the handler must actually route through the orchestrator with
  // the real collaborators, in the right position (after the token sweep,
  // before the partial-failure accounting), and must not grow a bypassing
  // direct SOL-sweep call.
  const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const handler = transferAssetsHandlerSource(serverSrc);

  const tokenSweepIdx = handler.indexOf('await sweepAllTokensToDestination(');
  const gateCallIdx = handler.indexOf('await finishSweepWithSolGate(');
  assert.ok(gateCallIdx >= 0, 'handler must call finishSweepWithSolGate');
  assert.ok(tokenSweepIdx >= 0 && tokenSweepIdx < gateCallIdx,
    'the gate runs after the first token sweep pass');

  const gateCall = handler.slice(gateCallIdx, gateCallIdx + 900);
  assert.match(gateCall, /sweepNfts: sweepNftsToDestination/);
  assert.match(gateCall, /sweepTokens: sweepAllTokensToDestination/);
  assert.match(gateCall, /sweepSol: sweepSolToDestination/);
  assert.match(gateCall, /checkWalletBalanceMultiToken/);
  assert.match(gateCall, /launchJournal\.recordEvent/);

  // No direct SOL sweep may bypass the gate inside this handler.
  const directSol = handler.indexOf('await sweepSolToDestination(');
  assert.equal(directSol, -1,
    'the handler must not call sweepSolToDestination directly — only via the gate');

  // A skipped SOL sweep must mark the transfer partial, not successful.
  assert.match(handler, /!!solSweepSkipped/,
    'a deliberate SOL-sweep skip must count as a partial failure');
});

test('metadata-authority handoff runs before any sweep and is a hard stop', () => {
  // Keep-authority launches: the handoff signs with the launch wallet, which
  // the sweeps then empty and the completion path destroys. If the handoff
  // ran after any sweeping — or its failure were swallowed — a failed
  // handoff would silently orphan the authority on a doomed key. The
  // handler has no try/catch around it, so a throw aborts the request
  // before anything moves; this pin keeps it that way and in front.
  const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const handler = transferAssetsHandlerSource(serverSrc);

  const handoffIdx = handler.indexOf('await transferMetadataAuthority(');
  const nftIdx = handler.indexOf('await sweepNftsToDestination(');
  assert.ok(handoffIdx >= 0, 'handoff call must exist in the handler');
  assert.ok(nftIdx >= 0);
  assert.ok(handoffIdx < nftIdx, 'handoff must precede the first sweep');
  // Not wrapped: no try between the handoff and the preceding statement
  // that would swallow its throw into a partial result.
  const before = handler.slice(Math.max(0, handoffIdx - 400), handoffIdx);
  assert.doesNotMatch(before, /try\s*\{\s*$/m,
    'the handoff must not be inside a swallowing try block');
});

test('display price and launch price share one on-chain adapter definition', () => {
  // The pool editor's shown price (/api/quote-token-info) and the launch's
  // price (resolveQuoteUsdForCreate) must read pools through the SAME
  // adapter builder, or the number the user sees can silently diverge from
  // the number the launch uses — the exact gap this pin closes.
  const lpSrc = readFileSync(new URL('../lpService.js', import.meta.url), 'utf8');
  const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

  assert.match(lpSrc, /export function onChainPriceDeps\(raydium\)/,
    'the shared adapter builder must exist and be exported');
  // Launch path uses it.
  assert.match(lpSrc, /_launchOnChainPrice\(\{[\s\S]{0,200}deps: onChainPriceDeps\(raydium\)/,
    'the launch path must build its adapters with onChainPriceDeps');
  // Display helper uses it.
  assert.match(lpSrc, /getQuoteTokenOnChainPrice[\s\S]{0,400}onChainPriceDeps\(raydium\)/,
    'the display helper must build its adapters with onChainPriceDeps');
  // The pool list is paged (100/page) and defaults to sort="default"; the
  // adapter must request liquidity-desc so page 1 holds the deepest pools.
  assert.match(lpSrc, /fetchPoolByMints\(\{[\s\S]{0,120}sort: 'liquidity', order: 'desc'/,
    'pool discovery must sort by liquidity desc so the deepest pool is on the fetched page');
  // No second, inline copy of the adapter body anywhere.
  const inlineCopies = (lpSrc.match(/fetchPoolsByMints: async \(m1, m2\)/g) || []).length;
  assert.equal(inlineCopies, 1, 'the fetchPoolsByMints adapter must be defined exactly once');

  // The endpoint calls the display helper and labels the source so the UI
  // can show provenance and depth.
  const ep = serverSrc.indexOf("app.post('/api/quote-token-info'");
  const epBody = serverSrc.slice(ep, ep + 12000);
  assert.match(epBody, /getQuoteTokenOnChainPrice\(/, 'endpoint must consult the on-chain price');
  assert.match(epBody, /priceSource = `on-chain:\$\{oc\.anchorSymbol\}`/, 'endpoint must label the source');
  assert.match(epBody, /priceLiquidityUsd/, 'endpoint must surface depth');
  assert.match(epBody, /priceWarning = oc\.spreadError/, 'endpoint must surface a spread finding, not hide it');
});
