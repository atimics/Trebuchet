import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { buildReleaseNotes, resolveReleaseBuild } from '../scripts/release-lib.mjs';

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
});

test('release docs explain trust states and verification', () => {
  const docs = read('docs/releasing.md');

  assert.match(docs, /signed and notarized/i);
  assert.match(docs, /unsigned test artifact/i);
  assert.match(docs, /WIN_CSC_LINK/);
  assert.match(docs, /APPLE_API_KEY/);
  assert.match(docs, /SHA256SUMS\.txt/);
});

test('mac build uses a native icns app icon', () => {
  const pkg = JSON.parse(read('package.json'));

  assert.equal(pkg.build.mac.icon, 'build/icon.icns');
  assert.equal(existsSync(new URL('../build/icon.icns', import.meta.url)), true);
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
