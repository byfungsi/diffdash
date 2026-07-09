---
name: diffdash-release
description: Use when the user runs /release or asks to prepare, version, tag, or publish a DiffDash release with Changesets, CHANGELOG.md, GitHub draft Releases, and Cloudflare R2.
---

# DiffDash Release Skill

Use this skill for DiffDash desktop releases only.

## Release Model

- Release versions come from `package.json`.
- Release tags are annotated Git tags named `v<package.version>`.
- GitHub Actions builds DMG/DEB artifacts when a `v*` tag is pushed.
- GitHub Releases are created as drafts first.
- Release notes come from the matching `CHANGELOG.md` section.
- Cloudflare R2 mirrors release assets and keeps only the latest 3 semver folders.
- Blacksmith runners are used for Linux checks, Linux packaging, publish steps, and macOS arm64 packaging.
- macOS x64 packaging stays on GitHub-hosted Intel macOS because native modules should not be cross-built.
- Homebrew and Apple signing are intentionally deferred.

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

Use `pnpm release:check` when the user explicitly wants the full local gate before tagging.

## Normal Release Flow

1. Confirm the intended bump or exact version with the user if it is not clear from `/release` arguments.
2. Ensure there is a pending Changeset under `.changeset/*.md`, excluding `.changeset/README.md`.
3. If no Changeset exists, create one with the correct bump and concise user-facing summary.
4. Run `pnpm release:version` to update `package.json` and `CHANGELOG.md`.
5. Run `pnpm release:notes v<version>` and verify the extracted notes are correct.
6. Run the required checks.
7. Commit the version/changelog/changeset changes only after user approval unless the user explicitly asked to commit.
8. Run `pnpm release:tag` only after the release commit is clean.
9. Push `main` and tags only when the user explicitly asks to push.
10. Tell the user to review and publish the draft GitHub Release after the workflow succeeds.

## First Release Flow

For the initial `0.1.0` release, if `package.json` already has `0.1.0` and `CHANGELOG.md` already has `## 0.1.0`:

```bash
pnpm release:notes v0.1.0
pnpm release:tag
git push origin main --follow-tags
```

Only run the push command when the user asks to push.

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
- Do not use `changeset publish`; DiffDash releases desktop artifacts through GitHub Actions, not npm.
