---
name: diffdash-release
description: Use when the user runs /release or asks to prepare, version, tag, build, notarize, publish, or recover a DiffDash desktop release through GitHub Actions, GitHub Releases, and Cloudflare R2.
---

# DiffDash Release Skill

Use this skill for DiffDash desktop releases only.

## Release Model

- Release versions come from `packages/desktop/package.json`.
- User-visible feature PRs add Changesets for `@diffdash/desktop`; internal workspaces are not independently versioned.
- Pushing Changesets to `main` makes `.github/workflows/version.yml` create or update one bot-authored version PR.
- The organization and repository Actions settings must allow GitHub Actions to create pull requests.
- The user manually merges the version PR after reviewing the calculated version and changelog.
- Merging the version PR creates the matching lightweight `v<package.version>` tag and calls `.github/workflows/release.yml`.
- Stable release tags are named `v<package.version>` and must point to a commit reachable from `main`.
- Locally created annotated tags and GitHub dashboard-created lightweight tags are supported.
- Pushing a `v*` tag starts `.github/workflows/release.yml` on GitHub-hosted Ubuntu, macOS arm64, and macOS Intel runners.
- A pushed tag builds and stages a draft GitHub Release plus an immutable R2 candidate.
- Publishing the draft triggers stable R2 promotion, public endpoint verification, and retention cleanup.
- Publishing a new release directly from GitHub's Releases dashboard also works. The release can briefly be public without binaries while Actions builds them; the stable channel changes only after verification.
- Release notes come from the matching `packages/desktop/CHANGELOG.md` section.
- Cloudflare R2 remains the public download and updater origin and retains the promoted release plus two other stable versions.
- `pnpm release:local` and its partial commands are recovery/debugging tools, not the normal release path.
- Homebrew and Windows distribution remain intentionally deferred.

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

Use `pnpm release:check` when the user explicitly requests the full local release gate. GitHub Actions always runs it before building a missing candidate.

## Normal Release Flow

1. Ensure each releasable feature PR has a pending Changeset under `.changeset/*.md`, excluding `.changeset/README.md`.
2. If a releasable change has no Changeset, create one for `@diffdash/desktop` with the correct bump and concise user-facing summary.
3. Run `pnpm exec changeset status` and the required checks before the feature PR is merged.
4. After the feature PR merges, monitor the `Version` workflow and its `changeset-release/main` pull request.
5. Verify the version PR computes the intended version and that `packages/desktop/CHANGELOG.md` contains accurate GitHub-linked notes.
6. Do not merge the version PR on the user's behalf. The user manually merges it when ready to release.
7. Monitor the resulting `Version` run until it creates the matching tag and starts the reusable `Release` workflow.
8. Monitor the Release workflow until checks, both macOS jobs, Linux, GitHub upload, and R2 candidate staging pass.
9. Tell the user to review and publish the draft GitHub Release.
10. Monitor the `release: published` run until promotion and public verification pass.
11. Do not call the release complete until the GitHub Release is published and the public stable, updater, and download endpoints report the new version.

## Dashboard Release Flow

When the user explicitly wants to create the release in GitHub's dashboard:

1. Require a `v<package.version>` tag targeting a commit reachable from `main`.
2. Publishing the dashboard release starts the same workflow.
3. The workflow preserves the published release title and notes, attaches the verified assets, mirrors R2, and promotes stable after public checks.
4. Warn that the GitHub Release can appear without binaries while builds run; existing updater clients remain on the previous stable release during that window.

## Recovery

- If version-PR automation fails, inspect the `Version` workflow before changing package versions manually.
- `GITHUB_TOKEN="$(gh auth token)" pnpm release:version` is a recovery command because the GitHub changelog generator requires authentication.
- `pnpm release:tag` can recover a missing tag after the version commit is on `main`.
- Manually dispatch the `Release` workflow with a tag to retry it.
- Enable the `promote` input only when recovering an already-published release whose automatic promotion failed.
- `pnpm release:local:mac`, `pnpm release:local:linux`, and `pnpm release:local:publish` recover individual local stages.
- Manually dispatch the `Release` workflow with `promote` enabled to recover stable promotion after the GitHub Release is published; local promotion is disabled.
- `pnpm release:verify -- --tag v<version>` reruns public endpoint verification without changing release state.
- If updater routes fail while the R2 stable pointer is correct, run download-worker tests, confirm Wrangler authentication, deploy the worker, and verify again.
- Local build and publishing recovery requires a clean tree, an up-to-date `origin/main`, and the release tag at `HEAD` and reachable from `origin/main`.
- Existing candidate repair requires matching immutable R2 provenance, and promotion refuses to downgrade the stable channel.

Local scripts load `.env` from the repository root without overriding existing shell values. Never print or commit `.env`, `.p12`, `.p8`, signing credentials, GitHub tokens, or R2 credentials.

## Changeset Format

```markdown
---
"@diffdash/desktop": patch
---

Describe the user-visible change.
```

Use `patch` for fixes and small improvements, `minor` for new user-visible features, and `major` only for breaking public behavior.

## Guardrails

- Never tag if the working tree is dirty.
- Never tag a version that differs from `packages/desktop/package.json`.
- Never release a tag whose commit is outside `main`.
- Never invent release notes; use Changesets and `packages/desktop/CHANGELOG.md`.
- Never commit or expose signing, GitHub, Apple, or R2 credentials.
- Do not run `pnpm release:version` or create a version commit during the normal feature PR flow; the version PR owns those changes.
- Do not merge the bot-authored version PR for the user.
- Do not use `changeset publish`; DiffDash ships desktop artifacts, not npm packages.
- Do not push, publish a GitHub Release, manually dispatch a workflow retry, or promote manually unless the user explicitly asks.
- Do not report a release as complete while it is a draft, while Actions is failing, before stable promotion, or while public updater feeds fail.
