# DiffDash Changelog

## 0.4.1

### Patch Changes

- [#11](https://github.com/byfungsi/diffdash/pull/11) [`97eb2ab`](https://github.com/byfungsi/diffdash/commit/97eb2ab7784f5836597d9c446b3b4222b3984225) Thanks [@hanipcode](https://github.com/hanipcode)! - Discover OpenCode from `~/.opencode/bin` after desktop launches without shadowing other CLI tools, keep packaged upgrades on the stable application data path, create recovery-safe SQLite backups before schema migrations, and surface bookmark load failures with retry.

## 0.4.0

### Minor Changes

- [#6](https://github.com/byfungsi/diffdash/pull/6) [`c9badbe`](https://github.com/byfungsi/diffdash/commit/c9badbed1688cb12dc95ac6e973f9fe2bc24287f) Thanks [@hanipcode](https://github.com/hanipcode)! - Add an extensible provider architecture for isolated Git integrations and AI review agents.

## 0.3.1

### Patch Changes

- 17f57be: Restore macOS automatic updates by packaging the updater configuration required to download releases.

- 7cfaf16: Compare `diffdash diff` reviews from the branches' merge base so target-only changes no longer appear as unrelated reverse changes.

## 0.3.0

### Minor Changes

- ac41cc9: Add CLI commands for opening repository pull requests and comparing the current worktree with a fetched target branch.

### Patch Changes

- 836b595: Reliably forward CLI commands to an already-running DiffDash instance and show actionable repository errors.

## 0.2.1

### Patch Changes

- 16e436b: Fix DiffDash CLI installation from AppImages and reduce cold-start delays on Linux.

## 0.2.0

### Minor Changes

- 9218c82: Add automatic desktop updates, isolated AI review threads for remote GitHub pull requests, and more reliable walkthrough generation for longer-running agents.

## 0.1.4

### Patch Changes

- Sign and notarize macOS release builds with Apple Developer ID credentials.

## 0.1.3

### Patch Changes

- Fix Codex walkthrough generation from packaged apps and add Auto model tiers for Best, Balance, and Fast routing.

## 0.1.2

### Patch Changes

- Fix macOS and Linux CLI discovery from packaged desktop builds and install the bundled `diffdash` command into a user-local bin directory when no writable PATH directory exists.

## 0.1.1

### Patch Changes

- Add Debian package maintainer metadata so Linux release builds can produce `.deb` artifacts.

## 0.1.0

Initial unsigned beta release.

### Added

- Desktop review workspace for GitHub pull requests and local repository changes.
- AI walkthrough generation with bounded diff prompt preparation.
- macOS arm64 and x64 DMG release artifacts.
- Linux x64 deb release artifact with `/usr/bin/diffdash` CLI symlink.
- Draft GitHub Release workflow with Cloudflare R2 mirroring and latest-3 R2 retention.
