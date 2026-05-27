# Releasing Trebuchet

Tagged releases are built by [`.github/workflows/release.yml`](../.github/workflows/release.yml) from a clean checkout using `npm ci`.
After the desktop artifacts are published to GitHub Releases, the same workflow uploads the static [`website/`](../website) directory to the production site.

## Trigger

Push a Git tag that starts with `v`, for example `v1.2.3`.

The workflow builds:

- macOS arm64 DMG
- macOS x64 DMG
- Windows NSIS installer
- Windows portable EXE
- Linux AppImage
- Linux deb

## Trust model

- macOS artifacts are **signed and notarized** only when both `CSC_LINK` and `CSC_KEY_PASSWORD` are present **and** one complete Apple notarization credential set is configured:
  - `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, or
  - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, or
  - `APPLE_KEYCHAIN`, `APPLE_KEYCHAIN_PROFILE`.
- If the macOS credentials are absent, the workflow still builds macOS **unsigned test artifacts** and marks the release accordingly.
- Windows installer and portable EXE artifacts are **signed** only when `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` are configured.
- If the Windows credentials are absent, the workflow still builds Windows installer and portable EXE **unsigned test artifacts** and marks the release accordingly.
- Linux AppImage and deb artifacts are built as **unsigned** packages.

If any desktop artifact is published as an unsigned test artifact, the workflow marks the GitHub Release as a prerelease.

## Verification

Every release attaches `SHA256SUMS.txt`.

Verify downloads locally with:

```bash
shasum -a 256 -c SHA256SUMS.txt
```

The release notes also state which platform artifacts were signed, notarized, unsigned, or unsigned test artifacts.

## Repeatability

The workflow updates an existing release for the same tag by re-uploading assets with `--clobber`, then rewriting the release notes. That keeps reruns on the same `v*` tag usable after a failed or partial run.

## Website publishing

The release workflow publishes [`website/`](../website) over FTP after the GitHub Release is created.

Required secrets:

- `FTP_LOGIN`
- `FTP_PASSWORD`

Optional repository variables:

- `FTP_HOST` (defaults to `makesometokens.com`)
- `FTP_PROTOCOL` (defaults to `ftp`)
- `FTP_REMOTE_DIR` (defaults to `.`)

The deploy step uploads only newer files and does not delete remote files by default.
