import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildV2LaunchPlan } from '../packages/core/src/launch-plan.js';
import { encryptCustodyKeyfile } from '../packages/core/src/custody.js';
import { secretKeyToEd25519Material } from '../packages/core/src/confirmation.js';
import { verifyPacketApproval } from '../packages/core/src/packet-approval.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('CLI signs the exact manifest and plan bytes with its encrypted operator key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-cli-packet-approval-'));
  try {
    const seed = randomBytes(32);
    const { rawPublicKey } = secretKeyToEd25519Material(seed);
    const secretKey = Buffer.concat([seed, rawPublicKey]);
    const operatorKey = Buffer.from(rawPublicKey).toString('hex');
    const passphrase = 'packet approval test passphrase';
    const input = { token: { name: 'Packet', symbol: 'PKT' }, walletPublicKey: 'AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j', mode: 'dry-run', launchSol: 1 };
    const plan = buildV2LaunchPlan(input);
    const planBytes = Buffer.from(JSON.stringify(plan, null, 2));
    const configBytes = Buffer.from(JSON.stringify(input));
    const manifest = {
      schema: 'trebuchet-launch-packet/v1', planDigest: plan.integrity.digest,
      security: { containsPrivateKeys: false },
      files: [
        { path: 'plan.json', bytes: planBytes.length, sha256: hash(planBytes) },
        { path: 'launch.json', bytes: configBytes.length, sha256: hash(configBytes) },
      ],
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(dir, 'manifest.json'), manifestBytes);
    fs.writeFileSync(path.join(dir, 'plan.json'), planBytes);
    fs.writeFileSync(path.join(dir, 'custody.json'), JSON.stringify(encryptCustodyKeyfile({ secretKey, passphrase })), { mode: 0o600 });
    const args = [path.join(root, 'packages/cli/bin/trebuchet.js'), 'packet', 'approve',
      '--manifest', path.join(dir, 'manifest.json'), '--plan', path.join(dir, 'plan.json'),
      '--keyfile', path.join(dir, 'custody.json'), '--network', 'demo', '--max-spend-sol', '1.000000001',
      '--out', path.join(dir, 'approval.json'), '--json'];
    const options = { cwd: root, env: { ...process.env, TREBUCHET_CUSTODY_PASSPHRASE: passphrase }, timeout: 15_000 };
    const { stdout } = await exec(process.execPath, args, options);
    const response = JSON.parse(stdout);
    assert.equal(response.ok, true);
    const approval = JSON.parse(fs.readFileSync(path.join(dir, 'approval.json'), 'utf8'));
    assert.deepEqual(approval, response.data.approval);
    const verification = verifyPacketApproval(approval, { expected: {
      manifestDigest: hash(manifestBytes), planDigest: plan.integrity.digest,
      operatorKey, walletPublicKey: input.walletPublicKey, network: 'demo',
    }, spendLamports: '1000000001' });
    assert.equal(verification.valid, true);
    assert.equal(approval.payload.maxSpendLamports, '1000000001');
    assert.ok(!stdout.includes(passphrase));
    assert.ok(!stdout.includes(Buffer.from(seed).toString('hex')));
    // Even JSON whitespace changes the file bytes that the manifest covers.
    fs.appendFileSync(path.join(dir, 'plan.json'), '\n');
    await assert.rejects(exec(process.execPath, args, options), (error) => {
      assert.equal(error.code, 7);
      assert.equal(JSON.parse(error.stdout).error.code, 'INTEGRITY_MISMATCH');
      return true;
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
