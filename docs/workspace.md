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

Shared code stays with the package that owns its contract. Before adding a helper, prefer an existing
platform or dependency primitive; otherwise place it in the closest domain, provider SDK, product,
or infrastructure package. Add a new package only for a cohesive runtime-neutral API needed across
multiple owners. Do not create catch-all utility packages.

Current tooling packages are `@diffdash/demo` for deterministic scenario data/runtime,
`@diffdash/promo-capture` for browser capture and recording, and `@diffdash/promo-media` for
Remotion, audio, storyboard, and verification work. Capture and render ordering is declared in
`turbo.json`; generated media and tool caches remain ignored.

`@diffdash/e2e` owns full-product Playwright projects and deterministic Electron fixtures. Browser
component tests remain with `@diffdash/app`; full-product development and packaged flows run through
uncached, ABI-safe Turbo tasks.

`@diffdash/domain` owns browser-safe schemas, identities, diff decisions, review models, and
walkthrough models through explicit subpath exports. `@diffdash/protocol` owns the renderer-facing
API, canonical IPC channels, request contracts, and serializable transport errors while depending
only on domain, the browser-safe agent-provider manifest schemas, and Effect. It reuses manifest
model, defaults, and runtime-requirement schemas rather than copying their structures. `@diffdash/app`
owns the reusable React application, theme, UI primitives, renderer adapters, and browser tests.
Electron and promotional capture are thin hosts that consume its explicit package exports.

`@diffdash/process` owns one Effect service for captured and line-streaming subprocess execution,
generic executable discovery, and scoped private temporary resources. Node callbacks and process
signals are confined to a private adapter; command interpretation remains with Git and agent
providers. `@diffdash/settings` owns path-parameterized JSON settings and app-state stores while
preserving unknown provider fields. Neither package depends on Electron or concrete providers.

`@diffdash/persistence` is the sole owner of SQLite lifecycle, migrations, durable stores, and
versioned database fixtures. Its layer receives the database path from desktop composition;
workspace source is bundled while the native `better-sqlite3` dependency remains external and
unpacked for Electron.

`@diffdash/git-provider` defines the hosted Git extension contract, multi-instance registry, typed
errors, and reusable provider conformance suite. Concrete providers are leaf packages imported only
by desktop composition; contributor dependency rules are documented in `docs/providers.md`.

`@diffdash/agent-provider` defines open agent identities, manifests, capability-specific probes and
policies, walkthrough and review-thread contracts, scoped MCP access, a provider-neutral registry,
and reusable conformance suites. It is browser-safe and imports no concrete provider. Concrete agent
providers are leaf packages composed once by desktop; contribution rules are in `docs/providers.md`.

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

Pull-request CI uses Turbo's affected package graph for lint, typecheck, unit, and build tasks. It
always runs architecture bundles, browser tests, download-worker tests, and Electron E2E; provider or
protocol changes additionally rerun their dependent desktop, browser, and Electron integration. The
root `check` gate regenerates committed icons and the versioned SQLite fixture and rejects drift
before running format, lint, typecheck, and unit checks. `release:check` extends that deterministic
gate with browser, development and packaged E2E, build, and release-infrastructure verification.
