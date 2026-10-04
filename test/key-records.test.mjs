import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';

test('key lookups read the stored records only: no secret in the answer, retired kept', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-records-'));
  const previous = process.env.TREBUCHET_CONFIG_DIR;
  process.env.TREBUCHET_CONFIG_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.TREBUCHET_CONFIG_DIR; else process.env.TREBUCHET_CONFIG_DIR = previous; });
  const pendingWallets = await import(`../pendingWallets.js?records=${Date.now()}`);
  const vanityCaStore = await import(`../vanityCaStore.js?records=${Date.now()}`);
  const [live, swept] = [Keypair.generate(), Keypair.generate()];
  // Secrets nobody can decrypt here: a lookup that tried would fail or log, and must not need to.
  fs.writeFileSync(path.join(dir, 'pendingWallets.json'), JSON.stringify([
    { publicKey: live.publicKey.toBase58(), secretKeyEnc: 'pin:v1:unreadable', createdAt: '2026-10-01T00:00:00.000Z' },
    { publicKey: swept.publicKey.toBase58(), secretKeyEnc: 'pin:v1:unreadable', createdAt: '2026-10-02T00:00:00.000Z', retiredAt: '2026-10-04T00:00:00.000Z' },
  ]));
  const record = pendingWallets.keyRecord(swept.publicKey.toBase58());
  assert.deepEqual(Object.keys(record).sort(), ['createdAt', 'publicKey', 'retiredAt']);
  assert.equal(record.retiredAt, '2026-10-04T00:00:00.000Z');
  assert.equal(pendingWallets.keyRecord(Keypair.generate().publicKey.toBase58()), null);
  assert.deepEqual(pendingWallets.records().map((row) => [row.publicKey, Boolean(row.retiredAt)]),
    [[live.publicKey.toBase58(), false], [swept.publicKey.toBase58(), true]]);
  assert.ok(pendingWallets.records().every((row) => !('secretKey' in row) && !('mnemonic' in row)));
  assert.equal(vanityCaStore.hasAddress(live.publicKey.toBase58()), false);
});

test('a coin\'s positions are read from wallets in use and its own launch wallets, not every saved key', () => {
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /pendingWallets\.records\(\)\.filter\(\(wallet\) => !wallet\.retiredAt\)/);
  assert.doesNotMatch(server, /const owners = pendingWallets\.list\(\)/);
  assert.match(server, /function heldKeyKind\(address\) \{\n  const launch = pendingWallets\.keyRecord\(address\);/);
});
