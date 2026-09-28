import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireProfileOwner, readRuntimeDescriptor } from '../src/owner.js';
const moduleUrl = new URL('../src/owner.js', import.meta.url).href;
function profile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-runtime-owner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}

test('profile ownership is exclusive and publishes a private local descriptor', (t) => {
  const dir = profile(t);
  const owner = acquireProfileOwner(dir);
  try {
    owner.publish(3210);
    assert.equal(readRuntimeDescriptor(dir).id, owner.id);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'runtime.json')).mode & 0o777, 0o600);
    assert.throws(() => acquireProfileOwner(dir), { code: 'RUNTIME_OWNED' });
  } finally { owner.release(); }
  assert.equal(fs.existsSync(path.join(dir, 'runtime.json')), false);
  acquireProfileOwner(dir).release();
});

test('a second process acquires ownership after the first owner is killed', { timeout: 20_000 }, async (t) => {
  const dir = profile(t);
  const code = `import { acquireProfileOwner } from ${JSON.stringify(moduleUrl)};
    const owner=acquireProfileOwner(process.argv[1]); owner.publish(3210); process.stdout.write('owned\\n'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error(stderr); })]);
  const firstId = readRuntimeDescriptor(dir).id;
  assert.throws(() => acquireProfileOwner(dir), { code: 'RUNTIME_OWNED' });
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
  const owner = acquireProfileOwner(dir);
  try { owner.publish(3211); assert.notEqual(readRuntimeDescriptor(dir).id, firstId); }
  finally { owner.release(); }
});

test('descriptor validation confines clients to the selected local profile', (t) => {
  const dir = profile(t), owner = acquireProfileOwner(dir);
  try {
    const record = owner.publish(3210);
    fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ ...record, url: 'https://example.com/' }));
    assert.throws(() => readRuntimeDescriptor(dir), /local owner/);
    owner.publish(3210);
  } finally { owner.release(); }
});
