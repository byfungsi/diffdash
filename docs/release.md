# DiffDash Release Guide

## Current Release Channel

DiffDash currently ships beta builds for:

- macOS arm64 and x64 DMGs plus automatic-update ZIPs, signed and notarized with Apple Developer ID
- Linux x64 AppImage with automatic updates, plus a manually updated deb

GitHub Releases are the long-term artifact archive. Cloudflare R2 is the public download mirror and keeps only the latest 3 versions.

Homebrew distribution is intentionally deferred.

## Local Release Flow

The primary release flow runs locally to avoid paying CI runner time while Apple notarization is queued.

Prepare the release version and tag:

```bash
pnpm changeset
pnpm release:version
git add package.json pnpm-lock.yaml CHANGELOG.md .changeset
git commit -m "chore: release v0.1.1"
pnpm release:tag
git push origin main --tags
```

The tag must match the `package.json` version exactly. For example, `package.json` version `0.1.1` must use tag `v0.1.1`.

`pnpm release:version` applies pending Changesets and updates `CHANGELOG.md`. The GitHub draft release notes are extracted from the matching `CHANGELOG.md` section.

Run the complete local release flow:

```bash
pnpm release:local
```

The single command:

- verifies release notes exist in `CHANGELOG.md` for `v<package.version>`
- runs `pnpm release:check`
- builds both signed, notarized, stapled macOS DMGs and updater ZIPs into `release-assets/`
- builds the Linux x64 AppImage, updater metadata, and `.deb` in Docker into `release-assets/`
- generates `SHA256SUMS` and `latest.json`
- creates or updates a draft GitHub Release for the version tag
- uploads all `release-assets/` files to the draft GitHub Release
- mirrors the same assets to R2 at `releases/<tag>/`
- leaves the currently promoted stable release unchanged while the GitHub Release is a draft

The command requires a clean working tree. The tag must match the `package.json` version and exist in Git. If the tag does not point at `HEAD`, the script warns because local artifacts are built from the current checkout. Add `-- --require-tag-at-head` when you want that to be a hard failure.

Useful options:

```bash
pnpm release:local -- --mac-arch arm64
pnpm release:local -- --mac-arch x64
pnpm release:local -- --mac-arch all
pnpm release:local -- --skip-checks
pnpm release:local -- --skip-mac
pnpm release:local -- --skip-linux
pnpm release:local -- --skip-publish
pnpm release:local -- --assets-dir release-assets/test-run
```

Use skip options for recovery/debugging only. The normal release command should run without skip flags.

Review and publish the draft GitHub Release, then promote it:

```bash
pnpm release:promote -- --tag v<package.version>
```

Promotion verifies the published GitHub Release, both macOS architectures, Linux AppImage metadata, checksums, and the R2 mirror. It then updates `stable.json` and root `latest.json`, and prunes R2 to the promoted release plus two retained releases. Manual downloads and automatic update clients only follow this promoted pointer.

Partial commands are available when debugging a single stage.

Build signed, notarized, stapled macOS assets locally:

```bash
pnpm release:local:mac
```

This builds the native host architecture by default. To force an architecture:

```bash
pnpm release:local:mac -- --arch arm64
pnpm release:local:mac -- --arch x64
```

The local macOS build script:

- builds a signed `.app`
- submits it to Apple notarization with visible status polling
- staples the accepted notarization ticket
- packages the stapled app into a DMG and updater ZIP
- verifies `codesign`, Gatekeeper assessment, and stapling
- copies release DMGs, ZIPs, blockmaps, and architecture-specific updater metadata to `release-assets/`

Recovery options:

```bash
pnpm release:local:mac -- --package-existing --skip-notarize --arch arm64
node scripts/notarize-app.mjs dist/mac-arm64/DiffDash.app --submission-id <id>
```

Use `--package-existing --skip-notarize` only after `xcrun stapler validate` confirms an existing app is already stapled.

Build the Linux x64 AppImage and `.deb` locally through Docker:

```bash
pnpm release:local:linux
```

The local Linux build script:

- archives `HEAD` into a temporary build directory
- runs `node:22-trixie` through Docker with `--platform linux/amd64`
- installs dependencies with the pinned `pnpm` version from `package.json`
- rebuilds native modules for Electron on Linux
- builds the Linux AppImage with its embedded blockmap, updater metadata, and `.deb`
- copies all Linux release and updater artifacts to `release-assets/`

Override Docker defaults when needed:

```bash
RELEASE_LINUX_IMAGE=node:22-trixie pnpm release:local:linux
RELEASE_LINUX_PLATFORM=linux/amd64 pnpm release:local:linux
```

Publish the assets in `release-assets/` to the draft GitHub Release and R2:

```bash
pnpm release:local:publish
```

The local publish script:

- generates `SHA256SUMS`
- generates `latest.json`
- creates or updates a draft GitHub Release for the package version tag
- uploads all `release-assets/` files to the draft GitHub Release with per-file retries
- mirrors the same assets to R2 at `releases/<tag>/`
- does not change the stable download or update channel until `pnpm release:promote` runs

