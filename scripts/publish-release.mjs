import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  buildReleaseNotes,
  collectReleaseBundle,
  isPrerelease,
  releaseTitle,
  writeChecksumFile,
} from './release-lib.mjs';

const assetRoot = path.resolve(process.cwd(), process.env.TREBUCHET_RELEASE_ASSET_DIR || 'release-assets');
const tagName = process.env.GITHUB_REF_NAME;

if (!tagName) {
  throw new Error('GITHUB_REF_NAME is required to publish a release.');
}

const { assets, metadata } = await collectReleaseBundle(assetRoot);

if (metadata.length === 0) {
  throw new Error('No release metadata found in downloaded artifacts.');
}

if (assets.length === 0) {
  throw new Error('No release assets found in downloaded artifacts.');
}

const checksumFile = await writeChecksumFile(path.join(assetRoot, 'SHA256SUMS.txt'), assets);
const notesFile = path.join(assetRoot, 'RELEASE_NOTES.md');
await writeFile(notesFile, buildReleaseNotes(tagName, metadata));

const ghCommand = process.platform === 'win32' ? 'gh.exe' : 'gh';
const releaseAssets = [...assets, checksumFile].sort();
const title = releaseTitle(tagName);
const prerelease = isPrerelease(metadata);

function run(args, options = {}) {
  const outcome = spawnSync(ghCommand, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    stdio: options.stdio || 'inherit',
  });

  if (outcome.error) {
    throw outcome.error;
  }

  if (outcome.status !== 0) {
    process.exit(outcome.status || 1);
  }

  return outcome;
}

const releaseExists = spawnSync(ghCommand, ['release', 'view', tagName], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'ignore',
}).status === 0;

if (releaseExists) {
  run(['release', 'upload', tagName, ...releaseAssets, '--clobber']);

  const editArgs = ['release', 'edit', tagName, '--title', title, '--notes-file', notesFile, '--draft=false'];
  editArgs.push(prerelease ? '--prerelease' : '--prerelease=false');
  run(editArgs);
} else {
  const createArgs = ['release', 'create', tagName, '--verify-tag', '--title', title, '--notes-file', notesFile, ...releaseAssets];
  if (prerelease) {
    createArgs.push('--prerelease');
  }
  run(createArgs);
}
