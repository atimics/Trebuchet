import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { connectRuntime, ensureRuntime } from '../packages/runtime/src/client.js';
import { readRuntimeDescriptor } from '../packages/runtime/src/owner.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'packages/cli/bin/trebuchet.js');
const server = path.join(root, 'server.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function command(profile, action) {
  const { stdout } = await exec(process.execPath, [cli, 'runtime', action, '--config-dir', profile, '--json'], { cwd: root, timeout: 40_000 });
  const value = JSON.parse(stdout);
  assert.equal(value.ok, true);
  return value.data;
}

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await sleep(50);
  }
  assert.fail('runtime state did not settle');
}

test('CLI clients share one production runtime and recover its ownership after process death', { timeout: 90_000 }, async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-runtime-client-'));
  fs.writeFileSync(path.join(profile, 'userPrefs.json'), JSON.stringify({ demoMode: true }));
  const pids = new Set();
  try {
    const [first, second] = await Promise.all([command(profile, 'start'), command(profile, 'start')]);
    pids.add(first.pid); pids.add(second.pid);
    assert.equal(first.id, second.id);
    assert.equal(first.pid, second.pid);
    assert.equal((await command(profile, 'status')).id, first.id);
    const runtime = await connectRuntime(profile);
    assert.equal(runtime.identity.id, first.id);
    // Both CLI clients already exited; the runtime still owns its profile.
    const wallet = await runtime.request('/api/v2/wallets/generate', { method: 'POST', body: {} });
    assert.equal(wallet.success, true);
    assert.ok(wallet.wallet.publicKey);
    const unauthorized = await fetch(`${runtime.url}/api/runtime`);
    assert.equal(unauthorized.status, 403);
    const wrongToken = await fetch(`${runtime.url}/api/runtime/stop`, { method: 'POST', headers: { 'x-trebuchet-owner': 'x'.repeat(43) } });
    assert.equal(wrongToken.status, 403);
    const staleRequest = await fetch(`${runtime.url}/api/demo/status`, { headers: { 'x-trebuchet-owner': 'x'.repeat(43) } });
    assert.equal(staleRequest.status, 403);
    assert.equal((await ensureRuntime(profile, { args: [server] })).identity.id, first.id);

    process.kill(first.pid, 'SIGKILL');
    await waitFor(async () => (await connectRuntime(profile)) === null);
    const restarted = await ensureRuntime(profile, { args: [server] });
    pids.add(restarted.identity.pid);
    assert.notEqual(restarted.identity.id, first.id);
    assert.equal((await command(profile, 'status')).id, restarted.identity.id);
    const stopped = await command(profile, 'stop');
    assert.equal(stopped.state, 'stopping');
    await waitFor(() => !fs.existsSync(path.join(profile, 'runtime.json')));
    assert.equal((await command(profile, 'status')).state, 'stopped');
  } catch (error) {
    if (fs.existsSync(path.join(profile, 'runtime.log'))) error.message += `\nRuntime log:\n${fs.readFileSync(path.join(profile, 'runtime.log'), 'utf8').slice(-6000)}`;
    throw error;
  } finally {
    try { pids.add(readRuntimeDescriptor(profile).pid); } catch { /* stopped */ }
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
