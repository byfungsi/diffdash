# DiffDash Release Guide

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

`pnpm dist:mac` builds a DMG and ZIP. For public distribution, sign and notarize on macOS with Apple Developer credentials available to `electron-builder`.

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

The `electron-builder` config is set to publish to GitHub when invoked with publishing enabled. Use `GH_TOKEN` in CI:

```bash
GH_TOKEN=... pnpm dist -- --publish=always
```

Prefer OS-specific CI jobs so each platform builds its own native modules.
