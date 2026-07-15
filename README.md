# DiffDash

DiffDash is a macOS-first desktop code review app for GitHub PRs, local repositories, and AI-generated walkthroughs.

## Current Stack

- Electron via `electron-vite`
- React + TypeScript + Vite
- Effect for main-process service boundaries
- SQLite via `better-sqlite3`
- Tailwind CSS + shadcn/ui for the renderer
- oxlint recommended categories with React, React performance, accessibility, import, promise, node, and React Doctor rules
- Biome for formatting
- Husky + lint-staged for pre-commit formatting and checks
- Vitest + `@effect/vitest` for unit tests and Effect-aware scoped resources
- Vitest Browser Mode for renderer integration tests
- Playwright for Electron E2E flows
- `git`, `gh`, and eventually `codex exec` through typed main-process services
- `@pierre/diffs` and `@pierre/trees` are installed for the review workspace milestones

## Milestone 1 Scope

The current foundation includes:

- Electron app shell with React renderer
- shadcn/ui baseline components
- Effect language service and strict TypeScript setup
- SQLite schema for repos, PRs, viewed files, and walkthroughs
- Effect services for CLI execution, SQLite access, repo storage, GitHub search, and local GitHub remote detection
- Typed preload API for renderer-to-main calls
- Home screen for local repo add, remote GitHub search, and repo bookmarking

## Scripts

```bash
pnpm dev
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm test:browser
pnpm test:e2e
pnpm test:all
pnpm check
pnpm build
pnpm preview
```

## CLI

After building from source, run `pnpm exec diffdash [path]` to open DiffDash on a local repository review. When `[path]` is omitted, the CLI uses the current directory. If DiffDash is already running, the existing window is focused and navigated to that local diff.

Run `diffdash install [path]` to link a GitHub repository checkout to DiffDash. The path defaults to the current directory. For PR reviews, DiffDash copies committed Git data into an isolated worktree pool under `~/.diffdash/worktree-pool`, fetches the exact PR head, and runs the agent there without switching or cleaning your checkout.

Run `diffdash pr` inside a GitHub checkout to save it as a favorite and open its pull request list. Pass a positive pull request number, such as `diffdash pr 123`, to open that review directly.

Run `diffdash diff [branch-name]` to review the current branch and local changes relative to another branch. When the target differs from the checked-out branch, DiffDash fetches the target from `origin` without checking it out, finds its merge base with the current `HEAD`, and shows current-branch commits plus staged, unstaged, and untracked changes. Changes that exist only on the target branch are excluded. With no branch name, DiffDash uses the default branch reported by `origin/HEAD`.

Linux `.deb` packages install the desktop executable as `diffdash-desktop` and install `/usr/bin/diffdash` as the terminal CLI. The CLI opens the current directory by default and forwards to the running DiffDash window when one is already open.

Linux AppImages are portable and do not install a CLI automatically. Use the in-app **Install in PATH** action to create a user-local `diffdash` launcher, and keep the AppImage at the same path afterward. Updated apps refresh marker-owned launchers found in the desktop environment's `PATH`, `~/.local/bin`, or `~/bin`; reinstall the CLI after updating if it lives in another custom directory.

Build both Linux packages with:

```bash
pnpm dist:linux
```

Build only the Debian package with `pnpm dist:linux:deb`.

See `docs/release.md` for production packaging, signing, and publishing notes.

## Appearance

DiffDash follows the system appearance by default. To select a fixed appearance, add
`appearance` to `~/.config/diffdash/settings.json` with a value of `"light"`, `"dark"`, or
`"system"`, then restart DiffDash:

```json
{
  "appearance": "dark"
}
```

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
- `pnpm test:e2e:packaged` builds unsigned electron-builder output and verifies packaged resources, native SQLite, preload isolation, and restart persistence.
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
- narrow fakes at service boundaries, such as fake CLI output for `gh`
- real subprocesses only where the behavior under test is CLI execution itself

Browser tests require the Playwright Chromium binary once per machine:

```bash
pnpm exec playwright install chromium
```

Browser-backed tests run headless by default. Use non-headless mode only when debugging a visual or timing issue.

## Effect Guidance

Before writing Effect code, consult Effect Solutions:

```bash
effect-solutions list
effect-solutions show <topic>
```

Use the local Effect source reference at `~/.local/share/effect-solutions/effect` when API details are unclear.

## UI Guidance

Use shadcn/ui for reusable primitives and keep app-specific composition in feature components.

The shadcn config is `packages/desktop/components.json`, with aliases pointing to
`packages/app/src`.

## Required Local Tools

- `pnpm`
- `git`
- `gh` for GitHub repo and PR access
- `codex` for later AI walkthrough generation
