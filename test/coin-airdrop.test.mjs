import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { airdropDeliveries, classifyHoldingChange, readAirdropHistory, readAirdropHolders } from '../coinAirdrop.js';

const mint = Keypair.generate().publicKey.toBase58();
const [held, sold, moved, part] = Array.from({ length: 4 }, () => Keypair.generate().publicKey.toBase58());
const parsed = (amount) => ({ data: { parsed: { info: { tokenAmount: { amount: String(amount) } } } } });

test('deliveries come from every launch record for the mint, one row per wallet', () => {
  const journals = [
    { token: { mint }, airdrop: { transferred: [{ wallet: held, receivedRaw: '100', txId: 'a' }, { wallet: sold, amountRaw: '50', txId: 'b' }] } },
    { token: { mint }, airdrop: { transferred: [{ wallet: held, receivedRaw: '20', txId: 'c' }] } },
    { token: { mint: 'other' }, airdrop: { transferred: [{ wallet: moved, receivedRaw: '999' }] } },
  ];
  const rows = airdropDeliveries(journals, mint);
  assert.deepEqual(rows.map((row) => [row.wallet, row.receivedRaw, row.txIds]), [[held, 120n, ['a', 'c']], [sold, 50n, ['b']]]);
});

test('current balances: the associated account, then any other account before calling it gone', async () => {
  const program = TOKEN_2022_PROGRAM_ID.toBase58();
  const ata = (wallet) => getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(wallet), true, TOKEN_2022_PROGRAM_ID).toBase58();
  const balances = { [ata(held)]: parsed(100), [ata(sold)]: null, [ata(moved)]: parsed(0), [ata(part)]: parsed(30) };
  const ownerScans = [];
  const connection = {
    getMultipleParsedAccounts: async (keys) => ({ value: keys.map((key) => balances[key.toBase58()] ?? null) }),
    getParsedTokenAccountsByOwner: async (owner) => {
      ownerScans.push(owner.toBase58());
      return { value: owner.toBase58() === moved ? [{ account: parsed(40) }, { account: parsed(2) }] : [] };
    },
  };
  const deliveries = [held, sold, moved, part].map((wallet) => ({ wallet, receivedRaw: 100n, txIds: [] }));
  const rows = await readAirdropHolders(connection, { mint, tokenProgram: program, deliveries });
  assert.deepEqual(rows.map((row) => [row.wallet, row.receivedRaw, row.nowRaw]), [[held, '100', '100'], [sold, '100', '0'], [moved, '100', '42'], [part, '100', '30']]);
  assert.deepEqual(ownerScans.sort(), [sold, moved].sort(), 'only empty wallets are scanned');
});

test('a wallet the chain could not be read for says so, not "none left"', async () => {
  const connection = {
    getMultipleParsedAccounts: async (keys) => ({ value: keys.map(() => null) }),
    getParsedTokenAccountsByOwner: async () => { throw new Error('rate limited'); },
  };
  const rows = await readAirdropHolders(connection, { mint, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(), deliveries: [{ wallet: held, receivedRaw: 5n, txIds: [] }] });
  assert.equal(rows[0].nowRaw, null);
});

