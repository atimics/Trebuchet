import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { collectFiles, electronBuilderInvocation, resolveReleaseBuild } from './release-lib.mjs';

const target = process.env.TREBUCHET_RELEASE_TARGET;

if (!target) {
  throw new Error('TREBUCHET_RELEASE_TARGET is required.');
}

const plan = resolveReleaseBuild(target, process.env);
const projectRoot = process.cwd();
const distDir = path.join(projectRoot, 'dist');
const metadataDir = path.join(distDir, 'release-metadata');

await rm(distDir, { force: true, recursive: true });

const invocation = electronBuilderInvocation(plan.builderArgs);
const result = spawnSync(invocation.command, invocation.args, {
  cwd: projectRoot,
  env: process.env,
  shell: invocation.shell,
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const builtFiles = await collectFiles(distDir);
const artifactPaths = builtFiles.filter((file) =>
  plan.expectedFiles.some((expected) => expected.matches(path.basename(file))),
);

for (const expected of plan.expectedFiles) {
  if (!artifactPaths.some((file) => expected.matches(path.basename(file)))) {
    throw new Error(`Missing ${expected.description} for ${plan.label}.`);
  }
}

await mkdir(metadataDir, { recursive: true });

const metadata = {
  target: plan.target,
  label: plan.label,
  trust: plan.trust,
  files: artifactPaths.map((file) => path.basename(file)).sort(),
};

await writeFile(path.join(metadataDir, `${plan.target}.json`), `${JSON.stringify(metadata, null, 2)}\n`);
