# DiffDash Release Guide

## Current Release Channel

DiffDash currently ships beta builds for:

- macOS arm64 and x64 DMGs plus automatic-update ZIPs, signed and notarized with Apple Developer ID
- Linux x64 AppImage with automatic updates, plus a manually updated deb

GitHub Releases are the long-term artifact archive. Cloudflare R2 is the public download mirror and keeps only the latest 3 versions.

Homebrew distribution is intentionally deferred.

## GitHub Release Flow

The primary release flow runs on standard GitHub-hosted runners. Public repositories receive these runners without Actions minute charges. Cloudflare R2 remains the stable download and updater origin.

Add a Changeset to each feature PR that changes user-visible desktop behavior:

```bash
pnpm changeset
pnpm exec changeset status
```

Changesets target only `@diffdash/desktop`. Use `patch` for fixes and small improvements, `minor` for new user-visible capabilities, and `major` only for explicitly breaking public behavior. Documentation, tests, CI, release automation, and behavior-neutral refactors normally do not need a Changeset.

After a feature PR merges, `.github/workflows/version.yml` runs the SHA-pinned `changesets/action`. It creates or updates the `changeset-release/main` pull request with the calculated desktop version, consumed Changesets, and GitHub-linked `packages/desktop/CHANGELOG.md` entries. The action uses GitHub API commit mode so its bot-authored version commit is signed by GitHub.

Review and manually merge the version PR when ready to release. Its merge triggers the Version workflow again. With no Changesets remaining, the workflow validates the version and changelog, creates the missing lightweight `v<package.version>` tag at the merge commit, and calls `.github/workflows/release.yml` directly.

Do not run `pnpm release:version`, create the version commit, or create the tag during the normal flow. Those are recovery operations. The generated tag must match `packages/desktop/package.json` exactly and point to a commit reachable from `main`.

The Release workflow:

- verifies release notes exist in `packages/desktop/CHANGELOG.md` for the desktop version
- runs `pnpm release:check`
- builds signed, notarized, and stapled macOS arm64 and x64 releases on native GitHub macOS runners
- builds the Linux x64 AppImage, updater metadata, and `.deb` on GitHub Ubuntu
- generates `SHA256SUMS` and `latest.json`
- creates or updates a draft GitHub Release for the version tag
- uploads the exact release asset matrix to the GitHub Release
- mirrors the same assets to R2 at `releases/<tag>/`
- leaves the currently promoted stable release unchanged while the GitHub Release is a draft

Review and publish the draft in GitHub. The `release: published` event then verifies the GitHub and R2 candidate, updates `stable.json` and root `latest.json`, verifies all public updater and download routes, and only then prunes R2 retention.

The Releases dashboard is also supported. Creating and publishing a release with a new matching tag starts the same workflow. The published release can briefly appear without binaries while Actions builds them; the stable updater channel remains unchanged until all assets and public checks pass. Dashboard-created lightweight tags and locally created annotated tags are both accepted.

Use the workflow's manual dispatch for recovery. Enable its `promote` input only when recovering an already-published release whose automatic promotion failed.

## Local Recovery Flow

Local scripts remain available for release recovery and debugging:

```bash
pnpm release:local
pnpm release:local -- --mac-arch arm64
pnpm release:local -- --mac-arch x64
pnpm release:local -- --mac-arch all
pnpm release:local -- --skip-checks
pnpm release:local -- --skip-mac
pnpm release:local -- --skip-linux
pnpm release:local -- --skip-publish
pnpm release:local -- --allow-published
pnpm release:local -- --assets-dir release-assets/test-run
```

Use local and skip options for recovery/debugging only. Normal releases run in GitHub Actions. `--allow-published` can add missing assets to a dashboard-published release, but refuses to replace any existing GitHub or R2 bytes.

Local builds and publishing require a clean tree, an up-to-date `origin/main`, and a release tag at `HEAD` that is reachable from `origin/main`. Publishing records and verifies the tag commit in release provenance. Existing published candidates can repair missing R2 assets only when their provenance already matches the immutable R2 candidate. Stable promotion runs only in the serialized GitHub workflow and rejects versions older than the currently promoted release.

If version-PR automation fails, authenticate the GitHub changelog generator before applying Changesets locally:

