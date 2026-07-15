# Workspace Topology

DiffDash uses one pnpm workspace and Turborepo task graph.

## Ownership

- `packages/*` contains shipped products and reusable runtime packages. Product packages own their
  manifests, runtime dependencies, build configuration, and distributable assets.
- `tools/*` contains maintained private tooling such as deterministic demos, capture hosts, and
  media generation. Tool output is never shipped with a product.
- `scripts/*` contains repository orchestration only. Product runtime code and reusable libraries do
  not live in scripts.

The root manifest owns only repository-wide tooling and convenience commands. Shipped products own
their versions and runtime dependencies under `packages/*`.

Current tooling packages are `@diffdash/demo` for deterministic scenario data/runtime,
`@diffdash/promo-capture` for browser capture and recording, and `@diffdash/promo-media` for
Remotion, audio, storyboard, and verification work. Capture and render ordering is declared in
`turbo.json`; generated media and tool caches remain ignored.

`@diffdash/e2e` owns full-product Playwright projects and deterministic Electron fixtures. Browser
component tests remain with the desktop renderer; full-product development and packaged flows run
through uncached, ABI-safe Turbo tasks.

## Task Policy

Turbo defines shared `build`, `typecheck`, `test`, `lint`, and `dev` tasks. Build outputs are cached;
typecheck and lint have no outputs; development processes are persistent and uncached. Native ABI
rebuilds, packaging, signing, notarization, deployment, and release publication remain explicit
uncached orchestration commands.

Package TypeScript configurations extend `tsconfig.base.json` and add only their environment needs:
Node/Electron packages select Node types and browser packages select DOM libraries and JSX.

## Dependency Policy

Internal dependencies use `workspace:*`. The repository has one `pnpm-lock.yaml`; shared Effect,
React, TypeScript, Vite, Vitest, Playwright, Electron, Wrangler, and lint/tooling versions live in the
default catalog in `pnpm-workspace.yaml`. Runtime dependencies remain in the package that consumes
them.

Root desktop development, unit, browser, Electron E2E, packaged E2E, web deployment, promo, and
release commands are stable convenience wrappers around package-owned scripts.
