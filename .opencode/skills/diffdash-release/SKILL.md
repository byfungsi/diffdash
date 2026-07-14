---
name: diffdash-release
description: Use when the user runs /release or asks to prepare, version, tag, build, notarize, or publish a DiffDash release locally with Changesets, CHANGELOG.md, GitHub draft Releases, and Cloudflare R2.
---

# DiffDash Release Skill

Use this skill for DiffDash desktop releases only.

## Release Model

- Release versions come from `package.json`.
- Release tags are annotated Git tags named `v<package.version>`.
- Local release scripts are the default release path. Do not rely on GitHub Actions for normal releases.
- GitHub Actions release workflow is manual-only fallback and should not be triggered unless explicitly requested.
- `pnpm release:local` is the normal one-command flow: checks, macOS build/sign/notarize/staple/verify, Linux Docker AppImage and `.deb` builds, GitHub draft Release publishing, and R2 mirroring.
- `pnpm release:local:mac`, `pnpm release:local:linux`, and `pnpm release:local:publish` are partial commands for recovery/debugging.
- GitHub Releases are created or updated as drafts first.
- Release notes come from the matching `CHANGELOG.md` section.
- Cloudflare R2 mirrors release assets and keeps only the latest 3 semver folders.
- Linux AppImage and `.deb` artifacts are built locally through Docker using a Linux container.
- Homebrew distribution is intentionally deferred.

## Required Checks

Before committing or tagging, inspect:

```bash
git status --short
git diff --stat
git log --oneline -10
```

Run at least:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

Use `pnpm release:check` when the user explicitly wants the full local gate before tagging or before publishing.

## Normal Local Release Flow

1. Confirm the intended bump or exact version with the user if it is not clear from `/release` arguments.
2. Ensure there is a pending Changeset under `.changeset/*.md`, excluding `.changeset/README.md`.
3. If no Changeset exists, create one with the correct bump and concise user-facing summary.
4. Run `pnpm release:version` to update `package.json` and `CHANGELOG.md`.
5. Run `pnpm release:notes v<version>` and verify the extracted notes are correct.
6. Run the required checks.
7. Commit the version/changelog/changeset changes only after user approval unless the user explicitly asked to commit.
8. Run `pnpm release:tag` only after the release commit is clean.
9. Push `main` and tags only when the user explicitly asks to push.
10. After confirming local `.env` and Docker are available, run `pnpm release:local` for the full release flow.
11. Tell the user to review and publish the draft GitHub Release after local publishing succeeds.
12. Run `pnpm release:promote -- --tag v<version>` only after the GitHub Release is published; this activates manual downloads and automatic updates.

## Local Release Environment

Local release scripts load `.env` from the repository root automatically. Existing shell environment variables override `.env` values. Use `DIFFDASH_ENV_FILE=/path/to/file` only if the user wants a different env file.

Required for macOS signing/notarization:

```dotenv
APPLE_API_KEY=/absolute/path/to/AuthKey_XXXXXXXXXX.p8
APPLE_API_KEY_ID=XXXXXXXXXX
APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
CSC_NAME="Muhammad Hanif (9M558GH62J)"
```

Electron Builder expects `CSC_NAME` without the `Developer ID Application:` prefix. The local macOS release script strips that prefix for compatibility with older `.env` files.

If using a `.p12` export instead of a Keychain-installed certificate, also require:

```dotenv
CSC_LINK=/absolute/path/to/DeveloperIDApplication.p12
CSC_KEY_PASSWORD=your_p12_export_password
```

Required for GitHub/R2 publishing:

```dotenv
GH_TOKEN=github_token_with_repo_access
CLOUDFLARE_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=diffdash
R2_PUBLIC_BASE_URL=https://download.usediffdash.com
```

`GH_TOKEN` is optional if `gh auth status` already has access to `byfungsi/diffdash`.

Never print or commit env values. `.env`, `.p12`, and `.p8` files are ignored and must stay untracked.

