import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (name) => fs.readFileSync(new URL(`../public/v2/features/${name}`, import.meta.url), 'utf8');
const between = (source, start, end) => source.slice(source.indexOf(start), end ? source.indexOf(end) : undefined);
const coins = read('discovery/coins.js'), recovery = read('recovery/view.js'), sweep = read('recovery/sweep.js'), events = read('shell/events.js');
const html = (value) => String(value ?? '');
const plan = { tokenMint: 'mint-a', recipients: Array.from({ length: 52 }, (_, index) => ({ wallet: `w${index}`, tokens: '10' })) };

test('the coin page counts airdrop wallets as they land, then says the sweep is next', () => {
  const state = { sweepAirdropProgress: null };
  const context = vm.createContext({ state, Math });
  vm.runInContext(between(coins, 'function coinSweepProgressText', 'function continueCoinStep'), context);
  const delivered = new Set(['w0', 'w1']);
  assert.match(context.coinSweepProgressText('wallet-a', plan, delivered), /2 of 52 wallets sent/);
  state.sweepAirdropProgress = { publicKey: 'wallet-a', status: 'running', completed: 7, failedCount: 1 };
  assert.match(context.coinSweepProgressText('wallet-a', plan, delivered), /9 of 52 wallets sent, 1 failed\. About \d+ min left/);
  state.sweepAirdropProgress = { publicKey: 'wallet-b', status: 'running', completed: 40 };
  assert.match(context.coinSweepProgressText('wallet-a', plan, delivered), /2 of 52/, 'another wallet\'s count is not shown');
  state.sweepAirdropProgress = { publicKey: 'wallet-a', status: 'done', completed: 50, failedCount: 0 };
  assert.match(context.coinSweepProgressText('wallet-a', plan, delivered), /52 of 52 wallets sent\. Now sweeping every token and SOL/);
  assert.match(context.coinSweepProgressText('wallet-a', null, delivered), /^Sweeping every token and SOL/);
});

test('the sweep reads the airdrop count until it ends and stops reading after', async () => {
  let reads = 0;
  const state = { sweepingWalletPublicKey: 'wallet-a', activeView: 'coins', apiClient: { getAirdropProgress: async () => {
    reads += 1; if (reads === 2) state.sweepingWalletPublicKey = null; return { status: 'running', completed: reads };
  } } };
  let renders = 0;
  const context = vm.createContext({ state, Promise, renderCoins: () => { renders += 1; }, setTimeout: (run) => run() });
  vm.runInContext(between(sweep, 'async function followSweepAirdropProgress'), context);
  await context.followSweepAirdropProgress('wallet-a');
  assert.equal(reads, 2); assert.equal(renders, 1);
  assert.deepEqual({ ...state.sweepAirdropProgress }, { status: 'running', completed: 1, publicKey: 'wallet-a' });
});

function recoveryHarness({ journals, pendingWallets = [] }) {
  const state = { apiStatus: 'connected', recovery: { journals, pendingWallets }, recoveryActionId: null };
  const context = vm.createContext({
    state, escapeHtml: html, formatDate: () => 'today', stateClass: html, shortAddress: (value) => value.slice(0, 4), humanizeStage: (value) => value.replace(/_/g, ' '),
    isTerminalJournal: (journal) => ['completed', 'archived'].includes(journal.status), canResumeJournal: () => true,
    recoveryWalletsNeedingAttention: () => pendingWallets,
  });
  vm.runInContext(between(recovery, 'function recoveryCoinMint', 'function renderHistory()'), context);
  return context;
}

test('Recovery lists unfinished launches and opens each one on its coin page', () => {
  const context = recoveryHarness({
    journals: [
      { id: 'j1', walletPublicKey: 'wallet-a', status: 'active', stage: 'airdrop_started', token: { mint: 'mint-a', symbol: 'TREB' } },
      { id: 'j2', walletPublicKey: 'wallet-b', status: 'failed', stage: 'token_create_failed', launchConfig: { token: { symbol: 'NEW' } } },
      { id: 'j3', walletPublicKey: 'wallet-c', status: 'completed', stage: 'transfer_completed', token: { mint: 'mint-c' } },
    ],
    pendingWallets: [{ publicKey: 'wallet-a' }, { publicKey: 'wallet-z' }],
  });
  const page = context.renderRecoveryList();
  assert.match(page, /2 unfinished launches/);
  assert.match(page, /data-action="open-coin-mint" data-mint="mint-a"><span>Open TREB/);
  assert.match(page, /data-action="resume-journal" data-journal-id="j2"\s*><span>Continue creating the token/);
  assert.doesNotMatch(page, /mint-c/);
  assert.doesNotMatch(page, /sweep-recovery-wallet|continue-journal-finish|run-v2-airdrop/);
  assert.match(page, /1 old launch wallet with no launch record/, 'a wallet with a launch is not counted twice');
});

test('Recovery says so when nothing is left', () => {
  assert.match(recoveryHarness({ journals: [] }).renderRecoveryList(), /Nothing to recover/);
});

test('the Recovery button opens the coin page of a live coin', () => {
  const handler = between(events, "  if (action === 'inspect-recovery') {", "  if (action === 'inspect-recovery-record')");
  const calls = [];
  const run = (proof) => {
    const context = vm.createContext({ state: {}, calls, currentLaunchProof: () => proof, proofTokenMint: (value) => value?.mint || null,
      isDemoLaunchProof: (value) => Boolean(value?.demo), openCoinByMint: (mint) => calls.push(['coin', mint]),
      renderHistoryPanes: () => {}, setView: (view) => calls.push(['view', view]) });
    vm.runInContext(`(function (action) {\n${handler}\n})('inspect-recovery')`, context);
  };
  run({ mint: 'mint-a' }); run({ mint: 'mint-b', demo: true }); run(null);
  assert.deepEqual(calls, [['coin', 'mint-a'], ['view', 'history'], ['view', 'history']]);
});
