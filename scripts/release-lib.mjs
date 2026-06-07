import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TARGETS = {
  'macos-arm64': {
    label: 'macOS arm64',
    builderArgs: ['--mac', 'dmg', '--arm64', '--publish=never'],
    expectedFiles: [
      { description: 'a DMG', matches: (name) => name.endsWith('.dmg') },
    ],
  },
  'macos-x64': {
    label: 'macOS x64',
    builderArgs: ['--mac', 'dmg', '--x64', '--publish=never'],
    expectedFiles: [
      { description: 'a DMG', matches: (name) => name.endsWith('.dmg') },
    ],
  },
  windows: {
    label: 'Windows',
    builderArgs: ['--win', 'nsis', 'portable', '--publish=never'],
    expectedFiles: [
      { description: 'an NSIS installer', matches: (name) => /\.exe$/i.test(name) && /\bSetup\b/i.test(name) },
      { description: 'a portable Windows executable', matches: (name) => /\.exe$/i.test(name) && /\bPortable\b/i.test(name) },
    ],
  },
  linux: {
    label: 'Linux',
    builderArgs: ['--linux', 'AppImage', 'deb', '--publish=never'],
    expectedFiles: [
      { description: 'an AppImage', matches: (name) => name.endsWith('.AppImage') },
      { description: 'a deb package', matches: (name) => name.endsWith('.deb') },
    ],
  },
};

const MAC_KEYS = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_KEYCHAIN',
  'APPLE_KEYCHAIN_PROFILE',
];

const WINDOWS_KEYS = ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'];

function hasValue(value) {
  return typeof value === 'string' ? value.trim() !== '' : Boolean(value);
}

function hasAll(env, keys) {
  return keys.every((key) => hasValue(env[key]));
}

function hasAny(env, keys) {
  return keys.some((key) => hasValue(env[key]));
}

function hasMacNotarizationCredentials(env) {
  return (
    hasAll(env, ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) ||
    hasAll(env, ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) ||
    hasAll(env, ['APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE'])
  );
}

function compareTargets(left, right) {
  const order = ['macos-arm64', 'macos-x64', 'windows', 'linux'];
  return order.indexOf(left.target) - order.indexOf(right.target);
}

export function resolveReleaseBuild(target, env = process.env) {
  const config = TARGETS[target];
  if (!config) {
    throw new Error(`Unknown release target: ${target}`);
  }

  const plan = {
    target,
    label: config.label,
    builderArgs: [...config.builderArgs],
    expectedFiles: config.expectedFiles,
    trust: 'unsigned',
  };

  if (target.startsWith('macos-')) {
    const macConfigured = hasAny(env, MAC_KEYS);
    const macReady =
      hasAll(env, ['CSC_LINK', 'CSC_KEY_PASSWORD']) && hasMacNotarizationCredentials(env);

    if (macConfigured && !macReady) {
      throw new Error(
        'Incomplete macOS signing/notarization configuration. Provide CSC_LINK + ' +
          'CSC_KEY_PASSWORD and one complete Apple notarization credential set, or ' +
          'provide none to publish unsigned test artifacts.',
      );
    }

    if (macReady) {
      plan.trust = 'signed and notarized';
      plan.builderArgs.push('-c.forceCodeSigning=true', '-c.mac.notarize=true');
    } else {
      plan.trust = 'unsigned test artifact';
      plan.builderArgs.push(
        '-c.mac.identity=null',
        '-c.mac.hardenedRuntime=false',
        '-c.mac.notarize=false',
      );
    }

    return plan;
  }

  if (target === 'windows') {
    const windowsConfigured = hasAny(env, WINDOWS_KEYS);
    const windowsReady = hasAll(env, WINDOWS_KEYS);

    if (windowsConfigured && !windowsReady) {
      throw new Error(
        'Incomplete Windows signing configuration. Provide WIN_CSC_LINK + ' +
          'WIN_CSC_KEY_PASSWORD, or provide neither to publish unsigned test artifacts.',
      );
    }

    if (windowsReady) {
      plan.trust = 'signed';
      plan.builderArgs.push('-c.forceCodeSigning=true');
    } else {
      plan.trust = 'unsigned test artifact';
    }

    return plan;
  }

  plan.trust = 'unsigned';
  return plan;
}

export function electronBuilderInvocation(builderArgs, platform = process.platform) {
  return {
    command: platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['exec', 'electron-builder', '--', ...builderArgs],
    shell: platform === 'win32',
  };
}

export async function collectFiles(rootDir) {
  const found = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile()) {
        found.push(fullPath);
      }
    }
  }

  try {
    const rootStat = await stat(rootDir);
    if (!rootStat.isDirectory()) {
      return found;
    }
  } catch {
    return found;
  }

  await walk(rootDir);
  return found.sort();
}

