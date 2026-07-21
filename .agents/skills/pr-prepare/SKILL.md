---
name: pr-prepare
description: Prepare a DiffDash pull request by auditing branch attribution, creating or validating a desktop Changeset, and running relevant checks. Use when the user asks to prepare a PR or invokes pr-prepare.
compatibility: Requires git, GitHub CLI, Node.js, and pnpm in the DiffDash repository.
---

# DiffDash PR Preparation

Prepare the current branch for review without committing, pushing, or opening a pull request.

## Guardrails

- Never create a normal commit. The user owns every feature-branch commit.
- Never push, force-push, or open a pull request unless the user separately and explicitly requests it.
- Never rewrite branch history without showing the offending commits and receiving explicit approval.
- Never rewrite `main`, a detached HEAD, commits reachable from `origin/main`, or a dirty working tree.
- Never discard changes. Before an approved rewrite, create a local backup branch and report its name.
- Treat GitHub automation commits on the Changesets version PR as the only allowed bot-authored exception.
- Do not add agent attribution, `Co-authored-by`, `Assisted-by`, `Generated-by`, or similar trailers.
- Do not expose tokens or credentials. Never print `GITHUB_TOKEN`.

## 1. Establish The Branch

1. Run `git status --short`, `git branch --show-current`, `git diff --stat`, and `git log --oneline -10`.
2. Fetch `origin/main` when network access is available. If fetching fails, state that the local base may be stale.
3. Stop if the current branch is `main` or HEAD is detached.
4. Use `origin/main` as the comparison base unless the user explicitly supplies another base.
5. Inspect committed and uncommitted changes. Do not modify unrelated work already present in the tree.

## 2. Audit Commit Attribution

1. Read the intended identity from `git config user.name` and `git config user.email`. Stop if either is missing.
2. Inspect every commit in `origin/main..HEAD`, including author, committer, and full message.
3. Flag commits whose author or committer differs from the configured identity.
4. Flag only attribution trailers or generated-by notices that identify an AI agent. Do not flag ordinary product text containing words such as agent, Claude, Codex, or OpenCode.
5. If nothing is flagged, continue without rewriting history.
6. If anything is flagged, show the commit hashes and exact reasons, then ask for explicit rewrite approval.
7. After approval, require a clean working tree and create a local backup branch named `pr-prepare-backup/<branch>-<timestamp>`.
8. Use a non-interactive history rewrite limited to `origin/main..HEAD` to set author and committer to the configured identity and remove only the flagged attribution lines. Preserve commit contents, ordering, and all other message text.
9. Re-run the audit and compare the final tree with the backup branch. Stop if file contents changed.
10. If the branch exists on a remote, report that its history changed. Do not force-push without a separate explicit request.

## 3. Decide Whether A Changeset Is Required

Review the complete branch diff, not only the latest commit.

A Changeset is required for:

- user-visible features, fixes, behavior changes, or performance improvements
- new or changed desktop CLI behavior
- new provider capabilities exposed to users or provider authors
- compatibility or migration changes that affect installed applications

A Changeset is normally omitted for:

- documentation-only changes
- tests and fixtures without product behavior changes
- CI, release automation, and repository maintenance
- behavior-neutral refactors and package moves

If classification or bump size is ambiguous, ask one concise question before writing a Changeset.

## 4. Create Or Validate The Changeset

1. Inspect `.changeset/*.md`, excluding `.changeset/README.md`.
2. Do not duplicate a pending Changeset that already describes the branch.
3. Every releasable Changeset must target only `@diffdash/desktop`.
4. Use `patch` for fixes and small improvements, `minor` for new user-visible capabilities, and `major` only for explicitly breaking public behavior.
5. Write a concise user-facing summary. Do not describe implementation mechanics or invent behavior.
6. Use this format:

```markdown
---
"@diffdash/desktop": patch
---

Describe the user-visible change.
```

7. Do not run `changeset version`; the Changesets version PR owns package and changelog updates.
8. Run `pnpm exec changeset status` and confirm no ignored workspace package is scheduled for release.

## 5. Verify The Branch

1. Run the checks relevant to the changed files.
2. For application or service changes, run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` at minimum.
3. For release infrastructure changes, also run `pnpm release:infrastructure:check` and `actionlint` when available.
4. Inspect `git diff --check` and the final `git status --short`.
5. Summarize the Changeset decision, checks run, failures, and any remaining user-owned commit or push steps.

Do not report the branch as ready while required checks fail, attribution remains, or a required Changeset is missing.
