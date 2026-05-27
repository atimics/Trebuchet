import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { nextRelease, releaseTypeFromLabels } from '../scripts/auto-version.mjs';
import { buildReleaseNotes, resolveReleaseBuild, staleReleaseAssetNames } from '../scripts/release-lib.mjs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('release workflow is tag-driven and publishes checksums', () => {
  const workflow = read('.github/workflows/release.yml');
  const publishScript = read('scripts/publish-release.mjs');

  assert.match(workflow, /tags:\s*\n\s*-\s*'v\*'/);
  assert.match(workflow, /node scripts\/release-build\.mjs/);
  assert.match(workflow, /node scripts\/publish-release\.mjs/);
  assert.match(workflow, /actions\/download-artifact@v5/);
  assert.match(workflow, /npm ci/);
  assert.match(publishScript, /SHA256SUMS\.txt/);
  assert.match(workflow, /name:\s+Publish Website/);
  assert.match(workflow, /FTP_LOGIN/);
  assert.match(workflow, /FTP_PASSWORD/);
  assert.match(workflow, /mirror -R --only-newer --verbose=2 website/);
});

test('main merges automatically create patch, minor, or major release tags', () => {
  const workflow = read('.github/workflows/auto-release.yml');

  assert.match(workflow, /branches:\s*\n\s*-\s+main/);
  assert.match(workflow, /actions:\s+write/);
  assert.match(workflow, /pull-requests:\s+read/);
  assert.match(workflow, /node scripts\/auto-version\.mjs/);
  assert.match(workflow, /git tag -a "\$\{\{ steps\.next\.outputs\.tag \}\}"/);
  assert.match(workflow, /gh workflow run release\.yml --ref "\$\{\{ steps\.next\.outputs\.tag \}\}"/);

  assert.equal(releaseTypeFromLabels([]), 'patch');
  assert.equal(releaseTypeFromLabels(['minor']), 'minor');
  assert.equal(releaseTypeFromLabels(['minor', 'major']), 'major');
  assert.deepEqual(nextRelease('1.0.0', [], []), {
    releaseType: 'patch',
    version: '1.0.1',
    tag: 'v1.0.1',
  });
  assert.equal(nextRelease('1.2.3', ['v1.3.9'], ['minor']).version, '1.4.0');
  assert.equal(nextRelease('1.2.3', ['v1.3.9'], ['major']).version, '2.0.0');
});

test('release workflow publishes the GitHub package for each tag', () => {
  const workflow = read('.github/workflows/release.yml');
  const pkg = JSON.parse(read('package.json'));

  assert.equal(pkg.name, '@anoversizedmoosewithsocks/trebuchet-desktop');
  assert.equal(pkg.publishConfig.registry, 'https://npm.pkg.github.com');
  assert.equal(pkg.repository.url, 'git+https://github.com/AnOversizedMooseWithSocks/Trebuchet.git');
  assert.match(workflow, /packages:\s+write/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /npm version "\$\{GITHUB_REF_NAME#v\}" --no-git-tag-version/);
  assert.match(workflow, /name:\s+Publish GitHub Package/);
  assert.match(workflow, /registry-url:\s+https:\/\/npm\.pkg\.github\.com/);
  assert.match(workflow, /npm publish/);
});

test('release docs explain trust states and verification', () => {
  const docs = read('docs/releasing.md');

  assert.match(docs, /Merges to `main`/);
  assert.match(docs, /`minor` label/);
  assert.match(docs, /`major` label/);
  assert.match(docs, /signed and notarized/i);
  assert.match(docs, /unsigned test artifact/i);
  assert.match(docs, /GitHub Packages/);
  assert.match(docs, /WIN_CSC_LINK/);
  assert.match(docs, /APPLE_API_KEY/);
  assert.match(docs, /SHA256SUMS\.txt/);
});

test('mac build uses a native icns app icon', () => {
  const pkg = JSON.parse(read('package.json'));

  assert.equal(pkg.build.mac.icon, 'build/icon.icns');
  assert.equal(existsSync(new URL('../build/icon.icns', import.meta.url)), true);
});