```bash
GITHUB_TOKEN="$(gh auth token)" pnpm release:version
pnpm release:notes v<package.version>
pnpm release:tag
```

Only commit, tag, or push this recovery output after reviewing it and receiving explicit approval.

To recover promotion after the GitHub Release is published, manually dispatch the `Release` workflow with the matching tag and enable its `promote` input. Local promotion is intentionally disabled so it cannot race the serialized GitHub promotion job.

Promotion verifies the published GitHub Release, both macOS architectures, Linux AppImage metadata, checksums, and the R2 mirror. It updates `stable.json` and root `latest.json`, verifies the public pointers, updater feeds, versioned files, and download redirects, then prunes R2 to the promoted release plus two retained releases. Manual downloads and automatic update clients only follow this promoted pointer.

Partial commands are available when debugging a single stage.

Build signed, notarized, stapled macOS assets locally:

```bash
pnpm release:local:mac
```

This builds the native host architecture by default. To force an architecture:

```bash
pnpm release:local:mac --arch arm64
pnpm release:local:mac --arch x64
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
pnpm release:local:mac --package-existing --skip-notarize --arch arm64
node scripts/release/notarize-app.mjs packages/desktop/dist/mac-arm64/DiffDash.app --submission-id <id>
```

Use `--package-existing --skip-notarize` only after `xcrun stapler validate` confirms an existing app is already stapled.

Build the Linux x64 AppImage and `.deb` locally through Docker:

```bash
pnpm release:local:linux
```

The local Linux build script:

- archives `HEAD` into a temporary build directory
- runs `node:22-trixie` through Docker with `--platform linux/amd64`
- installs dependencies with the pinned `pnpm` version from the root `package.json`
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
- does not change the stable download or update channel; publishing the draft triggers verified promotion in GitHub Actions

Regenerate metadata without uploading when recovering manually:

```bash
node scripts/release/publish-release-assets.mjs --metadata-only
```

## Required Local Recovery Configuration

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

GitHub Actions is the primary version and release environment. Enable **Allow GitHub Actions to create and approve pull requests** at the organization level first, then in repository **Settings > Actions > General**, so `github-actions[bot]` can maintain the Changesets version PR. Workflow permissions remain explicitly scoped in each workflow. An organization policy that disables this capability cannot be overridden by the repository.

Release jobs run only for trusted version tags, reusable calls from the Version workflow, manually dispatched recovery runs, and published GitHub Releases.

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

The workflows use GitHub's built-in `GITHUB_TOKEN` for the signed Changesets commit, version PR, release tag, reusable release call, and release upload, so no separate GitHub token is needed.

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

This runs formatting, lint, TypeScript, unit, browser, Electron, packaged Electron, release-policy,
and download-worker checks.

## Script Ownership And Caching

Repository-wide build/setup checks live in `scripts/build/`. Release orchestration lives in
`scripts/release/`. Scripts remain inside a package only when they implement that package's own
build or runtime boundary, such as desktop icon generation and native module rebuilds, persistence
fixture generation, and packaged-E2E assembly.

Signing, notarization, native rebuilds, installer packaging, GitHub draft creation, R2 upload,
promotion, deployment, captures, and media rendering are intentionally uncached because they use
host tools, credentials, external state, or generated binaries. macOS signing/notarization and DMG
packaging must run on macOS; Linux AppImage/deb packaging runs on Linux in Actions or the configured
Docker platform during local recovery; Windows NSIS must run on Windows. Turbo marks the corresponding package operations as
uncached, and the repository release commands run directly rather than through Turbo.

## Operational Evidence Record

Signing, notarization, installers, and public promotion require one retained Markdown record per
release. Store the record outside `dist/` and `release-assets/`; do not attach credentials, private
keys, notarization request payloads, user repositories, or release binaries.

Record these fields:

- Release tag, package version, commit SHA, operator, approver, UTC start/end, host OS/architecture,
  Node, pnpm, Electron, and command transcript location.
- SHA-256 for every promoted artifact and the generated `SHA256SUMS`/`latest.json` files.
- Apple notarization submission ID and final status, with secret-bearing output redacted.
- Pass/fail/not-run for each check below, including an owner and follow-up issue for every exception.

Run and retain these checks:

| Surface | Exact check | Expected result |
|---|---|---|
| macOS signature | `codesign --verify --deep --strict --verbose=2 DiffDash.app` | Exit 0 for arm64 and x64 apps. |
| macOS Gatekeeper | `spctl --assess --type execute --verbose=4 DiffDash.app` | Accepted Developer ID application. |
| macOS notarization | `xcrun stapler validate DiffDash.app` and mounted-DMG launch on a clean account | Staple validates and app launches without bypass. |
| AppImage | Launch the x64 AppImage on a clean supported Linux host | App boots; update eligibility reports AppImage support. |
| deb | Install, launch `/usr/bin/diffdash`, upgrade, remove, and inspect launcher ownership | Hook creates only the owned launcher and removal leaves unrelated files untouched. |
| Windows NSIS | Install, launch, upgrade, uninstall on supported Windows | Record `not-run` unless performed on Windows; never infer a pass from another platform. |
| Public pointers | Fetch `stable.json`, `latest.json`, and platform updater metadata with GET and HEAD | Status, version, tag, cache headers, and referenced artifact match the promoted release. |
| Public downloads | Resolve macOS arm64/x64, Linux AppImage/deb aliases and download each object | Redirect target is versioned, architecture-correct, downloadable, and matches `SHA256SUMS`. |
| Retention | List `releases/` after promotion | Promoted release plus two newest other stable versions remain; GitHub archive remains intact. |

Revalidate after release-script, package-name, signing identity, installer-hook, worker-route, R2
layout, or updater-feed changes.

## Packaging Commands

Build packages on the target operating system. Native modules such as `better-sqlite3` should not be cross-compiled.

```bash
pnpm dist:mac
pnpm dist:linux
pnpm dist:linux:deb
pnpm dist:win
```

Artifacts are written to `packages/desktop/dist/`.

## macOS

`pnpm dist:mac` builds a DMG and ZIP. Production releases use GitHub Actions; use `pnpm release:local:mac` only when debugging or recovering macOS packaging. The local macOS release stage signs the app, notarizes with visible status polling, staples the ticket, verifies the app, and copies the DMG into `release-assets/`.

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
codesign --verify --deep --strict --verbose=2 packages/desktop/dist/mac-arm64/DiffDash.app
spctl -a -vv --type exec packages/desktop/dist/mac-arm64/DiffDash.app
xcrun stapler validate packages/desktop/dist/mac-arm64/DiffDash.app
```

For x64 local builds, use `packages/desktop/dist/mac/DiffDash.app`.

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

`pnpm dist:linux` builds AppImage and deb packages on Linux. Production releases use GitHub Actions; use `pnpm release:local:linux` only when debugging or recovering Linux packaging. The local Linux release stage uses Docker to build both x64 formats from a Linux container.

The AppImage is portable and does not add `diffdash` to `PATH` automatically:

```bash
chmod +x DiffDash-*-linux-x86_64.AppImage
./DiffDash-*-linux-x86_64.AppImage
```

The in-app **Install in PATH** action creates a durable user-local launcher that points to the AppImage rather than its temporary mount. Keep the AppImage at the same path afterward. If the selected user-local bin directory is not already in the shell's `PATH`, DiffDash displays the required `export PATH=...` command. On startup, an updated AppImage refreshes marker-owned launchers found in the desktop environment's `PATH`, `~/.local/bin`, or `~/bin`; unrelated user-owned executables are never replaced. Launchers in other custom directories must be reinstalled after updating.

The deb package installs:

```text
/usr/bin/diffdash
```

as a symlink to the bundled CLI helper. Users can run `diffdash` inside a Git repository, `diffdash /path/to/repo`, `diffdash pr [pr-number]`, or `diffdash diff [branch-name]`.

## Windows

`pnpm dist:win` builds an NSIS installer. Build on Windows for native module correctness.

## GitHub Publishing

GitHub Actions publishes after all platform jobs succeed. `pnpm release:local:publish` creates or updates the GitHub Release and uploads files from `release-assets/` for recovery only.

The `electron-builder` config can still publish directly to GitHub when invoked with publishing enabled, but DiffDash release publishing should use `scripts/release/publish-release-assets.mjs` so GitHub Release and R2 metadata stay in sync. The local recovery command is:

```bash
GH_TOKEN=... pnpm release:local:publish
```

Prefer OS-specific packaging because native modules such as `better-sqlite3` should not be cross-built.
