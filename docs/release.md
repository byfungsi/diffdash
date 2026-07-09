# DiffDash Release Guide

## Current Release Channel

DiffDash currently ships unsigned beta builds for:

- macOS arm64 DMG
- macOS x64 DMG
- Linux x64 deb

GitHub Releases are the long-term artifact archive. Cloudflare R2 is the public download mirror and keeps only the latest 3 versions.

Homebrew and Apple Developer ID signing are intentionally deferred.

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
- builds macOS arm64 DMG on a macOS arm64 runner
- builds macOS x64 DMG on an Intel macOS runner
- builds Linux x64 deb on Ubuntu
- creates or updates a draft GitHub Release
- uploads release assets, `latest.json`, and `SHA256SUMS` to the draft release
- uses the matching `CHANGELOG.md` section as draft release notes
- mirrors the same assets to R2 at `releases/<tag>/`
- writes `latest.json` at the R2 bucket root
- prunes R2 release folders to keep only the latest 3 semver versions

Review the draft GitHub Release before publishing it manually.

## Required GitHub Configuration

Configure these in GitHub under `Settings` -> `Secrets and variables` -> `Actions`.

Secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

Variables:

- `R2_BUCKET`, for example `diffdash-releases`
- `R2_PUBLIC_BASE_URL`, for example `https://downloads.diffdash.dev`

The R2 access key must be able to list, upload, and delete objects in the release bucket.

The workflow uses GitHub's built-in `GITHUB_TOKEN` for draft release creation, so no separate GitHub token is needed.

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

The current beta builds are unsigned and not notarized. Users may need to open the app through:

```text
Right-click DiffDash.app -> Open -> Open
```

or:

```text
System Settings -> Privacy & Security -> Open Anyway
```

For public distribution, sign and notarize on macOS with Apple Developer credentials available to `electron-builder`.

Common environment variables:

```bash
CSC_LINK=/path/to/developer-id-application.p12
CSC_KEY_PASSWORD=...
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
