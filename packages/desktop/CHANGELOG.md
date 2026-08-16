# DiffDash Changelog

## 0.9.0

### Minor Changes

- [#79](https://github.com/byfungsi/diffdash/pull/79) [`39902f8`](https://github.com/byfungsi/diffdash/commit/39902f8886700f247d2d9da546b8b9e2b342aa43) Thanks [@hanipcode](https://github.com/hanipcode)! - Review branches, tags, commit SHAs, and HEAD from local repositories, including immutable comparisons without a hosted remote.

## 0.8.1

### Patch Changes

- [#77](https://github.com/byfungsi/diffdash/pull/77) [`abe328a`](https://github.com/byfungsi/diffdash/commit/abe328a5e4247b037063c336d03ceace0e3c1a5a) Thanks [@hanipcode](https://github.com/hanipcode)! - Detect Codex installations managed by Bun when launching DiffDash from the desktop.

## 0.8.0

### Minor Changes

- [#75](https://github.com/byfungsi/diffdash/pull/75) [`d225812`](https://github.com/byfungsi/diffdash/commit/d2258123479a8f2320523f6b5f2117122d76a4cc) Thanks [@hanipcode](https://github.com/hanipcode)! - Add a last-commit CLI review command and reload review diffs with Cmd+R or Ctrl+R.

### Patch Changes

- [#67](https://github.com/byfungsi/diffdash/pull/67) [`d4e5af0`](https://github.com/byfungsi/diffdash/commit/d4e5af0da120961f16b0f0b06f89d26c2cbf5cac) Thanks [@hanipcode](https://github.com/hanipcode)! - Extract the runtime-neutral embedded DiffDash Core foundation, move durable stores onto Effect SQL's
  generic client with Node and Bun SQLite adapters, and keep Electron focused on native host
  responsibilities.

- [#72](https://github.com/byfungsi/diffdash/pull/72) [`5dd2706`](https://github.com/byfungsi/diffdash/commit/5dd2706b3806b18577f6ebbb9d497d74be4e528b) Thanks [@hanipcode](https://github.com/hanipcode)! - Allow reviewers to navigate back to an already-selected file after scrolling away from it.

## 0.7.2

### Patch Changes

- [#70](https://github.com/byfungsi/diffdash/pull/70) [`ac38132`](https://github.com/byfungsi/diffdash/commit/ac381320341f573b85d7435fb0791cdd6cfefefd) Thanks [@hanipcode](https://github.com/hanipcode)! - Improve code readability by reducing the intensity of diff highlights.

- [#69](https://github.com/byfungsi/diffdash/pull/69) [`2b4a61d`](https://github.com/byfungsi/diffdash/commit/2b4a61d71f40041b42b0d087c86270a273f69a5f) Thanks [@hanipcode](https://github.com/hanipcode)! - Add a diff-line context menu for copying exact file references and a keyboard shortcut for toggling the project sidebar.

- [#69](https://github.com/byfungsi/diffdash/pull/69) [`2b4a61d`](https://github.com/byfungsi/diffdash/commit/2b4a61d71f40041b42b0d087c86270a273f69a5f) Thanks [@hanipcode](https://github.com/hanipcode)! - Extract the runtime-neutral embedded DiffDash Core foundation and keep Electron focused on native host responsibilities.

## 0.7.1

### Patch Changes

- [#65](https://github.com/byfungsi/diffdash/pull/65) [`2e432fa`](https://github.com/byfungsi/diffdash/commit/2e432fa6e60e87a8fc2833a4c53a878943a86fe2) Thanks [@hanipcode](https://github.com/hanipcode)! - Show actionable, privacy-safe provider failure guidance in walkthroughs and AI review threads.

## 0.7.0

### Minor Changes

- [#63](https://github.com/byfungsi/diffdash/pull/63) [`f937c31`](https://github.com/byfungsi/diffdash/commit/f937c31982d2656c6ea6aab1e93317f06eba7494) Thanks [@hanipcode](https://github.com/hanipcode)! - Open immutable repository revision comparisons from the CLI with `diffdash compare`.

### Patch Changes

- [#63](https://github.com/byfungsi/diffdash/pull/63) [`f937c31`](https://github.com/byfungsi/diffdash/commit/f937c31982d2656c6ea6aab1e93317f06eba7494) Thanks [@hanipcode](https://github.com/hanipcode)! - Show actionable walkthrough failure messages and let users copy privacy-safe error details for support.

## 0.6.0

### Minor Changes

- [#54](https://github.com/byfungsi/diffdash/pull/54) [`c74db1f`](https://github.com/byfungsi/diffdash/commit/c74db1faf8200bfda72770aff3eb6cbd5021c935) Thanks [@hanipcode](https://github.com/hanipcode)! - Add a permanent titlebar control for discovering and opening the global keyboard shortcut reference.

### Patch Changes

- [#60](https://github.com/byfungsi/diffdash/pull/60) [`3fa2689`](https://github.com/byfungsi/diffdash/commit/3fa268981d27cb111ee21b40cd8197015f2593e1) Thanks [@hanipcode](https://github.com/hanipcode)! - Refine review thread navigation and walkthrough sidebar controls for clearer, responsive review workflows.

- [#62](https://github.com/byfungsi/diffdash/pull/62) [`fad3724`](https://github.com/byfungsi/diffdash/commit/fad3724a5a52b259e2908e00049d62de090bb95f) Thanks [@hanipcode](https://github.com/hanipcode)! - Show actionable walkthrough failure messages and let users copy privacy-safe error details for support.

- [#53](https://github.com/byfungsi/diffdash/pull/53) [`597cba0`](https://github.com/byfungsi/diffdash/commit/597cba008a5fdb78e1d53be210051d451cd90a1d) Thanks [@hanipcode](https://github.com/hanipcode)! - Recognize supported user-local DiffDash CLI installations as setup-ready even when Electron inherits a restricted PATH.

## 0.5.0

### Minor Changes

- [#17](https://github.com/byfungsi/diffdash/pull/17) [`ae5782c`](https://github.com/byfungsi/diffdash/commit/ae5782c11ffdc3b95bb3fcb9d2a3d24f104df867) Thanks [@hanipcode](https://github.com/hanipcode)! - Restore anonymous product analytics configuration in automated desktop release builds.
  Start review search from the active file, target the viewed shortcut at the file under the pointer, stabilize collapsed-file navigation, and middle-truncate long review paths.
  Add an application-wide, platform-aware keyboard shortcut reference.

## 0.4.3

### Patch Changes

- [#15](https://github.com/byfungsi/diffdash/pull/15) [`ee95be0`](https://github.com/byfungsi/diffdash/commit/ee95be00d903e77578c9692491cb0064744a3498) Thanks [@hanipcode](https://github.com/hanipcode)! - Scope review navigation results to the active sidebar and clarify walkthrough sections with their full paths.

## 0.4.2

### Patch Changes

- [#13](https://github.com/byfungsi/diffdash/pull/13) [`3d1c7e6`](https://github.com/byfungsi/diffdash/commit/3d1c7e69910cc7d66c30c05676aacb725681bab1) Thanks [@hanipcode](https://github.com/hanipcode)! - Keep provider readiness checks reliable under load by allowing command output streams enough time to close after the command exits.

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