test('the coin page lists who sold, holds part, or holds all, sellers first', () => {
  const coins = fs.readFileSync(new URL('../public/v2/features/discovery/coins.js', import.meta.url), 'utf8');
  const from = coins.indexOf('// Received against held now');
  const to = coins.indexOf('\n// The on-chain coin the page shows', from);
  const context = vm.createContext({
    escapeHtml: (value) => String(value), walletChipHtml: (wallet) => `[${wallet}]`,
    compactAmount: (value) => String(value),
  });
  vm.runInContext(coins.slice(from, to), context);
  assert.equal(context.airdropHolding({ receivedRaw: '100', nowRaw: '0' }).label, 'None left');
  assert.equal(context.airdropHolding({ receivedRaw: '100', nowRaw: '25' }).label, '25% left');
  assert.equal(context.airdropHolding({ receivedRaw: '1000', nowRaw: '45' }).label, '4.5% left');
  assert.equal(context.airdropHolding({ receivedRaw: '100', nowRaw: '100' }).label, 'Holds all');
  assert.equal(context.airdropHolding({ receivedRaw: '100', nowRaw: '150' }).label, 'Holds more');
  assert.equal(context.airdropHolding({ receivedRaw: '100', nowRaw: null }).label, 'Not read');
  const html = context.coinAirdropHtml({ decimals: 0, recipients: [
    { wallet: 'A', receivedRaw: '10', nowRaw: '10' },
    { wallet: 'B', receivedRaw: '10', nowRaw: '0' },
    { wallet: 'C', receivedRaw: '10', nowRaw: '4' },
  ] });
  assert.match(html, /3 wallets · 1 hold all · 1 hold part · 1 hold none/);
  assert.ok(html.indexOf('[B]') < html.indexOf('[C]') && html.indexOf('[C]') < html.indexOf('[A]'), 'sellers first');
  assert.match(coins, /chainCoinSection\('Airdrop', 'Who received it', coinAirdropHtml\(airdrop\)/);
});

const OWNER = held;
const balance = (owner, tokenMint, amount) => ({ owner, mint: tokenMint, uiTokenAmount: { amount: String(amount) } });
const tx = ({ pre = [], post = [], instructions = [], inner = [], lamports = [0, 0], keys = [OWNER], fee = 5000 }) => ({
  blockTime: 1_790_000_000,
  transaction: { signatures: ['sig'], message: { accountKeys: keys.map((pubkey) => ({ pubkey })), instructions } },
  meta: { err: null, fee, preTokenBalances: pre, postTokenBalances: post, preBalances: [lamports[0]], postBalances: [lamports[1]], innerInstructions: inner.length ? [{ instructions: inner }] : [] },
});
const WSOL = 'So11111111111111111111111111111111111111112';

test('a burn instruction signed by the wallet is a burn, not a sale', () => {
  const change = classifyHoldingChange(tx({
    pre: [balance(OWNER, mint, 100)], post: [balance(OWNER, mint, 0)],
    instructions: [{ programId: TOKEN_2022_PROGRAM_ID.toBase58(), parsed: { type: 'burnChecked', info: { mint, authority: OWNER, tokenAmount: { amount: '100' } } } }],
  }), { owner: OWNER, mint });
  assert.equal(change.kind, 'burned');
  assert.equal(change.burnedRaw, 100n);
});

test('tokens out with SOL or another token back is a sale; the reverse is a buy', () => {
  const sold = classifyHoldingChange(tx({ pre: [balance(OWNER, mint, 100)], post: [balance(OWNER, mint, 40)], lamports: [1_000_000, 50_000_000] }), { owner: OWNER, mint });
  assert.deepEqual([sold.kind, sold.amountRaw], ['sold', 60n]);
  const viaSwap = classifyHoldingChange(tx({ pre: [balance(OWNER, mint, 100)], post: [balance(OWNER, mint, 90)], inner: [{ programId: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' }] }), { owner: OWNER, mint });
  assert.equal(viaSwap.kind, 'sold', 'a swap program counts even when the proceeds land elsewhere');
  const bought = classifyHoldingChange(tx({ pre: [balance(OWNER, mint, 0), balance(OWNER, WSOL, 500)], post: [balance(OWNER, mint, 70), balance(OWNER, WSOL, 0)] }), { owner: OWNER, mint });
  assert.deepEqual([bought.kind, bought.amountRaw], ['bought', 70n]);
});

test('tokens moved with nothing back are a send or a receipt', () => {
  const sent = classifyHoldingChange(tx({ pre: [balance(OWNER, mint, 100)], post: [balance(OWNER, mint, 0)], lamports: [1_000_000, 995_000] }), { owner: OWNER, mint });
  assert.equal(sent.kind, 'sent', 'paying the fee is not proceeds');
  const got = classifyHoldingChange(tx({ pre: [], post: [balance(OWNER, mint, 30)], keys: ['someone-else', OWNER], lamports: [0, 0] }), { owner: OWNER, mint });
  assert.equal(got.kind, 'received');
  assert.equal(classifyHoldingChange(tx({ pre: [balance(OWNER, mint, 5)], post: [balance(OWNER, mint, 5)] }), { owner: OWNER, mint }), null);
});

test('history totals each wallet and skips the airdrop itself', async () => {
  const sigs = { s1: tx({ pre: [balance(sold, mint, 100)], post: [balance(sold, mint, 0)], keys: [sold], lamports: [0, 9_000_000] }) };
  const connection = {
    getParsedTokenAccountsByOwner: async () => ({ value: [] }),
    getSignaturesForAddress: async () => [{ signature: 'airdrop-tx' }, { signature: 's1' }],
    getParsedTransactions: async (list) => list.map((sig) => sigs[sig] || null),
  };
  const [row] = await readAirdropHistory(connection, { mint, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(), recipients: [{ wallet: sold, txIds: ['airdrop-tx'] }] });
  assert.deepEqual([row.soldRaw, row.burnedRaw, row.partial, row.error], ['100', '0', false, null]);
});

test('the page says what each wallet did, and counts it', () => {
  const coins = fs.readFileSync(new URL('../public/v2/features/discovery/coins.js', import.meta.url), 'utf8');
  const context = vm.createContext({ escapeHtml: (value) => String(value), walletChipHtml: (wallet) => `[${wallet}]`, compactAmount: (value) => String(value) });
  vm.runInContext(coins.slice(coins.indexOf('// Received against held now'), coins.indexOf('\n// The on-chain coin the page shows')), context);
  const html = context.coinAirdropHtml({ decimals: 0, recipients: [
    { wallet: 'A', receivedRaw: '10', nowRaw: '0', history: { burnedRaw: '10', soldRaw: '0', boughtRaw: '0', sentRaw: '0', transferredInRaw: '0' } },
    { wallet: 'B', receivedRaw: '10', nowRaw: '0', history: { burnedRaw: '0', soldRaw: '10', boughtRaw: '0', sentRaw: '0', transferredInRaw: '0', partial: true } },
    { wallet: 'C', receivedRaw: '10', nowRaw: '10' },
  ] });
  assert.match(html, /3 wallets · 1 hold all · 2 hold none · 1 burned · 1 sold/);
  assert.match(html, /Burned 10/);
  assert.match(html, /Sold 10 · older history not read/);
  assert.match(html, /What happened/);
});

test('a later read starts from the saved cursor and adds only the new transactions', async () => {
  const program = TOKEN_2022_PROGRAM_ID.toBase58();
  const account = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(sold), true, TOKEN_2022_PROGRAM_ID).toBase58();
  const asked = [];
  const sigs = { s2: tx({ pre: [balance(sold, mint, 60)], post: [balance(sold, mint, 0)], keys: [sold], lamports: [0, 9_000_000] }) };
  const connection = {
    getParsedTokenAccountsByOwner: async () => ({ value: [] }),
    getSignaturesForAddress: async (key, options) => { asked.push({ key: key.toBase58(), until: options.until }); return [{ signature: 's2' }]; },
    getParsedTransactions: async (list) => list.map((sig) => sigs[sig] || null),
  };
  const known = { [sold]: { soldRaw: '40', burnedRaw: '5', boughtRaw: '0', sentRaw: '0', transferredInRaw: '0', cursors: { [account]: 's1' }, partial: false } };
  const [row] = await readAirdropHistory(connection, { mint, tokenProgram: program, recipients: [{ wallet: sold, txIds: [] }], known });
  assert.deepEqual(asked, [{ key: account, until: 's1' }], 'only what is newer than the saved cursor is asked for');
  assert.deepEqual([row.soldRaw, row.burnedRaw], ['100', '5'], 'new sales add to the saved totals');
  assert.equal(row.cursors[account], 's2', 'the cursor moves to the newest transaction read');
});

test('a failed read keeps what was already known', async () => {
  const connection = {
    getParsedTokenAccountsByOwner: async () => ({ value: [] }),
    getSignaturesForAddress: async () => { throw new Error('429 Too Many Requests'); },
  };
  const known = { [sold]: { soldRaw: '40', burnedRaw: '0', boughtRaw: '0', sentRaw: '0', transferredInRaw: '0', cursors: { a: 's1' }, partial: false } };
  const [row] = await readAirdropHistory(connection, { mint, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(), recipients: [{ wallet: sold, txIds: [] }], known });
  assert.deepEqual([row.soldRaw, row.cursors, row.error], ['40', { a: 's1' }, '429 Too Many Requests']);
});

test('history is saved on disk per mint and wallet, and survives a restart', async (t) => {
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airdrop-history-'));
  const previous = process.env.TREBUCHET_CONFIG_DIR;
  process.env.TREBUCHET_CONFIG_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.TREBUCHET_CONFIG_DIR; else process.env.TREBUCHET_CONFIG_DIR = previous; });
  const store = await import(`../airdropHistoryStore.js?fresh=${Date.now()}`);
  assert.deepEqual(store.get(mint), {});
  store.save(mint, { [held]: { soldRaw: '1', nowRaw: '9', cursors: { a: 's1' } } });
  store.save(mint, { [sold]: { burnedRaw: '2', nowRaw: '0', cursors: {} } });
  const again = await import(`../airdropHistoryStore.js?fresh=${Date.now() + 1}`);
  assert.deepEqual(Object.keys(again.get(mint)).sort(), [held, sold].sort(), 'a save keeps the wallets saved before');
  assert.equal(again.get(mint)[held].cursors.a, 's1');
});

test('the route rereads only wallets whose balance moved since the saved read', () => {
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /const known = airdropHistoryStore\.get\(mint\);/);
  assert.match(server, /if \(saved\) return saved\.nowRaw !== row\.nowRaw \|\| Boolean\(saved\.error\);/);
  assert.match(server, /readAirdropHistory\(connection, \{ mint, tokenProgram: account\.program, recipients: stale, known \}\)/);
  const coins = fs.readFileSync(new URL('../public/v2/features/discovery/coins.js', import.meta.url), 'utf8');
  assert.match(coins, /const seen = target\?\.mint \? coinPageCache\.get\(target\.mint\) : null;/);
});
