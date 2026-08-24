# DiffDash Agent Guide

## Effect Best Practices

**IMPORTANT:** Always load the repository's `effect` skill before writing Effect code.
Inspect the pinned package types and configured `@effect` source reference instead of relying on memory or Effect v2/v3 examples.
The pinned package is the compatibility authority because the reference follows upstream `main`.

## Project Stack

- Desktop shell: Electron through `electron-vite`.
- Renderer: React, TypeScript, Vite, Tailwind CSS, and shadcn/ui.
- Linting: oxlint with recommended categories, React plugins, and React Doctor rules.
- Formatting: Biome.
- Git hooks: Husky + lint-staged for pre-commit formatting/checks when `.git` is present.
- Testing: Vitest with `@effect/vitest` for Effect-aware tests and scoped resources.
- Main process services: Effect `Context.Service` services and `Layer` composition.
- Persistence: Effect SQL with runtime-specific `node:sqlite` and `bun:sqlite` adapters, composed by Core only.
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

## Process Boundaries

When changing Core RPC, Electron IPC, preload, or renderer transport, read **Effect-Neutral Process
Boundaries** in `docs/architecture.md` before editing.

- Carry only schema-encoded, Effect-neutral values across a process seam.
- Core RPC encodes on the server and decodes once in the generated Electron-main client.
- Treat successful generated Core RPC client results as decoded, main-owned domain values. Pass them
  to the IPC controller for encoding; never decode them again in an Electron runtime adapter.
- Electron main encodes renderer responses, preload validates and forwards encoded values, and the
  renderer performs the single domain decode.
- Use the null-backed empty-response schema for void IPC results. Raw `Schema.Void` encodes to
  `undefined`, which is not a JSON-safe IPC payload.
- At the Promise boundary, unwrap expected Effect failures and schema-declared remote RPC defects so
  the IPC error adapter can sanitize their structured value; keep transport and unexpected defects
  opaque.
- Treat `Uint8Array` as a supported structured-clone binary leaf, not as JSON.
- Reject schema mismatches with a stage- and channel-specific transport error. Do not add revivers,
  normalization fallbacks, structural repair, unchecked casts, or compatibility decoding.
- Add a seam-level round-trip regression whenever a contract introduces a transform, runtime class,
  optional value, error type, or binary value.
- For changed IPC flows, verify at least one real Electron bridge round trip through main and preload;
  browser fixtures alone do not exercise process encoding ownership.

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
- Preserve established type evidence end-to-end. Do not widen inferred or parsed values into `unknown`, `any`, `object`, empty-object, or unsafe dictionary intermediates and later assert them back.
- Function parameters must use owner-provided contracts or precise generics rather than the broad `object` type.
- Do not use conditional empty-object spreads to omit properties. Construct the precise object branch or assign an optional property explicitly when omission and `undefined` are equivalent.
- Prefer `import type` for type-only imports and avoid barrel files by default.
- Add JSDoc for exported project-owned functions, classes, interfaces, constants, and types. shadcn-generated primitives are exempt unless modified beyond styling/composition.
- Do not log secrets or raw credentials. Use `Redacted.Redacted` for sensitive config or tokens when introduced.
- Tests should use real seams: Effect layers, SQLite/local DB tests, and fakes at service boundaries rather than module mocks.