// GitHub requires every release asset to have a unique file name, so two
// collected files that share a basename cannot both be uploaded. In practice
// this happens when a non-installer file (a shared demo/doc asset, say) gets
// bundled into more than one per-platform build artifact: download-artifact
// unpacks each artifact into its own release-assets/<artifact>/ subtree, so the
// same file lands several times under different parent directories.
//
// Those copies are byte-identical -- the *same* logical asset duplicated, not a
// conflict -- so we collapse them to one copy and carry on. We only treat it as
// a hard error when two files share a name but differ in content, because that
// would silently clobber one with the other on GitHub and points at a genuine
// build/naming bug (e.g. two platforms emitting different files of the same
// name). That keeps the safety check meaningful without aborting a release over
// an incidental duplicate.
async function dedupeAssetsByName(assetPaths) {
  const byName = new Map();
  for (const assetPath of assetPaths) {
    const name = path.basename(assetPath);
    if (!byName.has(name)) {
      byName.set(name, []);
    }
    byName.get(name).push(assetPath);
  }

  const kept = [];
  for (const [name, paths] of byName) {
    if (paths.length === 1) {
      kept.push(paths[0]);
      continue;
    }

    // More than one file claims this name. Hash every copy: matching digests
    // mean it is the same asset duplicated across artifacts (safe to collapse),
    // a mismatch is a real collision we refuse to paper over.
    let firstDigest = null;
    for (const candidate of paths) {
      const digest = createHash('sha256').update(await readFile(candidate)).digest('hex');
      if (firstDigest === null) {
        firstDigest = digest;
      } else if (digest !== firstDigest) {
        throw new Error(`Duplicate release asset name detected with conflicting contents: ${name}`);
      }
    }

    // paths came from collectFiles (sorted), so paths[0] is a stable choice.
    kept.push(paths[0]);
  }

  return kept.sort();
}

export async function collectReleaseBundle(rootDir) {
  const files = await collectFiles(rootDir);
  const metadataFiles = files.filter(
    (file) => file.endsWith('.json') && file.split(path.sep).includes('release-metadata'),
  );
  const assets = files.filter((file) => {
    if (file.endsWith('RELEASE_NOTES.md') || file.endsWith('SHA256SUMS.txt')) {
      return false;
    }
    return !file.split(path.sep).includes('release-metadata');
  });

  const metadata = [];
  for (const file of metadataFiles) {
    metadata.push(JSON.parse(await readFile(file, 'utf8')));
  }

  metadata.sort(compareTargets);

  // Collapse byte-identical duplicates (same file delivered by several platform
  // artifacts) down to one copy; throws only on a genuine name-vs-content
  // conflict. This is what both writeChecksumFile and the gh upload consume, so
  // deduping here fixes every downstream step at once.
  const dedupedAssets = await dedupeAssetsByName(assets);

  return { assets: dedupedAssets, metadata };
}

export async function writeChecksumFile(outputFile, assets) {
  const lines = [];
  const seenNames = new Set();

  for (const asset of assets) {
    const assetName = path.basename(asset);
    if (seenNames.has(assetName)) {
      throw new Error(`Duplicate release asset name detected: ${assetName}`);
    }
    seenNames.add(assetName);

    const digest = createHash('sha256').update(await readFile(asset)).digest('hex');
    lines.push(`${digest}  ${assetName}`);
  }

  const body = `${lines.join('\n')}\n`;
  await writeFile(outputFile, body);
  return outputFile;
}

export function staleReleaseAssetNames(existingAssets, releaseAssets) {
  const wantedNames = new Set(releaseAssets.map((asset) => path.basename(asset)));

  return existingAssets
    .map((asset) => (typeof asset === 'string' ? asset : asset?.name))
    .filter((name) => typeof name === 'string' && name !== '' && !wantedNames.has(name))
    .sort();
}

export function buildReleaseNotes(tagName, metadata) {
  const lines = [
    `# ${tagName}`,
    '',
    'Artifacts in this release were built by GitHub Actions from a clean checkout using `npm ci`.',
    '',
  ];

  if (metadata.some((entry) => entry.trust === 'unsigned test artifact')) {
    lines.push(
      'This release is published as a prerelease because one or more desktop artifacts are unsigned test artifacts.',
      '',
    );
  }

  lines.push('## Trust status', '');

  for (const entry of [...metadata].sort(compareTargets)) {
    lines.push(`- ${entry.label}: ${entry.trust} (${entry.files.join(', ')})`);
  }

  lines.push('', '## Verification', '', '- Download `SHA256SUMS.txt` with the release assets.', '- Verify checksums locally with `shasum -a 256 -c SHA256SUMS.txt`.', '');
  return lines.join('\n');
}

export function isPrerelease(metadata) {
  return metadata.some((entry) => entry.trust === 'unsigned test artifact');
}

export function releaseTitle(tagName) {
  return `Trebuchet ${tagName}`;
}
