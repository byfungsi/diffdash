# DiffDash Release Guide

## Current Release Channel

DiffDash currently ships beta builds for:

- macOS arm64 DMG, signed and notarized with Apple Developer ID in CI
- macOS x64 DMG, signed and notarized with Apple Developer ID in CI
- Linux x64 deb

GitHub Releases are the long-term artifact archive. Cloudflare R2 is the public download mirror and keeps only the latest 3 versions.

Homebrew distribution is intentionally deferred.

## GitHub Actions Release Flow

The release workflow runs from tags that match `v*` and creates a draft GitHub Release first.

```bash
pnpm changeset
pnpm release:version
git add package.json pnpm-lock.yaml CHANGELOG.md .changeset
git commit -m "chore: release v0.1.1"
pnpm release:tag
git push origin main --follow-tags
```

The tag must match the `package.json` version exactly. For example, `package.json` version `0.1.1` must use tag `v0.1.1`.

`pnpm release:version` applies pending Changesets and updates `CHANGELOG.md`. The GitHub draft release notes are extracted from the matching `CHANGELOG.md` section.

For the initial beta release, commit `package.json` version `0.1.0` and `CHANGELOG.md`, then run:

```bash
pnpm release:tag
git push origin main --follow-tags
```

The workflow:

- runs `pnpm release:check`
- builds signed and notarized macOS arm64 DMG on a Blacksmith macOS arm64 runner
- builds signed and notarized macOS x64 DMG on a GitHub-hosted Intel macOS runner because native modules should not be cross-built
- builds Linux x64 deb on a Blacksmith Ubuntu x64 runner
- validates macOS code signing, Gatekeeper assessment, and notarization stapling before uploading artifacts
- creates or updates a draft GitHub Release
- uploads release assets, `latest.json`, and `SHA256SUMS` to the draft release
- uses the matching `CHANGELOG.md` section as draft release notes
- mirrors the same assets to R2 at `releases/<tag>/`
- writes `latest.json` at the R2 bucket root
- prunes R2 release folders to keep only the latest 3 semver versions

Review the draft GitHub Release before publishing it manually.

The release workflow uses Blacksmith runners for Linux checks, Linux packaging, publish steps, and macOS arm64 packaging. Install the Blacksmith GitHub App for this repository before running releases. The macOS x64 build intentionally stays on GitHub's Intel macOS runner until Blacksmith offers Intel macOS runners or DiffDash has a tested cross-build path for native modules.

## Required GitHub Configuration

Configure these in GitHub under `Settings` -> `Secrets and variables` -> `Actions`.

Secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `CSC_LINK`: base64-encoded Developer ID Application `.p12` certificate export
- `CSC_KEY_PASSWORD`: password for the `.p12` certificate export
- `APPLE_API_KEY_BASE64`: base64-encoded App Store Connect Team API key `.p8` file
- `APPLE_API_KEY_ID`: App Store Connect API key ID
- `APPLE_API_ISSUER`: App Store Connect issuer ID

Variables:

- `R2_BUCKET`, for example `diffdash-releases`
- `R2_PUBLIC_BASE_URL`, for example `https://downloads.diffdash.dev`

The R2 access key must be able to list, upload, and delete objects in the release bucket.

The workflow uses GitHub's built-in `GITHUB_TOKEN` for draft release creation, so no separate GitHub token is needed.

Create `CSC_LINK` from the exported Developer ID Application certificate:

```bash
base64 < DeveloperIDApplication.p12 | tr -d '\n'
```

Create `APPLE_API_KEY_BASE64` from the downloaded App Store Connect API key:

```bash
base64 < AuthKey_XXXXXXXXXX.p8 | tr -d '\n'
```

Use an App Store Connect Team API key, not an Individual API key. The key should have App Manager access.

## R2 Layout

Versioned assets are uploaded under:

```text
releases/v0.1.0/
```

The public latest metadata file is uploaded to:

```text
latest.json
```

R2 retention keeps only the latest 3 version folders by semver. GitHub Releases keep every uploaded release artifact unless manually deleted.

## Release Checks

Run the release gate before packaging:

```bash
pnpm release:check
```

This runs formatting checks, lint, TypeScript, unit tests, browser tests, and a production build.

## Packaging Commands

Build packages on the target operating system. Native modules such as `better-sqlite3` should not be cross-compiled.

```bash
pnpm dist:mac
pnpm dist:linux
pnpm dist:linux:deb
pnpm dist:win
```

Artifacts are written to `dist/`.

## macOS

`pnpm dist:mac` builds a DMG and ZIP. The automated release workflow currently publishes DMG only for arm64 and x64.

Release macOS builds are signed with a Developer ID Application certificate, notarized through App Store Connect API key credentials, and stapled by Electron Builder before packaging.

For local signed builds, install the Developer ID Application certificate in Keychain or point Electron Builder at a `.p12` export:

```bash
security find-identity -v -p codesigning
export CSC_LINK=/absolute/path/to/DeveloperIDApplication.p12
export CSC_KEY_PASSWORD=...
export APPLE_API_KEY=/absolute/path/to/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
pnpm dist:mac
```

`APPLE_API_KEY` must be an absolute path to the `.p8` file when running locally. In GitHub Actions, the workflow writes `APPLE_API_KEY_BASE64` to a temporary `.p8` file and sets `APPLE_API_KEY` automatically.

Verify a local signed build with:

```bash
codesign --verify --deep --strict --verbose=2 dist/mac-arm64/DiffDash.app
spctl -a -vv --type exec dist/mac-arm64/DiffDash.app
xcrun stapler validate dist/mac-arm64/DiffDash.app
```

For x64 local builds, use `dist/mac/DiffDash.app`.

Alternative Apple ID notarization credentials are also supported by Electron Builder:

```bash
APPLE_ID=...
APPLE_APP_SPECIFIC_PASSWORD=...
APPLE_TEAM_ID=...
```

DMG installs do not automatically add `diffdash` to `PATH`. The app bundle includes a CLI helper at:

```text
DiffDash.app/Contents/Resources/bin/diffdash
```

Use an in-app install action or Homebrew cask to symlink that helper into a PATH directory.

## Linux

`pnpm dist:linux` builds AppImage and deb packages. Build on Linux.

The deb package installs:

```text
/usr/bin/diffdash
```

as a symlink to the bundled CLI helper. Users can run `diffdash` inside a Git repository or `diffdash /path/to/repo`.

## Windows

`pnpm dist:win` builds an NSIS installer. Build on Windows for native module correctness.

## GitHub Publishing

The automated workflow creates a draft GitHub Release and uploads artifacts with the built-in `GITHUB_TOKEN`.

The `electron-builder` config can still publish directly to GitHub when invoked with publishing enabled. Use `GH_TOKEN` in CI:

```bash
GH_TOKEN=... pnpm dist -- --publish=always
```

Prefer OS-specific CI jobs so each platform builds its own native modules.