Regenerate metadata without uploading when recovering manually:

```bash
node scripts/publish-release-assets.mjs --metadata-only
```

## Required Local Configuration

Local release scripts load `.env` from the repository root automatically. Existing shell environment variables take precedence over values in `.env`. To use another file, set `DIFFDASH_ENV_FILE=/path/to/file`.

Apple signing and notarization:

```dotenv
APPLE_API_KEY=/absolute/path/to/AuthKey_XXXXXXXXXX.p8
APPLE_API_KEY_ID=XXXXXXXXXX
APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

If the Developer ID Application certificate is installed in Keychain, no `CSC_LINK` is needed. Verify the identity exists:

```bash
security find-identity -v -p codesigning
```

Optionally pin the signing identity:

```dotenv
CSC_NAME="Muhammad Hanif (9M558GH62J)"
```

Electron Builder expects `CSC_NAME` without the `Developer ID Application:` prefix. The local macOS release script also strips that prefix for compatibility with older `.env` files.

If using a `.p12` certificate export instead of Keychain, also set:

```dotenv
CSC_LINK=/absolute/path/to/DeveloperIDApplication.p12
CSC_KEY_PASSWORD=your_p12_export_password
```

GitHub draft release publishing:

```dotenv
GH_TOKEN=github_pat_or_classic_token_with_repo_access
```

`GH_TOKEN` is optional if `gh auth status` already shows an authenticated account with access to `byfungsi/diffdash`.

Cloudflare R2 publishing:

```dotenv
CLOUDFLARE_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=diffdash
R2_PUBLIC_BASE_URL=https://download.usediffdash.com
```

Do not commit `.env`, `.p12`, or `.p8` files. They are ignored by `.gitignore`.

Required local CLIs:

- `gh`, authenticated for GitHub Release creation/upload
- `aws`, configured by the release script from the R2 env vars
- `docker`, for building the Linux AppImage and `.deb` locally through a Linux container
- Xcode command line tools, including `xcrun notarytool` and `stapler`

The R2 access key must be able to list, upload, and delete objects in the release bucket.

## Required GitHub Actions Configuration

GitHub Actions release builds are manual-only fallback jobs. Configure these only if using the manual `Release` workflow.

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

- `R2_BUCKET`, for example `diffdash`
- `R2_PUBLIC_BASE_URL`, for example `https://download.usediffdash.com`

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

`pnpm dist:mac` builds a DMG and ZIP. For releases, prefer `pnpm release:local` for the full flow or `pnpm release:local:mac` when debugging macOS packaging only. The local macOS release stage signs the app, notarizes with visible status polling, staples the ticket, verifies the app, and copies the DMG into `release-assets/`.

Release macOS builds are signed with a Developer ID Application certificate, notarized through App Store Connect API key credentials, and stapled by Electron Builder before packaging.

For local signed builds, install the Developer ID Application certificate in Keychain or point Electron Builder at a `.p12` export:

```bash
security find-identity -v -p codesigning
export CSC_LINK=/absolute/path/to/DeveloperIDApplication.p12
export CSC_KEY_PASSWORD=...
export APPLE_API_KEY=/absolute/path/to/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
pnpm release:local:mac
```

`APPLE_API_KEY` must be an absolute path to the `.p8` file when running locally.

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

`pnpm dist:linux` builds AppImage and deb packages on Linux. For releases, prefer `pnpm release:local` for the full flow or `pnpm release:local:linux` when debugging Linux packaging only. The local Linux release stage uses Docker to build both x64 formats from a Linux container.

The AppImage is portable and does not add `diffdash` to `PATH` automatically:

```bash
chmod +x DiffDash-*-linux-x86_64.AppImage
./DiffDash-*-linux-x86_64.AppImage
```

The in-app **Install in PATH** action creates a durable user-local launcher that points to the AppImage rather than its temporary mount. Keep the AppImage at the same path afterward. If the selected user-local bin directory is not already in the shell's `PATH`, DiffDash displays the required `export PATH=...` command.

The deb package installs:

```text
/usr/bin/diffdash
```

as a symlink to the bundled CLI helper. Users can run `diffdash` inside a Git repository or `diffdash /path/to/repo`.

## Windows

`pnpm dist:win` builds an NSIS installer. Build on Windows for native module correctness.

## GitHub Publishing

`pnpm release:local` runs publishing after packaging succeeds. `pnpm release:local:publish` creates or updates the draft GitHub Release and uploads the files from `release-assets/` when debugging publishing only.

The `electron-builder` config can still publish directly to GitHub when invoked with publishing enabled, but DiffDash release publishing should use the local publish script so GitHub Release and R2 metadata stay in sync:

```bash
GH_TOKEN=... pnpm release:local:publish
```

Prefer OS-specific packaging because native modules such as `better-sqlite3` should not be cross-built.
