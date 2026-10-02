import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openRuntimeStore, operationId } from '../src/store.js';

const moduleUrl = new URL('../src/store.js', import.meta.url).href;
function profile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-runtime-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const launch = { id: 'launch-a', walletPublicKey: 'wallet-a', network: 'demo', planDigest: 'a'.repeat(64), config: { token: { symbol: 'A' } } };

test('a restart retains launch identity, operation IDs, signed bytes, and receipts', (t) => {
  const dir = profile(t);
  let store = openRuntimeStore(dir);
  store.saveLaunch(launch);
  const op = store.prepareOperation({ launchId: launch.id, kind: 'mint', payload: { supply: '1000' } });
  store.recordSignedTransaction({ operationId: op.id, signature: 'tx-a', wire: 'signed-public-bytes', blockhash: 'hash-a', lastValidBlockHeight: 100 });
  store.close();
  store = openRuntimeStore(dir);
  try {
    assert.equal(store.prepareOperation({ launchId: launch.id, kind: 'mint', payload: { supply: '1000' } }).id, op.id);
    assert.equal(store.getTransactions(op.id)[0].wire, 'signed-public-bytes');
    store.recordReceipt('tx-a', 'confirmed', { slot: 42 });
    store.setOperationState(op.id, 'confirmed', { signature: 'tx-a', slot: 42 });
    assert.equal(store.getOperation(op.id).state, 'confirmed');
    assert.throws(() => store.prepareOperation({ launchId: launch.id, kind: 'mint', payload: { supply: '2000' } }), { code: 'OPERATION_CONFLICT' });
    assert.throws(() => store.setOperationState(op.id, 'prepared'), { code: 'INVALID_TRANSITION' });
    assert.equal(store.prepareOperation({ launchId: launch.id, kind: 'liquidity' }).state, 'prepared');
  } finally { store.close(); }
});

test('one wallet has one unfinished operation across independent connections', (t) => {
  const dir = profile(t);
  const first = openRuntimeStore(dir), second = openRuntimeStore(dir);
  try {
    first.saveLaunch(launch);
    first.prepareOperation({ launchId: launch.id, kind: 'mint' });
    assert.throws(() => second.prepareOperation({ launchId: launch.id, kind: 'sweep' }), { code: 'OPERATION_IN_FLIGHT' });
  } finally { second.close(); first.close(); }
});

