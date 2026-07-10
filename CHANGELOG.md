# DiffDash Changelog

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