## Local Script Behavior

`pnpm release:local`:

- Requires a clean working tree unless `-- --allow-dirty` is passed for testing only.
- Verifies `CHANGELOG.md` has notes for `v<package.version>`.
- Runs `pnpm release:check` unless `-- --skip-checks` is passed.
- Runs the macOS release stage unless `-- --skip-mac` is passed.
- Runs the Linux Docker release stage unless `-- --skip-linux` is passed.
- Runs the publish stage unless `-- --skip-publish` is passed.
- Builds both macOS architectures by default so stable promotion cannot strand an installed architecture.
- Warns if the release tag does not point at `HEAD`; `-- --require-tag-at-head` makes that a hard failure.

`pnpm release:local:mac`:

- Builds the host macOS architecture by default.
- Supports `-- --arch arm64`, `-- --arch x64`, or `-- --arch all`.
- Builds a signed `.app` with Electron Builder.
- Notarizes with `scripts/notarize-app.mjs`, which shows status polling and retries transient status read failures.
- Staples the accepted notarization ticket.
- Packages the stapled app into a DMG and updater ZIP.
- Verifies `codesign`, Gatekeeper assessment, and stapling.
- Copies DMGs, ZIPs, blockmaps, and architecture-specific updater metadata into `release-assets/`.
- Supports `-- --package-existing --skip-notarize --arch <arch>` only for recovery after an existing app has already been stapled and validated.
- `scripts/notarize-app.mjs` supports `--submission-id <id>` to resume polling/stapling an existing Apple notarization submission without rebuilding or resubmitting.

`pnpm release:local:linux`:

- Requires Docker.
- Archives `HEAD` into a temporary build directory.
- Runs `node:22-trixie` through Docker with `--platform linux/amd64` by default.
- Installs dependencies with the pinned `pnpm` version from `package.json`.
- Rebuilds native modules for Electron on Linux.
- Builds the Linux x64 AppImage, blockmap, updater metadata, and `.deb`.
- Copies all Linux release and updater artifacts into `release-assets/`.

`pnpm release:local:publish`:

- Reads assets from `release-assets/`.
- Generates `SHA256SUMS` and `latest.json`.
- Creates or updates the draft GitHub Release for `v<package.version>`.
- Uploads all `release-assets/` files to the draft GitHub Release with per-file retries.
- Mirrors the same files to R2 at `releases/<tag>/`.
- Does not modify the promoted stable channel while the GitHub Release is a draft.
- Supports `--metadata-only` to regenerate `SHA256SUMS` and `latest.json` without publishing.

`pnpm release:promote -- --tag v<version>`:

- Requires the GitHub Release to be published and non-prerelease.
- Requires both macOS architectures and Linux x64 updater artifacts.
- Verifies the R2 mirror before changing stable state.
- Updates R2 `stable.json` and root `latest.json`, then prunes retained releases.

## First Release Flow

For the initial `0.1.0` release, if `package.json` already has `0.1.0` and `CHANGELOG.md` already has `## 0.1.0`:

```bash
pnpm release:notes v0.1.0
pnpm release:tag
git push origin main --tags
```

Only run the push command when the user asks to push. Build and publish with the normal local release flow afterward.

## Changeset Format

Use this shape when creating a Changeset manually:

```markdown
---
"diffdash": patch
---

Describe the user-visible change.
```

Use `patch` for fixes and small improvements, `minor` for new user-visible features, and `major` only for breaking public behavior.

## Guardrails

- Never tag if the working tree is dirty.
- Never tag a version that does not match `package.json`.
- Never invent release notes; use Changesets and `CHANGELOG.md`.
- Never commit secrets or real credentials.
- Do not use `changeset publish`; DiffDash releases desktop artifacts through local scripts, not npm.
- Do not trigger GitHub Actions release runs unless the user explicitly asks for the manual fallback.
- Do not assume GitHub secrets are readable; GitHub Actions secrets are write-only after creation.