test('failed transactions preserve the previous complete collection', (t) => {
  const store = openRuntimeStore(profile(t));
  try {
    const rows = store.collection('journals');
    rows.save([{ id: 'old', stage: 'funded' }]);
    assert.throws(() => rows.save([{ id: 'duplicate' }, { id: 'duplicate' }]), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
    assert.deepEqual(rows.load(), [{ id: 'old', stage: 'funded' }]);
    assert.throws(() => rows.save([{ id: 'secret', nested: { secretKey: [1, 2] } }]), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
    assert.deepEqual(rows.load(), [{ id: 'old', stage: 'funded' }]);
  } finally { store.close(); }
});

test('legacy imports preserve exact source bytes and run once', (t) => {
  const dir = profile(t);
  const source = '[{"id":"legacy","walletPublicKey":"wallet-a","stage":"minted"}]\n';
  fs.writeFileSync(path.join(dir, 'launchJournals.json'), source);
  const store = openRuntimeStore(dir);
  try {
    assert.equal(store.importLegacyJson('launchJournals.json', 'journals'), true);
    assert.equal(store.importLegacyJson('launchJournals.json', 'journals'), false);
    assert.equal(store.collection('journals').load()[0].stage, 'minted');
    assert.equal(fs.readFileSync(path.join(dir, 'launchJournals.json'), 'utf8'), source);
    fs.writeFileSync(path.join(dir, 'launches.json'), '{damaged');
    assert.throws(() => store.importLegacyJson('launches.json', 'launches'), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
    assert.equal(fs.readFileSync(path.join(dir, 'launches.json'), 'utf8'), '{damaged');
    assert.deepEqual(store.collection('launches').load(), []);
  } finally { store.close(); }
});

test('separate processes serialize collection changes without lost updates', { timeout: 20_000 }, async (t) => {
  const dir = profile(t);
  const initial = openRuntimeStore(dir); initial.collection('count').save([{ id: 'one', value: 0 }]); initial.close();
  const code = `import { openRuntimeStore } from ${JSON.stringify(moduleUrl)};
    const store = openRuntimeStore(process.argv[1]); const rows = store.collection('count');
    for(let i=0;i<30;i++) rows.transaction(() => { const list=rows.load(); list[0].value++; rows.save(list); }); store.close();`;
  const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', code, dir], { stdio: ['ignore', 'ignore', 'pipe'] }));
  t.after(() => children.forEach((child) => { if (child.exitCode === null) child.kill('SIGKILL'); }));
  await Promise.all(children.map(async (child) => {
    let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [exit] = await once(child, 'exit'); assert.equal(exit, 0, stderr);
  }));
  const store = openRuntimeStore(dir);
  try { assert.equal(store.collection('count').load()[0].value, 60); } finally { store.close(); }
});

test('signed transaction survives process death after broadcast and before receipt', { timeout: 20_000 }, async (t) => {
  const dir = profile(t);
  const code = `import fs from 'node:fs'; import { openRuntimeStore } from ${JSON.stringify(moduleUrl)};
    const store=openRuntimeStore(process.argv[1]); store.saveLaunch(${JSON.stringify(launch)});
    const op=store.prepareOperation({launchId:'launch-a',kind:'liquidity'});
    store.recordSignedTransaction({operationId:op.id,signature:'tx-liquidity',wire:'signed-liquidity',blockhash:'hash-a',lastValidBlockHeight:100});
    fs.writeFileSync(process.argv[1]+'/chain-receipt.json',JSON.stringify({signature:'tx-liquidity',slot:21}));
    process.stdout.write('broadcast\\n'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error(stderr); })]);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const store = openRuntimeStore(dir);
  try {
    const op = store.listOperations('launch-a')[0];
    assert.equal(op.state, 'prepared');
    assert.equal(store.getTransactions(op.id)[0].wire, 'signed-liquidity');
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'chain-receipt.json')));
    store.recordReceipt(receipt.signature, 'confirmed', receipt);
    store.setOperationState(op.id, 'confirmed', receipt);
    assert.equal(store.getOperation(op.id).state, 'confirmed');
  } finally { store.close(); }
});

test('stable operation identity includes plan, wallet, stage, and item index', () => {
  const input = { launchId: 'l', walletPublicKey: 'w', kind: 'position', planDigest: 'p', index: 1 };
  assert.equal(operationId(input), operationId({ ...input }));
  for (const change of [{ index: 2 }, { walletPublicKey: 'other' }, { planDigest: 'q' }]) assert.notEqual(operationId(input), operationId({ ...input, ...change }));
});

test('version one state upgrades with approval storage and retains signed recovery bytes', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = profile(t);
  let store = openRuntimeStore(dir);
  store.saveLaunch(launch);
  const op = store.prepareOperation({ launchId: launch.id, kind: 'sweep' });
  store.recordSignedTransaction({ operationId: op.id, signature: 'prior-tx', wire: 'saved-wire', blockhash: 'prior-hash', lastValidBlockHeight: 10 });
  store.close();
  const database = new DatabaseSync(path.join(dir, 'execution.sqlite'));
  database.exec('DROP TABLE operation_approvals; PRAGMA user_version = 1;');
  database.close();
  store = openRuntimeStore(dir);
  try {
    assert.equal(store.getActiveOperation(launch.walletPublicKey).id, op.id);
    assert.equal(store.getTransactions(op.id)[0].wire, 'saved-wire');
    const approval = { id: 'approval-a', maxSpendLamports: 10000, expiresAtMs: 20000 };
    store.recordOperationApproval(op.id, approval);
    store.recordOperationApproval(op.id, approval);
    assert.throws(() => store.recordOperationApproval(op.id, { ...approval, maxSpendLamports: 10001 }), { code: 'OPERATION_CONFLICT' });
    assert.deepEqual(store.getOperationApprovals(op.id), [approval]);
    const other = store.saveLaunch({ ...launch, id: 'other-launch', walletPublicKey: 'other-wallet' });
    const otherOp = store.prepareOperation({ launchId: other.id, kind: 'sweep' });
    assert.throws(() => store.recordOperationApproval(otherOp.id, approval), { code: 'OPERATION_CONFLICT' });
  } finally { store.close(); }
});
