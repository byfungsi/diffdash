# DiffDash

DiffDash is a macOS-first desktop code review app for hosted reviews, local repositories, and
AI-generated walkthroughs and review threads. GitHub, Claude, Codex, and OpenCode are current built-in
providers behind provider-neutral Git and agent contracts.

## Current Stack

- Electron via `electron-vite`
- React + TypeScript + Vite
- Effect for main-process service boundaries
- Effect SQL with `node:sqlite` and `bun:sqlite` runtime adapters
- Tailwind CSS + shadcn/ui for the renderer
- oxlint recommended categories with React, React performance, accessibility, import, promise, node, and React Doctor rules
- Biome for formatting
- Husky + lint-staged for pre-commit formatting and checks
- Vitest + `@effect/vitest` for unit tests and Effect-aware scoped resources
- Vitest Browser Mode for renderer integration tests
- Playwright for Electron E2E flows
- `git`, `gh`, Claude, Codex, and OpenCode through typed main-process services and provider packages
- `@pierre/diffs` and `@pierre/trees` render review diffs and file trees

## Architecture

The workspace separates browser-safe domain/protocol/application packages, an embedded Effect Core,
main-process infrastructure, provider-neutral orchestration, and concrete provider leaves. Electron
is the native host and renderer trust boundary; Core owns the business runtime. Renderer code reaches
Node, SQLite, Git, CLIs, and updater capabilities only through the typed preload protocol.

Concrete Git and agent integrations are built-in leaf packages registered only by Core composition.
These package boundaries are dependency and ownership boundaries, not runtime
sandboxing. See `docs/architecture.md`, `docs/git-provider-authoring.md`, and
`docs/agent-provider-authoring.md` for the package graph, allowed directions, extension templates,
security requirements, tests, and release policy.

## Scripts

```bash
pnpm dev
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm test:browser
pnpm test:e2e
pnpm test:e2e:packaged
pnpm test:all
pnpm check
pnpm build
pnpm preview
```

## CLI

After building from source, run `pnpm exec diffdash [path]` to open that project in DiffDash with its local changes and hosted pull requests in one workspace. When `[path]` is omitted, the CLI uses the current directory. If DiffDash is already running, the existing window is focused and navigated to the project's Reviews ribbon. Use `diffdash diff [branch-name]` when you want to open an explicit local branch comparison directly.

DiffDash identifies a project from its resolved Git `origin`, not the checkout folder name. Provider resolution follows hosted repository renames and stores the provider's stable repository ID, so renamed repositories and multiple local checkouts converge into one project. Run `diffdash repair` to retry offline resolution and restore legacy local aliases without rewriting existing review records. The command opens or focuses DiffDash, runs the repair there, and reports the result in the app.

Run `diffdash install [path]` to link a GitHub repository checkout to DiffDash. The path defaults to the current directory. For PR reviews, DiffDash copies committed Git data into an isolated worktree pool under `~/.diffdash/worktree-pool`, fetches the exact PR head, and runs the agent there without switching or cleaning your checkout.

Run `diffdash pr` inside a GitHub checkout to save it as a favorite and open its pull request list. Pass a positive pull request number, such as `diffdash pr 123`, to open that review directly.

Run `diffdash diff [branch-name]` to review the current branch and local changes relative to another branch. When the target differs from the checked-out branch, DiffDash fetches the target from `origin` without checking it out, finds its merge base with the current `HEAD`, and shows current-branch commits plus staged, unstaged, and untracked changes. Changes that exist only on the target branch are excluded. With no branch name, DiffDash uses the default branch reported by `origin/HEAD`.

Run `diffdash last-commit` or `diffdash lc` to review the current `HEAD` commit against its first parent. Root commits are compared with Git's empty tree, and staged, unstaged, and untracked changes are excluded.

Run `diffdash compare <base> <head>` inside a Git checkout to review an immutable merge-base-to-head comparison from that repository. Both revisions may be branch names, tags, or full commit SHAs. Use `--repository=<namespace/name>` to select a different saved or linked repository. The unqualified `namespace/name` shorthand is accepted only when exactly one configured provider matches; DiffDash never assumes GitHub. Qualify ambiguous repositories explicitly, for example `diffdash compare v6.0 v6.1 --repository=github:torvalds/linux`.

Linux `.deb` packages install the desktop executable as `diffdash-desktop` and install `/usr/bin/diffdash` as the terminal CLI. The CLI opens the current directory by default and forwards to the running DiffDash window when one is already open.

Linux AppImages are portable and do not install a CLI automatically. Use the in-app **Install CLI** action to create a user-local `diffdash` launcher, and keep the AppImage at the same path afterward. Updated apps refresh marker-owned launchers found in the desktop environment's `PATH`, `~/.local/bin`, or `~/bin`; reinstall the CLI after updating if it lives in another custom directory.

Build both Linux packages with:

```bash
pnpm dist:linux
```

Build only the Debian package with `pnpm dist:linux:deb`.

See `docs/release.md` for production packaging, signing, and publishing notes.

## Appearance

DiffDash follows the system appearance by default. To select a fixed appearance, add
`appearance` to `~/.config/diffdash/settings.json` with a value of `"light"`, `"dark"`, or
`"system"`. The `themes` object independently selects the palette used for each color scheme:

