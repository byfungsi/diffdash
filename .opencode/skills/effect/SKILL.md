---
name: effect
description: Use when writing, reviewing, debugging, or testing Effect v4 code in DiffDash.
---

# Effect in DiffDash

DiffDash uses Effect v4 for typed services, schemas, resource lifecycles, and workflows.

## Source of Truth

Never select an Effect API from memory or an Effect v2/v3 example.

1. Inspect DiffDash's exact pinned Effect versions and nearby code.
2. Inspect the installed package types when verifying compatibility with the pinned beta.
3. Search the configured `@effect` reference for current implementations, tests, and examples.
4. Prefer the smallest migration or implementation that preserves DiffDash's existing behavior and architecture.

The pinned package is the compatibility authority. The `@effect` reference follows `main` and may contain changes newer than DiffDash's lockfile.

## Project Conventions

- Use `Context.Service` and explicit `Layer` composition for meaningful runtime dependencies.
- Provide production layers at composition roots instead of hiding provisioning inside business logic.
- Use Effect Schema for domain, protocol, persistence, and recoverable error boundaries.
- Preserve encoded forms when changing schemas used by IPC, SQLite, settings, or atom keys.
- Keep Node, Electron, SQLite, filesystem, and CLI access outside the renderer.
- Keep the Electron preload boundary Promise-based and limited to plain encoded data.
- Use `ManagedRuntime` only at deliberate application boundaries; DiffDash Core owns one managed runtime.
- Model scoped resources with explicit acquisition and finalization, and preserve interruption semantics.
- Use `Effect.fn` for public and non-trivial service operations.
- Use `@effect/vitest`; `it.effect` and `it.live` are scoped automatically in Effect v4.
- Verify filesystem, process, database, runtime, stream, and concurrency behavior through real Layers and deterministic fakes at service boundaries.

## Guardrails

- Do not use `effect-smol`, its source repository, or examples written against it.
- Do not restore removed v3 packages when their v4 APIs live under `effect` or `effect/unstable/*`.
- Do not introduce `any`, non-null assertions, or unchecked casts to bypass migration diagnostics.
- Do not change serialized contracts, failure channels, resource ownership, or runtime boundaries merely to satisfy types.
- Do not copy an API from `@effect` without confirming that DiffDash's pinned beta exports the same API.
