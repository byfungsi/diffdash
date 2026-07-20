# DiffDash Agent Guide

<!-- effect-solutions:start -->

## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.
<!-- effect-solutions:end -->

## Local Effect Source

The Effect source repository is cloned to `~/.local/share/effect-solutions/effect` for reference.
Use this to explore APIs, find usage examples, and understand implementation details when documentation is not enough.

## Project Stack

- Desktop shell: Electron through `electron-vite`.
- Renderer: React, TypeScript, Vite, Tailwind CSS, and shadcn/ui.
- Linting: oxlint with recommended categories, React plugins, and React Doctor rules.
- Formatting: Biome.
- Git hooks: Husky + lint-staged for pre-commit formatting/checks when `.git` is present.
- Testing: Vitest with `@effect/vitest` for Effect-aware tests and scoped resources.
- Main process services: Effect `Context.Tag` services and `Layer` composition.
- Persistence: SQLite through `better-sqlite3`, accessed from main-process Effect services only.
- CLI integration: `git`, `gh`, and `codex` are executed from main-process Effect services only.

## Testing Strategy

- Test cases should follow the Linear ticket acceptance criteria. Make it clear which criteria are covered and which remain untested.
- Write unit tests for utilities, parsers, data adapters, Effect services, and isolated components. Use Vitest and `@effect/vitest`; test Effect code through services/layers and fakes at service boundaries.
- Write integration tests with Vitest Browser Mode for page and component interaction. Use this when acceptance criteria involve composed renderer components, UI state transitions, and browser-level behavior without needing the full Electron shell.
- Write E2E tests for complete user flows through the real app shell. Cover critical flows such as app boot, preload IPC wiring, repository search, opening review requests, review navigation, and diff rendering.
- E2E tests should use deterministic fixtures or fake CLI binaries for `gh`, `git`, and `codex` instead of relying on local auth, local repositories, or network state.
- Run browser-backed tests headless by default. Only switch to non-headless mode when actively debugging a visual or timing issue.

## Architecture Rules

- Keep Node, Electron, SQLite, and CLI access out of the renderer.
- Expose renderer capabilities through typed preload APIs.
- Model main-process dependencies as Effect services with explicit layers.
- Provide Effect layers once at the app boundary rather than inside business logic.
- Use `Schema.Class` and `Schema.TaggedError` for shared data and recoverable errors.
- Use shadcn/ui components from `packages/app/src/components/ui` for reusable UI primitives.
- Keep feature UI in `packages/app/src` and platform/service logic in `packages/desktop/src/main/services`.
- Run `pnpm format`, `pnpm lint`, `pnpm typecheck`, and `pnpm build` after significant bootstrap or architecture changes.
- Run `pnpm test` when changing service, parsing, persistence, CLI, or Effect layer behavior.
- Do not bypass React Doctor findings by adding memoization by default; first prefer simpler component boundaries or stable event patterns.

## Frontend Design System Rules

- Use Tailwind CSS v4 theme tokens as the source of truth for colors, spacing, sizing, radius, borders, shadows, typography, and motion.
- Catalog new colors and design values into the theme before using them in feature UI. Avoid one-off arbitrary values unless they are temporary, isolated, and justified.
- Build reusable design-system primitives first, then compose feature UI from those primitives. Avoid scattered HTML with random styling across feature code.
- Keep light mode work compatible with future dark mode by using semantic tokens instead of hard-coded surface, text, border, and accent values.
- Treat bring-your-own-theme support as a product requirement: new UI should be easy to retheme without rewriting components.
- When a feature needs a new visual pattern, decide whether it belongs in `packages/app/src/components/ui` or a feature-local component before adding styles inline.

## TypeScript Coding Standards

- Prefer correctness, safety, and debuggability over convenience; follow local architecture before introducing new patterns.
- Treat expected failures as values. In this repo, use Effect errors (`Schema.TaggedError`) for domain, parsing, CLI, persistence, and integration failures.
- Parse at boundaries and keep the parsed value. Use Effect Schema or cohesive smart constructors instead of validating and passing raw DTOs around.
- Use branded/refined/domain types for meaningful primitives when they cross module boundaries, especially IDs, paths, URLs, SHAs, and review keys.
- Model meaningful lifecycle states with tagged unions or schemas instead of nullable bags and boolean combinations.
- Keep a functional core and imperative shell: domain parsing/decisions stay pure; Electron, SQLite, CLI, filesystem, and network work stays in main-process services/layers.
- Before creating a new adapter/service, audit existing services and either reuse, extend, or document why a new cohesive capability is justified.
- Keep repositories/persistence adapters domain-oriented. Parse raw rows before returning from infrastructure services.
- Avoid `any`, non-null assertions, and unchecked casts. If an interop cast is unavoidable, include a `SAFETY:` comment explaining the invariant.
- Prefer `import type` for type-only imports and avoid barrel files by default.
- Add JSDoc for exported project-owned functions, classes, interfaces, constants, and types. shadcn-generated primitives are exempt unless modified beyond styling/composition.
- Do not log secrets or raw credentials. Use `Redacted.Redacted` for sensitive config or tokens when introduced.
- Tests should use real seams: Effect layers, SQLite/local DB tests, and fakes at service boundaries rather than module mocks.
