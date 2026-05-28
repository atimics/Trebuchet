import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareVersions,
  pickAssetForPlatform,
  parseReleaseTag,
} from '../updateCheck.js';

// Tests for the pure parts of the update-check feature. Anything
// network-bound (the GitHub API call) or Electron-bound (the menu
// click, the webContents.executeJavaScript push) lives in main.js
// and isn't exercised here — those are integration concerns and
// would need a full Electron runtime to test meaningfully.
//
// What's tested:
//   - compareVersions: ordering, equality, edge cases that bit me
//                       writing the function (two-digit components,
//                       missing trailing zeros, malformed input).
//   - pickAssetForPlatform: every platform/arch we ship for, plus
//                            unrecognised combos.
//   - parseReleaseTag: stripping the "v", rejecting malformed tags.

test('compareVersions orders normal version strings correctly', () => {
  // 1 means a > b, -1 means a < b, 0 means equal
  assert.equal(compareVersions('1.0.8', '1.0.9'), -1);
  assert.equal(compareVersions('1.0.9', '1.0.8'), 1);
  assert.equal(compareVersions('1.0.9', '1.0.9'), 0);

  assert.equal(compareVersions('1.0.9', '1.1.0'), -1);
  assert.equal(compareVersions('1.1.0', '1.0.99'), 1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
});

test('compareVersions handles two-digit components correctly', () => {
  // Naive string-sort would say "1.0.9" > "1.0.10" because '9' > '1'.
  // Numeric comparison must win here, otherwise jumping from 1.0.9
  // to 1.0.10 would make the auto-check think the user is on a
  // newer version and never prompt for the upgrade.
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
  assert.equal(compareVersions('1.0.9', '1.0.10'), -1);

  // Same hazard at every component
  assert.equal(compareVersions('1.10.0', '1.9.99'), 1);
  assert.equal(compareVersions('10.0.0', '9.99.99'), 1);
});

test('compareVersions treats missing trailing components as zero', () => {
  // "1.0" should equal "1.0.0" — not "1.0.NaN" or "1.0.undefined".
  // If we ever see a stripped tag like "v1.0" from a hand-cut tag,
  // this prevents a bogus version mismatch.
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0', '1.0'), 0);
  assert.equal(compareVersions('1', '1.0.0'), 0);
});

test('compareVersions handles non-numeric or empty components defensively', () => {
  // parseInt('abc', 10) is NaN; the `|| 0` keeps that from poisoning
  // the comparison. We don't want a hand-edited package.json with a
  // weird version to crash the app — graceful degradation matters.
  assert.equal(compareVersions('1.0.abc', '1.0.0'), 0);
  assert.equal(compareVersions('', ''), 0);
  assert.equal(compareVersions('', '0.0.0'), 0);
});

// ---------------------------------------------------------------------------
// Asset picking — the heart of the OS/arch logic
// ---------------------------------------------------------------------------

// Real-shaped GitHub release assets for the tests below. Names match
// what electron-builder actually produces with the current
// artifactName templates in package.json.
const REAL_ASSETS = [
  { name: 'SHA256SUMS.txt',                browser_download_url: 'https://x/SHA256SUMS.txt' },
  { name: 'Trebuchet-1.0.9-arm64.dmg',     browser_download_url: 'https://x/arm64.dmg' },
  { name: 'Trebuchet-1.0.9-x64.dmg',       browser_download_url: 'https://x/x64.dmg' },
  { name: 'Trebuchet-1.0.9-Setup.exe',     browser_download_url: 'https://x/Setup.exe' },
  { name: 'Trebuchet-1.0.9-Portable.exe',  browser_download_url: 'https://x/Portable.exe' },
  { name: 'Trebuchet-1.0.9-x86_64.AppImage', browser_download_url: 'https://x/AppImage' },
  { name: 'trebuchet-desktop_1.0.9_amd64.deb', browser_download_url: 'https://x/deb' },
];

test('pickAssetForPlatform recommends portable .exe on Windows (not the installer)', () => {
  const got = pickAssetForPlatform(REAL_ASSETS, 'win32', 'x64');
  assert.equal(got.name, 'Trebuchet-1.0.9-Portable.exe');

  // arch shouldn't matter on Windows since we don't ship arm64 Windows.
  // Same recommendation regardless.
  const arm = pickAssetForPlatform(REAL_ASSETS, 'win32', 'arm64');
  assert.equal(arm.name, 'Trebuchet-1.0.9-Portable.exe');
});

test('pickAssetForPlatform respects macOS architecture exactly', () => {
  // This is the one case where picking wrong gives the user a binary
  // that simply won't run. arm64 ≠ x64, no graceful fallback.
  const arm = pickAssetForPlatform(REAL_ASSETS, 'darwin', 'arm64');
  assert.equal(arm.name, 'Trebuchet-1.0.9-arm64.dmg');

  const intel = pickAssetForPlatform(REAL_ASSETS, 'darwin', 'x64');
  assert.equal(intel.name, 'Trebuchet-1.0.9-x64.dmg');

  // Verify the matcher isn't accidentally selecting the wrong DMG.
  // (e.g. a too-loose regex matching "Trebuchet-1.0.9-x64.dmg" against
  // an "arm64" request because "64" is a substring of both.)
  assert.notEqual(arm.name, intel.name);
});

test('pickAssetForPlatform recommends the AppImage on Linux', () => {
  // AppImage works on every distro without a package manager. The
  // .deb is shipped but only as a secondary, since it only helps
  // Debian/Ubuntu users.
  const got = pickAssetForPlatform(REAL_ASSETS, 'linux', 'x64');
  assert.equal(got.name, 'Trebuchet-1.0.9-x86_64.AppImage');
});

test('pickAssetForPlatform returns undefined for unsupported platforms', () => {
  // We don't ship binaries for FreeBSD, Solaris, etc. The caller
  // treats undefined as a "no-asset" status and routes the user
  // to the release page to choose manually.
  assert.equal(pickAssetForPlatform(REAL_ASSETS, 'freebsd', 'x64'), undefined);
  assert.equal(pickAssetForPlatform(REAL_ASSETS, 'aix', 'ppc64'), undefined);
  assert.equal(pickAssetForPlatform(REAL_ASSETS, '', ''), undefined);
});

test('pickAssetForPlatform returns undefined when no matching asset exists', () => {
  // Simulate a release where the Windows artifacts are missing
  // (e.g. the Windows build job failed but the release was published).
  // We shouldn't synthesize a download URL — we should return
  // undefined so the user gets routed to the release page.
  const noWindows = REAL_ASSETS.filter((a) => !/\.exe$/.test(a.name));
  assert.equal(pickAssetForPlatform(noWindows, 'win32', 'x64'), undefined);

  const noMacArm = REAL_ASSETS.filter((a) => !/arm64\.dmg$/.test(a.name));
  assert.equal(pickAssetForPlatform(noMacArm, 'darwin', 'arm64'), undefined);
});

test('pickAssetForPlatform tolerates non-array inputs', () => {
  // Defensive: if the GitHub API ever returns something we don't
  // expect (e.g. release.assets is null on a malformed response),
  // we should return undefined rather than crashing with
  // "TypeError: assets.find is not a function".
  assert.equal(pickAssetForPlatform(undefined, 'win32', 'x64'), undefined);
  assert.equal(pickAssetForPlatform(null, 'darwin', 'arm64'), undefined);
  assert.equal(pickAssetForPlatform('not an array', 'linux', 'x64'), undefined);
});

test('pickAssetForPlatform ignores checksum/metadata files', () => {
  // SHA256SUMS.txt, latest.yml, RELEASE_NOTES.md, etc. are all
  // attached to releases but aren't downloads we'd direct users to.
  // The matchers should skip them. The fixtures contain SHA256SUMS.txt
  // so this is implicitly tested in the happy-path tests above, but
  // adding an explicit "ONLY metadata" case nails it down.
  const onlyMetadata = [{ name: 'SHA256SUMS.txt', browser_download_url: 'https://x' }];
  assert.equal(pickAssetForPlatform(onlyMetadata, 'win32', 'x64'), undefined);
  assert.equal(pickAssetForPlatform(onlyMetadata, 'darwin', 'arm64'), undefined);
  assert.equal(pickAssetForPlatform(onlyMetadata, 'linux', 'x64'), undefined);
});

// ---------------------------------------------------------------------------
// Release tag parsing
// ---------------------------------------------------------------------------

test('parseReleaseTag strips the v prefix and accepts N.N.N tags', () => {
  assert.equal(parseReleaseTag('v1.0.9'), '1.0.9');
  assert.equal(parseReleaseTag('v0.1.0'), '0.1.0');
  assert.equal(parseReleaseTag('v10.20.30'), '10.20.30');

  // Without the v prefix it should still work — defensive in case
  // GitHub or our tooling ever serves the bare version.
  assert.equal(parseReleaseTag('1.0.9'), '1.0.9');
});

test('parseReleaseTag accepts two-part and one-part versions too', () => {
  assert.equal(parseReleaseTag('v1.0'), '1.0');
  assert.equal(parseReleaseTag('v1'), '1');
});

test('parseReleaseTag returns null for malformed input', () => {
  // Anything we can't confidently compare — return null and let
  // the caller surface an error to the user rather than guessing.
  assert.equal(parseReleaseTag(''), null);
  assert.equal(parseReleaseTag(null), null);
  assert.equal(parseReleaseTag(undefined), null);
  assert.equal(parseReleaseTag('v'), null);
  assert.equal(parseReleaseTag('latest'), null);
  assert.equal(parseReleaseTag('release-2024-01'), null);

  // No support for pre-release suffixes (e.g. v1.0.0-rc1). If we
  // ever start tagging pre-releases, this test will fail and force
  // us to think about how the auto-check should behave (probably
  // skip pre-releases by default unless the user opts in).
  assert.equal(parseReleaseTag('v1.0.0-rc1'), null);
  assert.equal(parseReleaseTag('v1.0.0-beta.2'), null);
});

// ---------------------------------------------------------------------------
// End-to-end-ish integration of the pure pieces
// ---------------------------------------------------------------------------

test('the full decision pipeline picks the expected behaviour for each scenario', () => {
  // Stitch the three pure helpers together the way main.js does, and
  // assert the high-level decision for a few scenarios. This is a
  // safety net — if any of the individual helpers regresses in a way
  // that the unit tests miss, but the combined flow comes out wrong,
  // this catches it.

  const tag = 'v1.0.9';
  const latest = parseReleaseTag(tag);
  assert.equal(latest, '1.0.9');

  // Scenario: user is behind on macOS arm64 — should get the arm64 DMG.
  const macUpdate = (() => {
    if (!latest || compareVersions('1.0.8', latest) >= 0) return null;
    return pickAssetForPlatform(REAL_ASSETS, 'darwin', 'arm64');
  })();
  assert.ok(macUpdate);
  assert.equal(macUpdate.name, 'Trebuchet-1.0.9-arm64.dmg');

  // Scenario: user is already on latest — no asset lookup needed.
  const noUpdate = (() => {
    if (!latest || compareVersions('1.0.9', latest) >= 0) return null;
    return pickAssetForPlatform(REAL_ASSETS, 'darwin', 'arm64');
  })();
  assert.equal(noUpdate, null);

  // Scenario: user is on a dev build ahead of latest — treat as no update.
  const devBuild = (() => {
    if (!latest || compareVersions('2.0.0', latest) >= 0) return null;
    return pickAssetForPlatform(REAL_ASSETS, 'darwin', 'arm64');
  })();
  assert.equal(devBuild, null);

  // Scenario: user is behind but on an unsupported platform — caller
  // should route to the release page (signalled by the null asset).
  const exoticPlatform = (() => {
    if (!latest || compareVersions('1.0.8', latest) >= 0) return null;
    return pickAssetForPlatform(REAL_ASSETS, 'sunos', 'sparc');
  })();
  assert.equal(exoticPlatform, undefined);
});
