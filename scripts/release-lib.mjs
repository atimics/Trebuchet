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
      { description: 'Windows update metadata', matches: (name) => /^latest.*\.yml$/i.test(name) },
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
      plan.builderArgs.push('-c.win.signExecutable=false');
    }

    return plan;
  }

  plan.trust = 'unsigned';
  return plan;
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
  assets.sort();

  return { assets, metadata };
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
