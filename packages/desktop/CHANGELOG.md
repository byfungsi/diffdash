# DiffDash Changelog

## 0.16.1

### Patch Changes

- [#118](https://github.com/byfungsi/diffdash/pull/118) [`9b650b5`](https://github.com/byfungsi/diffdash/commit/9b650b50431f0a1230aa230ecb8e74b89f0a6bc5) Thanks [@hanipcode](https://github.com/hanipcode)! - Keep Review note creation available from diff gutters when an OpenCode session is connected.

## 0.16.0

### Minor Changes

- [#116](https://github.com/byfungsi/diffdash/pull/116) [`1f8da41`](https://github.com/byfungsi/diffdash/commit/1f8da4121c70fccc77e79d9f7697bfae2e3ac214) Thanks [@hanipcode](https://github.com/hanipcode)! - Add persistent source-line notes that can be collected across Code and Review, copied together, or sent to an OpenCode session.

## 0.15.1

### Patch Changes

- [#113](https://github.com/byfungsi/diffdash/pull/113) [`63710b2`](https://github.com/byfungsi/diffdash/commit/63710b2f7573d27214a1d09faf6c5604830ae4aa) Thanks [@hanipcode](https://github.com/hanipcode)! - Fix diff expansion and symbol navigation, including stable reference panes when review tokens rerender.

- [#113](https://github.com/byfungsi/diffdash/pull/113) [`63710b2`](https://github.com/byfungsi/diffdash/commit/63710b2f7573d27214a1d09faf6c5604830ae4aa) Thanks [@hanipcode](https://github.com/hanipcode)! - Forward comments using the current OpenCode V2 prompt contract, expand hosted review context from the exact base revision in 20-line increments, keep diff gutter actions stable across review renders, and preserve review language-navigation sessions through Strict Mode lifecycle replay.

- [#113](https://github.com/byfungsi/diffdash/pull/113) [`63710b2`](https://github.com/byfungsi/diffdash/commit/63710b2f7573d27214a1d09faf6c5604830ae4aa) Thanks [@hanipcode](https://github.com/hanipcode)! - Reuse language workspaces across Code and Diff, keep navigation previews stable, and recover hosted reviews and cached resources reliably.

## 0.15.0

### Minor Changes

- [#111](https://github.com/byfungsi/diffdash/pull/111) [`628cc28`](https://github.com/byfungsi/diffdash/commit/628cc287c4f4e9c611f8e30be8f44027237c0bae) Thanks [@hanipcode](https://github.com/hanipcode)! - Expand collapsed diff context and navigate definitions and references directly from review code.

## 0.14.0

### Minor Changes

- [#110](https://github.com/byfungsi/diffdash/pull/110) [`43bf52b`](https://github.com/byfungsi/diffdash/commit/43bf52bd284eca551c7ba595a4f39d72b6fada23) Thanks [@hanipcode](https://github.com/hanipcode)! - Add hosted pull request overviews with checks, review actions, branch updates, and guarded merges.

### Patch Changes

- [#108](https://github.com/byfungsi/diffdash/pull/108) [`2a02b57`](https://github.com/byfungsi/diffdash/commit/2a02b57809f307f08fb5ebb880fcb7d1b52f8f3f) Thanks [@hanipcode](https://github.com/hanipcode)! - Fix OpenCode comments for the current OpenCode V2 API.

## 0.13.1

### Patch Changes

- [#106](https://github.com/byfungsi/diffdash/pull/106) [`d4ce747`](https://github.com/byfungsi/diffdash/commit/d4ce747079b966302f4e7301983505ca7303f4c7) Thanks [@hanipcode](https://github.com/hanipcode)! - Resolve clean local reviews without leaving the working-tree source loading indefinitely.

- [#105](https://github.com/byfungsi/diffdash/pull/105) [`712503f`](https://github.com/byfungsi/diffdash/commit/712503f196ce2ddcb70ab2d235a3a03a02e86091) Thanks [@hanipcode](https://github.com/hanipcode)! - Stream large Code workspace files through Core and Electron while keeping rendering responsive.

- [#103](https://github.com/byfungsi/diffdash/pull/103) [`d062970`](https://github.com/byfungsi/diffdash/commit/d06297049af6765d4165e27d20fc9c9176a596f4) Thanks [@hanipcode](https://github.com/hanipcode)! - Add keyboard shortcuts to refresh Code and open project ribbon items by their displayed order.

- [#107](https://github.com/byfungsi/diffdash/pull/107) [`edf411e`](https://github.com/byfungsi/diffdash/commit/edf411ebb827c6c744281d957afe92a78e233267) Thanks [@hanipcode](https://github.com/hanipcode)! - Keep changed files in the same order in the review file tree and diff view.

## 0.13.0

### Minor Changes

- [#92](https://github.com/byfungsi/diffdash/pull/92) [`76d3c38`](https://github.com/byfungsi/diffdash/commit/76d3c38e0179dcef0de2ffdefb205c85ce8e9d58) Thanks [@hanipcode](https://github.com/hanipcode)! - Add global back and forward navigation across reviews, code files, and definition jumps.

- [#101](https://github.com/byfungsi/diffdash/pull/101) [`12836c7`](https://github.com/byfungsi/diffdash/commit/12836c7773a98c6b2d6957d56d96f8daabbc33c0) Thanks [@hanipcode](https://github.com/hanipcode)! - Make Review, Code, Walkthrough, and Review Comments independently removable trusted built-in
  extensions with registry-owned surfaces, ribbon activities, pane slots, lifecycle providers, and
  schema-encoded navigation repair.

## 0.12.0

### Minor Changes

- [#90](https://github.com/byfungsi/diffdash/pull/90) [`fec316e`](https://github.com/byfungsi/diffdash/commit/fec316e9ee7a45cea220ca23b394978f3a626a9d) Thanks [@hanipcode](https://github.com/hanipcode)! - Connect review comments to project-scoped OpenCode sessions or DiffDash's built-in review agent.

- [#91](https://github.com/byfungsi/diffdash/pull/91) [`f404d27`](https://github.com/byfungsi/diffdash/commit/f404d274e13094acdac8765469bb51d6a2355a81) Thanks [@hanipcode](https://github.com/hanipcode)! - Add repository code navigation with definition and reference lookup across projects and saved review snapshots.

### Patch Changes

- [#88](https://github.com/byfungsi/diffdash/pull/88) [`169ecd3`](https://github.com/byfungsi/diffdash/commit/169ecd37e9665b25a07b6d519a358df50cd71e47) Thanks [@hanipcode](https://github.com/hanipcode)! - Recover hosted repositories from surviving Git worktrees and improve diff navigation consistency.

## 0.11.0

### Minor Changes

- [#86](https://github.com/byfungsi/diffdash/pull/86) [`8936ef4`](https://github.com/byfungsi/diffdash/commit/8936ef4ede052e7066b6f5f2468ddb03b8023e23) Thanks [@hanipcode](https://github.com/hanipcode)! - Browse project code from isolated managed worktrees without including local uncommitted changes.

  The Code ribbon lazily loads large repositories, opens review files at the review's exact revision,
  and keeps active workspaces protected with renewable leases and automatic cleanup. The read-only
  viewer supports repository and in-file search while safely rejecting oversized, binary, invalid,
  non-regular, or checkout-escaping files.

### Patch Changes

- [#85](https://github.com/byfungsi/diffdash/pull/85) [`0d03f1c`](https://github.com/byfungsi/diffdash/commit/0d03f1c1bed0bda5e414b9dde3a2104fa5defe2e) Thanks [@hanipcode](https://github.com/hanipcode)! - Keep CLI launches alive until the DiffDash desktop window is ready.

## 0.10.0

### Minor Changes

- [#83](https://github.com/byfungsi/diffdash/pull/83) [`b3aee8c`](https://github.com/byfungsi/diffdash/commit/b3aee8c510ce60a45ee08f815855961c3b17e46b) Thanks [@hanipcode](https://github.com/hanipcode)! - Run application services in one authenticated external Core process and assemble complete review files eagerly from bounded persisted range reads.

  DiffDash qualifies a packaged Bun host when available and otherwise uses Electron's utility-process
  host. Host selection ends before Core takes database ownership; runtime failures never fall back to a
  second SQLite owner. Git and agent providers now execute in Core rather than Electron.

  Complete files load with bounded concurrency and remain available for the active review, while Pierre
  virtualizes lines within each file. Exact immutable Git comparisons may regenerate bounded ranges
  lazily, while mutable or remote sources retain a managed spool. Syntax highlighting remains deferred,
  and oversized or unsupported content can stay in plain-text mode.

## 0.9.1

### Patch Changes

- [#81](https://github.com/byfungsi/diffdash/pull/81) [`65cce5b`](https://github.com/byfungsi/diffdash/commit/65cce5b7e09953eb5ba1805534b3e077420b9c9f) Thanks [@hanipcode](https://github.com/hanipcode)! - Prevent local review thread loading from repeatedly refreshing, and keep E2E desktop windows hidden.

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
