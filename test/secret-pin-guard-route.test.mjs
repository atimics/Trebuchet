import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The config dir must be set before server.js is imported.
const dir = mkdtempSync(path.join(tmpdir(), 'trebuchet-pin-route-'));
process.env.TREBUCHET_CONFIG_DIR = dir;
const { createLocalApiServer } = await import('../server.js');
const secretPinStore = await import('../secretPinStore.js');

const api = createLocalApiServer({ port: 0, onStarted: () => {} });
const address = await api.start();
const { token } = await (await fetch(`${address.url}/api/session`)).json();

test.after(async () => {
  secretPinStore.lock();
  await api.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function post(route, body) {
  const res = await fetch(`${address.url}/api/secret-pin/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-trebuchet-session': token },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('setup twice returns 409 and leaves the state file unchanged', async () => {
  const file = path.join(dir, '.secretPin.json');
  const first = await post('setup', { pin: '1234' });
  assert.equal(first.status, 200);
  const before = readFileSync(file);

  const second = await post('setup', { pin: '5678' });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'SECRET_PIN_ALREADY_SET');
  assert.deepEqual(readFileSync(file), before);

  // The original PIN still works.
  secretPinStore.lock();
  assert.equal((await post('unlock', { pin: '1234' })).status, 200);
});

test('unlock reports a wrong PIN with 401 and a damaged file with 409', async () => {
  const file = path.join(dir, '.secretPin.json');
  secretPinStore.lock();
  const bad = await post('unlock', { pin: '0000' });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.code, 'BAD_SECRET_PIN');

  const good = readFileSync(file);
  writeFileSync(file, '{ broken');
  const setup = await post('setup', { pin: '4321' });
  assert.equal(setup.status, 409);
  assert.equal(readFileSync(file, 'utf8'), '{ broken');
  const damaged = await post('unlock', { pin: '1234' });
  assert.equal(damaged.status, 409);
  assert.equal(damaged.body.code, 'SECRET_PIN_STATE_DAMAGED');
  const status = await (await fetch(`${address.url}/api/secret-pin/status`, { headers: { 'x-trebuchet-session': token } })).json();
  assert.equal(status.status.damaged, true);
  assert.equal(status.status.configured, true);
  writeFileSync(file, good);
});
