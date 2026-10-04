import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const view = fs.readFileSync(new URL('../public/v2/features/wallet/view.js', import.meta.url), 'utf8');
const source = view.slice(view.indexOf('const HELD_WALLET_READERS'), view.indexOf('\nfunction heldWalletHoldsAnything'));

async function run({ background, count = 12 }) {
  let active = 0, peak = 0, reads = 0;
  const wallets = Array.from({ length: count }, (_, index) => ({ address: `W${index}`, kind: 'retired' }));
  const state = { heldWallets: { list: null, loading: false, at: 0 }, activeView: background ? 'coins' : 'wallet', apiStatus: 'connected',
    apiClient: { listHeldWallets: async () => ({ wallets }) } };
  let finished;
  const done = new Promise((resolve) => { finished = resolve; });
  const context = vm.createContext({
    state, setTimeout: (run) => setTimeout(run, 0),
    walletContents: async () => {
      active += 1; peak = Math.max(peak, active); reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return { lamports: 0, tokens: [], openAccounts: 0 };
    },
    renderHeldWallets: () => { if (state.heldWallets.loading === false && state.heldWallets.list) finished(); },
    renderAll: () => {},
  });
  vm.runInContext(source, context);
  context.refreshHeldWallets({ background });
  await done;
  return { peak, reads };
}

test('the background read of every saved key goes one wallet at a time', async () => {
  const { peak, reads } = await run({ background: true });
  assert.equal(peak, 1);
  assert.equal(reads, 12);
});

test('the Wallet page reads two at a time, never the four that hit the RPC rate limit', async () => {
  const { peak, reads } = await run({ background: false });
  assert.equal(peak, 2);
  assert.equal(reads, 12);
  assert.match(source, /const HELD_WALLET_BACKGROUND_PAUSE_MS = 300;/);
});