```json
{
  "appearance": "system",
  "themes": {
    "light": "catppuccin-latte",
    "dark": "catppuccin-mocha"
  },
  "codeThemes": {
    "light": "rose-pine-dawn",
    "dark": "diffdash-dark"
  }
}
```

Light themes are `"diffdash"` and `"catppuccin-latte"`. Dark themes are `"diffdash"`,
`"catppuccin-frappe"`, `"catppuccin-macchiato"`, and `"catppuccin-mocha"`. Restart DiffDash after
editing the file.

`codeThemes` controls source highlighting independently from the application palette. Supported
light code themes are `"rose-pine-dawn"`, `"catppuccin-latte"`, `"github-light-default"`, and
`"pierre-light-soft"`. Supported dark code themes are `"rose-pine-moon"`,
`"catppuccin-frappe"`, `"catppuccin-macchiato"`, `"catppuccin-mocha"`,
`"github-dark-default"`, `"pierre-dark-soft"`, and `"diffdash-dark"`.

Keep the existing `provider`, `models`, and telemetry fields when editing the file. If
`XDG_CONFIG_HOME` is set, DiffDash reads `$XDG_CONFIG_HOME/diffdash/settings.json` instead.

## Anonymous Telemetry

DiffDash can send anonymous installation and product-usage events to the configured PostHog
project. The first-run checkbox is enabled by default, but no telemetry is sent until onboarding is
completed. DiffDash does not collect source code, repository details, paths, prompts, comments,
personal information, or raw error messages. Autocapture, session replay, person profiles, and
geolocation enrichment are disabled.

The preference is stored in `~/.config/diffdash/settings.json`. To opt out manually, set
`telemetryEnabled` to `false` and restart DiffDash:

```json
{
  "telemetryEnabled": false
}
```

Keep the existing `provider` and `models` fields when editing the file. Packaged builds read the
public PostHog project configuration from `VITE_POSTHOG_KEY` and `VITE_POSTHOG_HOST` at build time;
the Electron build falls back to the same values in `packages/web/.env`, and analytics is a no-op
when either value is missing.

## Quality Gates

- `pnpm format` writes Biome formatting across supported source and config files.
- `pnpm lint` runs oxlint with recommended correctness, suspicious, and performance coverage plus React Doctor rules.
- `pnpm test` runs unit tests for utilities, Effect services, persistence, CLI adapters, and isolated components.
- `pnpm test:browser` runs Vitest Browser Mode interaction tests for composed renderer behavior.
- `pnpm test:e2e` rebuilds native modules for Electron, builds the app, and runs Playwright Electron E2E tests.
- `pnpm test:e2e:packaged` launches the existing unsigned electron-builder target and verifies ASAR,
  updater and CLI resources, native SQLite, packaged branches, preload isolation, deterministic Git
  and agent provider composition, and restart persistence without authentication or network access.
- `pnpm test:all` runs unit, browser integration, Electron E2E, and download-worker tests in sequence.
- `pnpm check` runs formatting check, lint, TypeScript, and tests.
- `.husky/pre-commit` runs lint-staged auto-formatting, `pnpm typecheck`, and `pnpm test` once the folder is inside a Git repository and `pnpm prepare` has run.

## Testing Guidance

Test cases should follow Linear ticket acceptance criteria. Make it clear which criteria are covered and which remain untested.

Use `@effect/vitest` for Effect code. Prefer `it.effect` and `it.scoped` over manually running Effect programs inside plain Vitest tests.

Use three levels of tests:

- Unit tests for utilities, parsers, data adapters, Effect services, persistence, CLI adapters, and isolated components.
- Vitest Browser Mode integration tests for page/component interaction and renderer state transitions.
- Playwright Electron E2E tests for complete flows through the real app shell, preload IPC, main-process services, and renderer.

The primary Electron E2E flow also closes and relaunches DiffDash against the same user-data and
settings directories. It verifies preload isolation, SQLite-backed viewed files, completed review
threads, cached walkthroughs, and source-checkout safety across a real application restart.

Tests should use real seams:

- Effect layers for service dependencies
- temp SQLite databases for persistence behavior
- narrow fakes at service boundaries, including deterministic Git, hosted provider, and agent fixtures
- real subprocesses only where the behavior under test is CLI execution itself

Browser tests require the Playwright Chromium binary once per machine:

```bash
pnpm exec playwright install chromium
```

Browser-backed tests run headless by default. Use non-headless mode only when debugging a visual or timing issue.

## Effect Guidance

OpenCode reads the repository's `effect` skill before writing Effect code and exposes the upstream
`Effect-TS/effect` `main` branch as the `@effect` reference. The exact versions in the workspace
catalog and installed package types remain the compatibility authority while Effect v4 is in beta.

## UI Guidance

Use shadcn/ui for reusable primitives and keep app-specific composition in feature components.

The shadcn config is `packages/desktop/components.json`, with aliases pointing to
`packages/app/src`.

## Required Local Tools

- `pnpm`
- `git`
- `gh` for GitHub repo and PR access
- at least one supported agent runtime: Claude, Codex, or OpenCode
