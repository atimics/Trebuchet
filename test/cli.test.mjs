import { connectRuntime } from '@trebuchet/runtime/client';
import { readRuntimeDescriptor } from '@trebuchet/runtime/owner';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CliExitCode,
  runCli,
  TREBUCHET_CLI_RESULT_SCHEMA,
} from '@trebuchet/cli';
import { v2LaunchProofFingerprint, v2TransferEvidenceHash } from '@trebuchet/core';

function captureStream() {
  let output = '';
  return {
    write(chunk) {
      output += String(chunk);
      return true;
    },
    text() {
      return output;
    },
  };
}

async function invoke(argv, dependencies = {}) {
  const stdout = captureStream();
  const stderr = captureStream();
  const exitCode = await runCli(argv, { stdout, stderr, ...dependencies });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

async function withTempDirectory(fn) {
  const directory = await mkdtemp(path.join(tmpdir(), 'trebuchet-cli-'));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}


async function stopTestRuntime(configDir) {
  const runtime = await connectRuntime(configDir);
  if (!runtime) return;
  try {
    await runtime.request('/api/runtime/stop', { method: 'POST' });
    for (let attempt = 0; attempt < 100; attempt++) {
      try { readRuntimeDescriptor(configDir); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    let remaining = null;
    try { remaining = readRuntimeDescriptor(configDir); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (remaining?.id === runtime.identity.id) {
      try { process.kill(runtime.identity.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
}

const launchIntent = {
  token: {
    name: 'CLI Launch',
    symbol: 'CLI',
    supply: '1000000000',
    description: 'CLI contract test',
  },
  mode: 'dry-run',
  launchSol: 1,
  walletPublicKey: '11111111111111111111111111111115',
  poolTopology: {
    targetMarketCapUsd: 250000,
    pools: [{
      quoteSymbol: 'SOL',
      quoteMint: 'So11111111111111111111111111111111111111112',
      supplyPercent: 100,
      distribution: [{ sharePercent: 100 }],
      ladder: { mode: 'off' },
      support: { mode: 'off' },
    }],
    sweepDestination: 'AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j',
  },
};

function completeProof() {
  const proof = {
    status: 'completed',
    stage: 'transfer_completed',
    journalId: 'journal-cli-1',
    walletPublicKey: '11111111111111111111111111111115',
    token: {
      mint: '11111111111111111111111111111117',
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
      metadataUpdateAuthorityRevoked: true,
      metadataImmutable: true,
    },
    liquidity: {
      poolIds: ['11111111111111111111111111111118'],
      results: [{
        poolId: '11111111111111111111111111111118',
        createPoolTx: 'create-pool-tx',
        mainPositions: [{
          positionNftMint: '11111111111111111111111111111119',
          feeKeyNftMint: '1111111111111111111111111111111A',
          locked: true,
          openTx: 'open-position-tx',
          lockTx: 'lock-position-tx',
        }],
      }],
    },
    airdrop: { plannedRecipientCount: 0, deliveredCount: 0, failedCount: 0 },
    transfer: {
      status: 'completed',
      destinationWallet: 'AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j',
      walletEmpty: true,
      solTxId: 'sweep-sol-tx',
      tokenTransferErrors: [],
      nftTransferErrors: [],
    },
  };
  proof.terminalTransferEvidenceHash = v2TransferEvidenceHash(proof.transfer);
  return proof;
}

test('doctor emits one versioned JSON envelope and advertises demo-execute capability', async () => {
  const result = await invoke(['doctor', '--json'], { nodeVersion: '22.13.0', platform: 'linux' });
  assert.equal(result.exitCode, CliExitCode.SUCCESS);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schema, TREBUCHET_CLI_RESULT_SCHEMA);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, 'doctor');
  assert.equal(payload.data.transactionExecution, false);
  assert.equal(payload.data.demoExecution, true);
  assert.deepEqual(payload.data.capabilities, ['plan-build', 'plan-verify', 'estimate', 'proof-verify', 'demo-execute']);
});

test('execute rejects live networks with the stable not-ready exit code', async () => {
  const result = await invoke(['execute', '--config', 'missing.json', '--network', 'mainnet', '--json']);
  assert.equal(result.exitCode, CliExitCode.NOT_READY);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.match(payload.error.message, /Live execution/);
});

test('plan build, verify, and estimate share the Core integrity contract', async () => withTempDirectory(async (directory) => {
  const configPath = path.join(directory, 'launch.json');
  const planPath = path.join(directory, 'plan.json');
  await writeFile(configPath, JSON.stringify(launchIntent));

  const built = await invoke(['plan', 'build', '--config', configPath, '--out', planPath, '--json']);
  assert.equal(built.exitCode, CliExitCode.SUCCESS);
  assert.equal(built.stderr, '');
  const builtPayload = JSON.parse(built.stdout);
  assert.equal(builtPayload.ok, true);
  assert.equal(builtPayload.data.outputPath, planPath);
  assert.equal(builtPayload.data.plan, null);

  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  assert.equal(plan.schema, 'trebuchet-launch-plan/v1');
  assert.equal(plan.integrity.algorithm, 'sha256');

  const verified = await invoke(['plan', 'verify', planPath, '--json']);
  assert.equal(verified.exitCode, CliExitCode.SUCCESS);
  assert.equal(JSON.parse(verified.stdout).data.valid, true);

  const estimated = await invoke(['estimate', '--plan', planPath, '--json']);
  assert.equal(estimated.exitCode, CliExitCode.SUCCESS);
  const estimate = JSON.parse(estimated.stdout).data;
  assert.equal(estimate.schema, 'trebuchet-launch-estimate/v1');
  assert.equal(estimate.operationCount, 7);
  assert.equal(estimate.planDigest, plan.integrity.digest);
}));

test('tampered plans fail with the stable integrity exit code', async () => withTempDirectory(async (directory) => {
  const configPath = path.join(directory, 'launch.json');
  const planPath = path.join(directory, 'plan.json');
  await writeFile(configPath, JSON.stringify(launchIntent));
  assert.equal(
    (await invoke(['plan', 'build', '--config', configPath, '--out', planPath])).exitCode,
    CliExitCode.SUCCESS,
  );
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  plan.funding.estimatedSolCost += 1;
  await writeFile(planPath, JSON.stringify(plan));

  const result = await invoke(['plan', 'verify', planPath, '--json']);
  assert.equal(result.exitCode, CliExitCode.INTEGRITY_MISMATCH);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'INTEGRITY_MISMATCH');
  assert.ok(payload.error.details.errors.some(({ code }) => code === 'INTEGRITY_MISMATCH'));
}));

test('proof verify independently accepts matching evidence and rejects stale fingerprints', async () => withTempDirectory(async (directory) => {
  const proof = completeProof();
  const payload = {
    schema: 'trebuchet-v2-proof',
    source: 'trebuchet-v2',
    proof,
    fieldVerification: { proofFingerprint: v2LaunchProofFingerprint(proof) },
  };
  const proofPath = path.join(directory, 'proof.json');
  await writeFile(proofPath, JSON.stringify(payload));

  const valid = await invoke(['proof', 'verify', proofPath, '--json']);
  assert.equal(valid.exitCode, CliExitCode.SUCCESS);
  assert.equal(JSON.parse(valid.stdout).data.valid, true);

  payload.fieldVerification.proofFingerprint = 'stale';
  await writeFile(proofPath, JSON.stringify(payload));
  const invalid = await invoke(['proof', 'verify', proofPath, '--json']);
  assert.equal(invalid.exitCode, CliExitCode.INTEGRITY_MISMATCH);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'INTEGRITY_MISMATCH');
}));

test('invalid commands fail without prompts and keep JSON errors on stdout', async () => {
  const result = await invoke(['launch', 'run', '--json']);
  assert.equal(result.exitCode, CliExitCode.INVALID_INPUT);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_INPUT');

  const misplacedOption = await invoke(['doctor', '--config', 'launch.json', '--json']);
  assert.equal(misplacedOption.exitCode, CliExitCode.INVALID_INPUT);
  assert.match(JSON.parse(misplacedOption.stdout).error.message, /--config is not valid here/);
});

test('the workspace bin entry executes without Electron or the Local API', () => {
  const result = spawnSync(
    process.execPath,
    ['packages/cli/bin/trebuchet.js', 'doctor', '--json'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.transactionExecution, false);
});

test('the packed CLI runs isolated planning and starts its installed host for saved launches', async () => withTempDirectory(async (directory) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npmCache = process.env.TREBUCHET_NPM_PACK_CACHE
    || path.join(tmpdir(), 'trebuchet-cli-pack-cache');
  const packed = spawnSync(
    npmCommand,
    ['pack', '--json', '--pack-destination', directory],
    {
      cwd: root,
      encoding: 'utf8',
      // npm lists each packed file; bundled runtime dependencies exceed 1 MiB of JSON.
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, npm_config_cache: npmCache },
    },
  );
  assert.equal(packed.status, 0, packed.error?.message || packed.stderr);
  const [{ filename, bundled = [] }] = JSON.parse(packed.stdout);
  assert.ok(bundled.includes('@trebuchet/core'), 'packed package must bundle @trebuchet/core');
  assert.ok(bundled.includes('@trebuchet/runtime'), 'packed package must bundle @trebuchet/runtime');

  const extractDirectory = path.join(directory, 'extract');
  await mkdir(extractDirectory);
  const extracted = spawnSync(
    'tar',
    ['-xf', path.join(directory, filename), '-C', extractDirectory],
    { encoding: 'utf8' },
  );
  assert.equal(extracted.status, 0, extracted.stderr);

  const result = spawnSync(
    process.execPath,
    ['packages/cli/bin/trebuchet.js', 'doctor', '--json'],
    { cwd: path.join(extractDirectory, 'package'), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.transactionExecution, false);
  // Supply installed host dependencies while keeping the packed Core and
  // runtime packages in the extracted package's own node_modules directory.
  await symlink(path.join(root, 'node_modules'), path.join(extractDirectory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const profile = path.join(directory, 'profile');
  try {
    const stored = spawnSync(process.execPath, [
      'packages/cli/bin/trebuchet.js', 'launch', 'list', '--config-dir', profile, '--json',
    ], { cwd: path.join(extractDirectory, 'package'), encoding: 'utf8', timeout: 40_000 });
    assert.equal(stored.status, 0, stored.stdout + stored.stderr);
    assert.deepEqual(JSON.parse(stored.stdout).data.launches, []);
    assert.ok(await connectRuntime(profile), 'packaged CLI starts its runtime');
  } finally {
    await stopTestRuntime(profile);
  }
}));

test('execute runs a complete demo-runtime launch with a disposable wallet', async () => withTempDirectory(async (directory) => {
  const configPath = path.join(directory, 'launch.json');
  const runPath = path.join(directory, 'run.json');
  await writeFile(configPath, JSON.stringify(launchIntent));

  const result = await invoke(['execute', '--config', configPath, '--out', runPath, '--timeout', '120', '--json']);
  assert.equal(result.exitCode, CliExitCode.SUCCESS, result.stdout + result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, 'execute');
  assert.equal(payload.data.runtime, 'demo');
  assert.equal(payload.data.network, 'demo');
  assert.ok(payload.data.walletPublicKey);
  assert.ok(payload.data.tokenMint);
  assert.equal(payload.data.poolCount, 1);

  const run = JSON.parse(await readFile(runPath, 'utf8'));
  assert.equal(run.schema, 'trebuchet-demo-launch-run/v1');
  assert.equal(run.runtime, 'demo');
  assert.ok(run.run.token.success);
  assert.ok(run.run.liquidity.success);
  // The disposable wallet secret must not leak into the CLI output file.
  assert.equal(JSON.stringify(run).includes('secretKey'), false);
}), { timeout: 180_000 });

test('launch save/list/remove share the profile runtime with the app', async () => withTempDirectory(async (directory) => {
  const configPath = path.join(directory, 'launch.json');
  await writeFile(configPath, JSON.stringify(launchIntent));
  const configDir = path.join(directory, 'config');
  await mkdir(configDir, { recursive: true });

  try {
    const saved = await invoke(['launch', 'save', '--config', configPath, '--name', 'CLI launch', '--config-dir', configDir, '--json']);
    assert.equal(saved.exitCode, CliExitCode.SUCCESS, saved.stdout + saved.stderr);
    const savedPayload = JSON.parse(saved.stdout);
    assert.equal(savedPayload.ok, true);
    assert.ok(savedPayload.data.id);
    assert.equal(savedPayload.data.name, 'CLI launch');
    const runtime = await connectRuntime(configDir);
    assert.ok(runtime);
    assert.notEqual(runtime.identity.pid, process.pid);
    const ownerId = runtime.identity.id;
    const stored = (await runtime.request('/api/v2/launch-configs')).launches;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].config.token.symbol, launchIntent.token.symbol);
    assert.equal(stored[0].source, 'cli');
    await runtime.request('/api/v2/launch-configs', { method: 'POST', body: { id: savedPayload.data.id, name: 'App edit', config: launchIntent } });

    const listed = await invoke(['launch', 'list', '--config-dir', configDir, '--json']);
    assert.equal(listed.exitCode, CliExitCode.SUCCESS);
    const listPayload = JSON.parse(listed.stdout);
    assert.equal(listPayload.data.launches.length, 1);
    assert.equal(listPayload.data.launches[0].symbol, launchIntent.token.symbol);
    assert.equal(listPayload.data.launches[0].pools, 1);
    assert.equal(listPayload.data.launches[0].name, 'App edit');
    assert.equal(listPayload.data.launches[0].source, 'app');
    assert.equal(listPayload.data.storePath, savedPayload.data.storePath);

    const removed = await invoke(['launch', 'remove', '--id', savedPayload.data.id, '--config-dir', configDir, '--json']);
    assert.equal(removed.exitCode, CliExitCode.SUCCESS);
    const afterRemove = await invoke(['launch', 'list', '--config-dir', configDir, '--json']);
    assert.equal(JSON.parse(afterRemove.stdout).data.launches.length, 0);
    assert.equal((await connectRuntime(configDir)).identity.id, ownerId);
  } finally {
    await stopTestRuntime(configDir);
  }
}), { timeout: 60_000 });

test('confirm refuses to sign a placeholder sweep destination on a real network', async () => withTempDirectory(async (directory) => {
  const keyfilePath = path.join(directory, 'custody.json');
  const created = await invoke(['custody', 'create', '--out', keyfilePath, '--passphrase', 'test-pass', '--json']);
  assert.equal(created.exitCode, CliExitCode.SUCCESS, created.stdout + created.stderr);

  const configPath = path.join(directory, 'launch.json');
  await writeFile(configPath, JSON.stringify({
    ...launchIntent,
    poolTopology: { ...launchIntent.poolTopology, sweepDestination: '11111111111111111111111111111116' },
  }));
  const planPath = path.join(directory, 'plan.json');
  const built = await invoke(['plan', 'build', '--config', configPath, '--out', planPath]);
  assert.equal(built.exitCode, CliExitCode.SUCCESS, built.stdout + built.stderr);

  const refused = await invoke(['confirm', '--plan', planPath, '--keyfile', keyfilePath, '--network', 'mainnet', '--max-spend-sol', '1', '--passphrase', 'test-pass', '--json']);
  assert.equal(refused.exitCode, CliExitCode.INVALID_INPUT, refused.stdout + refused.stderr);
  assert.match(JSON.parse(refused.stdout).error.message, /placeholder address/);

  // Demo confirmations are unaffected (practice never moves real assets).
  const demo = await invoke(['confirm', '--plan', planPath, '--keyfile', keyfilePath, '--network', 'demo', '--max-spend-sol', '1', '--passphrase', 'test-pass', '--json']);
  assert.equal(demo.exitCode, CliExitCode.SUCCESS, demo.stdout + demo.stderr);
}), { timeout: 60_000 });

test('flywheel pool commands curate and draw from the memecoin pool', async () => withTempDirectory(async (directory) => {
  const configDir = path.join(directory, 'config');
  await mkdir(configDir, { recursive: true });

  const listed = await invoke(['flywheel', 'list', '--config-dir', configDir, '--json']);
  assert.equal(listed.exitCode, CliExitCode.SUCCESS, listed.stdout + listed.stderr);
  const seeded = JSON.parse(listed.stdout).data.mints;
  assert.equal(seeded.length, 12, 'seeded with the default hub tokens');
  assert.ok(seeded.includes('RUGx1zSD7LCVqFgTYQWNiJKSkDcfN3yRR5XoFoAXRUG'));

  const extra = 'So11111111111111111111111111111111111111112';
  const added = await invoke(['flywheel', 'add', '--mint', extra, '--config-dir', configDir, '--json']);
  assert.equal(added.exitCode, CliExitCode.SUCCESS);
  assert.ok(JSON.parse(added.stdout).data.mints.includes(extra));

  const picks = await invoke(['flywheel', 'pick', '--last', 'RUGx1zSD7LCVqFgTYQWNiJKSkDcfN3yRR5XoFoAXRUG', '--config-dir', configDir, '--json']);
  assert.equal(picks.exitCode, CliExitCode.SUCCESS);
  const picked = JSON.parse(picks.stdout).data.mint;
  assert.ok(seeded.concat(extra).includes(picked));
  assert.notEqual(picked, 'RUGx1zSD7LCVqFgTYQWNiJKSkDcfN3yRR5XoFoAXRUG', 'avoids repeating the last pick');

  const removed = await invoke(['flywheel', 'remove', '--mint', extra, '--config-dir', configDir, '--json']);
  assert.equal(removed.exitCode, CliExitCode.SUCCESS);
  const after = await invoke(['flywheel', 'list', '--config-dir', configDir, '--json']);
  assert.equal(JSON.parse(after.stdout).data.mints.includes(extra), false);

  const badMint = await invoke(['flywheel', 'add', '--mint', 'not-a-mint', '--config-dir', configDir, '--json']);
  assert.equal(badMint.exitCode, CliExitCode.INVALID_INPUT);
}), { timeout: 60_000 });