test('windows release builds installer and portable executable', () => {
  const pkg = JSON.parse(read('package.json'));
  const plan = resolveReleaseBuild('windows', {});

  assert.deepEqual(pkg.build.win.target, ['nsis', 'portable']);
  assert.equal(pkg.build.portable.artifactName, '${productName} ${version} Portable.${ext}');
  assert.deepEqual(plan.builderArgs.slice(0, 3), ['--win', 'nsis', 'portable']);
  assert.equal(plan.expectedFiles.some((expected) => expected.matches('Trebuchet Setup 1.2.3.exe')), true);
  assert.equal(plan.expectedFiles.some((expected) => expected.matches('Trebuchet 1.2.3 Portable.exe')), true);
});

test('release build planner enforces complete signing credentials', () => {
  assert.equal(resolveReleaseBuild('macos-arm64', {}).trust, 'unsigned test artifact');
  assert.equal(
    resolveReleaseBuild('macos-arm64', {
      CSC_LINK: 'base64-p12',
      CSC_KEY_PASSWORD: 'secret',
      APPLE_API_KEY: 'key',
      APPLE_API_KEY_ID: 'kid',
      APPLE_API_ISSUER: 'issuer',
    }).trust,
    'signed and notarized',
  );
  assert.throws(
    () => resolveReleaseBuild('macos-arm64', { CSC_LINK: 'base64-p12' }),
    /Incomplete macOS signing\/notarization configuration/,
  );

  assert.equal(resolveReleaseBuild('windows', {}).trust, 'unsigned test artifact');
  assert.equal(
    resolveReleaseBuild('windows', {
      WIN_CSC_LINK: 'base64-pfx',
      WIN_CSC_KEY_PASSWORD: 'secret',
    }).trust,
    'signed',
  );
  assert.throws(
    () => resolveReleaseBuild('windows', { WIN_CSC_LINK: 'base64-pfx' }),
    /Incomplete Windows signing configuration/,
  );

  assert.equal(resolveReleaseBuild('linux', {}).trust, 'unsigned');
});

test('release notes call out prerelease trust gaps and checksum verification', () => {
  const notes = buildReleaseNotes('v1.2.3', [
    {
      target: 'macos-arm64',
      label: 'macOS arm64',
      trust: 'unsigned test artifact',
      files: ['Trebuchet-1.2.3-arm64.dmg'],
    },
    {
      target: 'windows',
      label: 'Windows',
      trust: 'signed',
      files: ['Trebuchet Setup 1.2.3.exe', 'latest.yml'],
    },
  ]);

  assert.match(notes, /prerelease/i);
  assert.match(notes, /unsigned test artifact/i);
  assert.match(notes, /signed/);
  assert.match(notes, /SHA256SUMS\.txt/);
  assert.match(notes, /shasum -a 256 -c SHA256SUMS\.txt/);
});

test('publish reruns remove release assets that are no longer produced', () => {
  const staleAssets = staleReleaseAssetNames(
    [
      { name: 'Trebuchet Setup 1.2.3.exe' },
      { name: 'Trebuchet 1.2.3 Portable.exe' },
      { name: 'Trebuchet-1.2.3.zip' },
      { name: 'SHA256SUMS.txt' },
    ],
    [
      '/tmp/release-assets/windows/Trebuchet Setup 1.2.3.exe',
      '/tmp/release-assets/windows/Trebuchet 1.2.3 Portable.exe',
      '/tmp/release-assets/SHA256SUMS.txt',
    ],
  );

  assert.deepEqual(staleAssets, ['Trebuchet-1.2.3.zip']);
});

test('website download CTA points to GitHub Releases instead of committed build artifacts', () => {
  const site = read('website/index.html');

  assert.match(site, /https:\/\/github\.com\/AnOversizedMooseWithSocks\/Trebuchet\/releases\/latest/);
  assert.doesNotMatch(site, /\/raw\/main\/dist\//);
  assert.match(site, /Download latest release/);
});
