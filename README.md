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

Linux `.deb` packages install the desktop executable as `diffdash-desktop` and install `/usr/bin/diffdash` as the terminal CLI. The CLI opens the current directory by default and forwards to the running DiffDash window when one is already open.

Build a Linux deb with:

```bash
pnpm dist:linux:deb
```

See `docs/release.md` for production packaging, signing, and publishing notes.

## Quality Gates

- `pnpm format` writes Biome formatting across supported source and config files.
- `pnpm lint` runs oxlint with recommended correctness, suspicious, and performance coverage plus React Doctor rules.
- `pnpm test` runs unit tests for utilities, Effect services, persistence, CLI adapters, and isolated components.
- `pnpm test:browser` runs Vitest Browser Mode interaction tests for composed renderer behavior.
- `pnpm test:e2e` rebuilds native modules for Electron, builds the app, and runs Playwright Electron E2E tests.
- `pnpm test:all` runs unit, browser integration, and Electron E2E tests in sequence.
- `pnpm check` runs formatting check, lint, TypeScript, and tests.
- `.husky/pre-commit` runs lint-staged auto-formatting, `pnpm typecheck`, and `pnpm test` once the folder is inside a Git repository and `pnpm prepare` has run.

## Testing Guidance

Test cases should follow Linear ticket acceptance criteria. Make it clear which criteria are covered and which remain untested.

Use `@effect/vitest` for Effect code. Prefer `it.effect` and `it.scoped` over manually running Effect programs inside plain Vitest tests.

Use three levels of tests:

- Unit tests for utilities, parsers, data adapters, Effect services, persistence, CLI adapters, and isolated components.
- Vitest Browser Mode integration tests for page/component interaction and renderer state transitions.
- Playwright Electron E2E tests for complete flows through the real app shell, preload IPC, main-process services, and renderer.

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

This workspace is currently not a Git repository, so Husky hook installation is skipped until `.git` exists.

## Effect Guidance

Before writing Effect code, consult Effect Solutions:

```bash
effect-solutions list
effect-solutions show <topic>
```

Use the local Effect source reference at `~/.local/share/effect-solutions/effect` when API details are unclear.

## UI Guidance

Use shadcn/ui for reusable primitives and keep app-specific composition in feature components.

The shadcn config is `components.json`, with aliases pointing to `src/renderer/src`.

## Required Local Tools

- `pnpm`
- `git`
- `gh` for GitHub repo and PR access
- `codex` for later AI walkthrough generation
